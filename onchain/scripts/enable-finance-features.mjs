import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

/** 已知公共链创世哈希以及统一使用的最终确认级别。 Known public genesis hashes and the finality used throughout. */
const publicGenesis = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const commitment = 'finalized';

/** 旧账本和金库含判别符的长度，以及计息扩展后的账本长度。 Account sizes including discriminators, plus the indexed pool size. */
const legacyPoolLength = 56;
const indexedPoolLength = 88;
const legacyVaultLength = 137;
const vaultAutoRecallFlag = 1;

/** 使用程序固定种子及父账户公钥推导规范 PDA。 Derive the canonical PDA using a fixed seed and any parent keys. */
function derive(program, seed, ...parents) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), ...parents.map((key) => key.toBuffer())], program)[0];
}

/** 根据构建 IDL 验证账户所有者、判别符和协议固定长度。 Validate the owner, discriminator, and layout size against the build. */
function state(account, program, idl, name, ...lengths) {
  const discriminator = idl.accounts.find((item) => item.name === name)?.discriminator;
  assert.ok(account && !account.executable && account.owner.equals(program)
    && discriminator?.length === 8 && lengths.includes(account.data.length)
    && account.data.subarray(0, 8).equals(Buffer.from(discriminator)), 'Unexpected ' + name + ' account.');
  return account.data;
}

/** 用于尚无状态的规范 PDA。 An unallocated canonical PDA may be absent or system-owned with empty data. */
function isUnallocated(account) {
  return !account || (!account.executable && account.owner.equals(SystemProgram.programId) && account.data.length === 0);
}

/** 验证账户数据中给定偏移处保存的公钥。 Read the public key stored at the given byte offset. */
function keyAt(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

/** 从同一最终确认快照核对管理员、相关账户和可启用状态。 Read the administrator, related accounts, and readiness at one finalized slot. */
async function inspect(connection, feature, program, idl, addresses, minContextSlot) {
  /** 固定地址从 IDL 对应部署的程序推导，读取顺序与下面的解构保持一致。 Addresses are derived for this build and read in the order unpacked below. */
  const selected = feature === 'interest'
    ? [addresses.market, addresses.supply_pool, addresses.borrow_market, addresses.cash_vault]
    : [addresses.vault, addresses.strategy];
  const { context, value: [programAccount, primary, secondary, borrowMarket, cashVault] } =
    await connection.getMultipleAccountsInfoAndContext([program, ...selected], { commitment, minContextSlot });
  assert.ok(programAccount?.executable, 'The program in the build IDL is not deployed on this network.');

  if (feature === 'auto-recall') {
    /** 金库末尾的功能位和已启用策略配置都要有效。 The vault capability bit and initialized strategy must both be valid. */
    const vault = state(primary, program, idl, 'Vault', legacyVaultLength, legacyVaultLength + 1);
    const administrator = keyAt(vault, 8);
    if (vault.length === legacyVaultLength) {
      assert.ok(isUnallocated(secondary), 'The inactive vault has an unexpected strategy account.');
      return { slot: context.slot, administrator, status: 'blocked-strategy-inactive' };
    }
    const strategy = state(secondary, program, idl, 'VaultStrategy', 143);
    assert.ok(keyAt(strategy, 8).equals(addresses.vault), 'The strategy belongs to another vault.');
    const enabled = (vault[legacyVaultLength] & vaultAutoRecallFlag) !== 0;
    return { slot: context.slot, administrator, status: enabled ? 'already-enabled' : 'ready' };
  }

  /** 市场记录管理员和相关代币托管，出借池由首次出借创建。 The market stores its administrator and custody, and the first supply creates the pool. */
  const market = state(primary, program, idl, 'LendingMarket', 169);
  const administrator = keyAt(market, 8);
  assert.ok(keyAt(market, 104).equals(addresses.cash_vault), 'The market cash vault is not canonical.');
  if (isUnallocated(secondary)) return { slot: context.slot, administrator, status: 'blocked-pool-missing' };
  const pool = state(secondary, program, idl, 'SupplyPool', legacyPoolLength, indexedPoolLength);
  assert.ok(keyAt(pool, 8).equals(addresses.market), 'The pool belongs to another market.');
  if (pool.length === indexedPoolLength) {
    assert.ok(pool.readBigInt64LE(legacyPoolLength) > 0n, 'The indexed pool has no valid activation timestamp.');
    return { slot: context.slot, administrator, status: 'already-enabled' };
  }

  /** 从旧借款账本读取未偿本金，并检查链上代币是否覆盖池账本。 Check outstanding legacy principal and custody coverage before activation. */
  let legacyDebt = 0n;
  if (!isUnallocated(borrowMarket)) {
    const debt = state(borrowMarket, program, idl, 'BorrowMarket', 48);
    assert.ok(keyAt(debt, 8).equals(addresses.market), 'The debt ledger belongs to another market.');
    legacyDebt = debt.readBigUInt64LE(40);
  }
  const cash = unpackAccount(addresses.cash_vault, cashVault, TOKEN_PROGRAM_ID);
  assert.ok(cash.owner.equals(addresses.market) && cash.mint.equals(keyAt(market, 40)), 'Unexpected market cash custody.');
  const status = legacyDebt > 0n ? 'blocked-legacy-debt'
    : cash.amount < pool.readBigUInt64LE(40) ? 'blocked-insufficient-custody' : 'ready';
  return { slot: context.slot, administrator, status, legacyDebtBaseUnits: legacyDebt.toString() };
}

/** 读取签名密钥文件并验证格式，错误信息不含密钥内容。 Load and validate the signer file without reporting its contents. */
async function readAdministrator(path) {
  try {
    const bytes = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Array.isArray(bytes) && bytes.length === 64 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new Error('Cannot load the administrator Solana keypair file.');
  }
}

/** 只读检查或显式提交一笔管理员启用交易。 Inspect state or submit one explicit administrator activation. */
async function main() {
  const { values: options } = parseArgs({ options: {
    help: { type: 'boolean' },
    network: { type: 'string' },
    'rpc-url': { type: 'string' },
    feature: { type: 'string' },
    execute: { type: 'boolean' },
    'admin-keypair': { type: 'string' },
  } });
  if (options.help) {
    console.log('node scripts/enable-finance-features.mjs --network <localnet|devnet> --rpc-url <endpoint> --feature <interest|auto-recall> [--execute --admin-keypair <file>]');
    return;
  }
  assert.ok(options.network === 'devnet' || options.network === 'localnet', 'Choose --network localnet or devnet.');
  const feature = options.feature;
  assert.ok(feature === 'interest' || feature === 'auto-recall', 'Choose --feature interest or auto-recall.');
  assert.ok(Boolean(options.execute) === Boolean(options['admin-keypair']), 'Pass --execute and --admin-keypair together.');
  assert.ok(options['rpc-url'], 'Provide --rpc-url.');

  /** 先检查 URL，再用 RPC 核对创世哈希，之后才可读取密钥。 Check the URL and RPC genesis before loading any signing key. */
  const rpc = new URL(options['rpc-url']);
  const devnet = options.network === 'devnet';
  assert.ok(devnet ? rpc.protocol === 'https:'
    : rpc.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname),
  'Devnet requires HTTPS. Localnet requires a loopback HTTP endpoint.');
  const connection = new Connection(rpc.href, commitment);
  const genesis = await connection.getGenesisHash();
  assert.ok(devnet ? genesis === publicGenesis.devnet : !Object.values(publicGenesis).includes(genesis),
    'RPC genesis does not match the requested network.');

  /** 使用 Anchor 构建的指令判别符、程序地址和账户元信息。 Read the discriminator, program ID, and account metadata from the Anchor build. */
  const target = feature === 'interest' ? 'lending' : 'vault';
  const idlPath = new URL('../target/idl/ggboy_' + target + '.json', import.meta.url);
  const idl = JSON.parse(await readFile(idlPath, 'utf8'));
  const program = new PublicKey(idl.address);
  const instruction = idl.instructions.find(({ name }) => name === 'enable_' + feature.replace('-', '_'));
  assert.ok(instruction?.discriminator?.length === 8 && instruction.args.length === 0,
    'Build the upgraded Anchor program to generate its activation instruction.');
  const market = feature === 'interest' ? derive(program, 'lending_market') : null;
  const vault = feature === 'auto-recall' ? derive(program, 'vault') : null;
  const addresses = market ? {
    market, supply_pool: derive(program, 'supply_pool', market), borrow_market: derive(program, 'borrow_market', market),
    cash_vault: derive(program, 'cash_vault', market), system_program: SystemProgram.programId,
  } : { vault, strategy: derive(program, 'strategy', vault) };

  let current = await inspect(connection, feature, program, idl, addresses);
  let signature = null;
  if (options.execute) {
    /** 每次明确执行均比对签名者与账户登记管理员。 Any explicit execution matches the signer to the current account administrator. */
    const admin = await readAdministrator(options['admin-keypair']);
    assert.ok(admin.publicKey.equals(current.administrator), 'The supplied signer is not the on-chain administrator.');
    assert.ok(['ready', 'already-enabled'].includes(current.status), 'Activation unavailable: ' + current.status);
    if (current.status === 'ready') {
      const keys = instruction.accounts.map(({ name, writable, signer }) => {
        const pubkey = name === 'administrator' ? admin.publicKey : addresses[name];
        assert.ok(pubkey, 'Unknown activation instruction account: ' + name);
        return { pubkey, isWritable: writable === true, isSigner: signer === true };
      });
      const lifetime = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({ ...lifetime, feePayer: admin.publicKey });
      transaction.add(new TransactionInstruction({ keys, programId: program, data: Buffer.from(instruction.discriminator) }));
      transaction.sign(admin);
      signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed' });
      try {
        /** 交易最终确认后读回已启用状态，以方便审计及重复运行。 Read back the activated state after finality for auditing and safe repeats. */
        const confirmed = await connection.confirmTransaction({ ...lifetime, signature }, commitment);
        assert.equal(confirmed.value.err, null, 'Activation transaction failed.');
        current = await inspect(connection, feature, program, idl, addresses, confirmed.context.slot);
        assert.ok(current.status === 'already-enabled' && current.administrator.equals(admin.publicKey),
          'Finalized account state does not show the feature enabled for this administrator.');
      } catch (error) {
        throw new Error('Activation transaction ' + signature + ': ' + error.message, { cause: error });
      }
    }
  }

  console.log(JSON.stringify({
    network: options.network, genesis, feature, program: program.toBase58(),
    state: (market ?? vault).toBase58(), administrator: current.administrator.toBase58(),
    status: signature ? 'enabled' : current.status, observedSlot: current.slot,
    legacyDebtBaseUnits: current.legacyDebtBaseUnits, signature,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message || error.name);
  process.exitCode = 1;
}

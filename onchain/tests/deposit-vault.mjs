import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createAccount, createBurnCheckedInstruction, createTransferCheckedInstruction, getAccount,
  getMint, mintTo, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';

/** 验收始终读取已确认的 Localnet 交易和账户。 Verify confirmed Localnet transactions and accounts throughout. */
const commitment = 'confirmed';
/** 结算资产和份额的小数位数，以及一整枚代币对应的最小单位数。 Decimals of both mints and base units per whole token. */
const decimals = 6;
const unitsPerToken = 1_000_000n;
/** 用于区分不同拒绝原因的 Anchor 错误号。 Anchor codes for distinguishing rejection reasons. */
const errors = {
  constraintTokenOwner: 2015,
  invalidDepositAmount: 6003,
  invalidMinimumSharesOut: 6004,
  invalidVaultPricingState: 6005,
  zeroSharesOut: 6007,
  minimumSharesOutNotMet: 6008,
  insufficientDepositBalance: 6009,
};

/**
 * 从 Anchor 命名空间和名称计算八字节判别符。
 * Derive an eight-byte discriminator from its Anchor namespace and name.
 * @param {string} qualifiedName 带命名空间的 Anchor 名称。 Anchor name with its namespace.
 */
function discriminator(qualifiedName) {
  return createHash('sha256').update(qualifiedName).digest().subarray(0, 8);
}

/**
 * 读取属于金库程序的存入事件，忽略其他 CPI 程序中的数据日志。
 * Decode deposit events emitted by the vault program, excluding data logs from other CPI programs.
 * @param {string[]} logs 交易在验证器上的日志。 Transaction logs from the validator.
 * @param {PublicKey} programId 发出存入事件的金库程序。 Vault program expected to emit the event.
 */
function readDepositEvents(logs, programId) {
  /** 当前 CPI 调用栈，用于关联 Program data 与实际发出日志的程序。 CPI execution stack that attributes Program data to its emitting program. */
  const stack = [];
  /** 只保留当前金库程序发出的 VaultDeposit 事件。 Collect only VaultDeposit events emitted by the selected program. */
  const events = [];
  const eventPrefix = discriminator('event:VaultDeposit');
  for (const log of logs) {
    /** 程序进入、退出和数据记录都使用 Solana 的标准日志前缀。 Program entry, exit, and data records use Solana's standard log prefixes. */
    const invocation = /^Program (\S+) invoke \[\d+\]$/.exec(log);
    if (invocation) {
      stack.push(invocation[1]);
      continue;
    }
    if (/^Program \S+ (?:success$|failed:)/.test(log)) {
      stack.pop();
      continue;
    }
    if (stack.at(-1) !== programId.toBase58() || !log.startsWith('Program data: ')) continue;

    /** 事件二进制顺序为判别符、四个公钥及两个 u64。 The event encodes its discriminator, four public keys, and two u64 amounts. */
    const data = Buffer.from(log.slice('Program data: '.length), 'base64');
    if (!data.subarray(0, 8).equals(eventPrefix)) continue;
    assert.equal(data.length, 152);
    events.push({
      vault: new PublicKey(data.subarray(8, 40)).toBase58(),
      investor: new PublicKey(data.subarray(40, 72)).toBase58(),
      assetMint: new PublicKey(data.subarray(72, 104)).toBase58(),
      shareMint: new PublicKey(data.subarray(104, 136)).toBase58(),
      assetsIn: data.readBigUInt64LE(136),
      sharesOut: data.readBigUInt64LE(144),
    });
  }
  return events;
}

/**
 * 使用两个真实的 SPL 钱包仓位验证首存、重新定价、事件和失败回滚。
 * Verify first deposit, repricing, events, and rollback with two real SPL wallet positions.
 */
async function verifyDeposits() {
  /** 三个必需的 fixture 值使用和初始化脚本一致的位置。 Use the same fixture argument positions as the initialization script. */
  const [programAddress, administratorFile, rpcUrl = 'http://127.0.0.1:8899'] = process.argv.slice(2);
  assert.ok(programAddress && administratorFile,
    'Usage: node deposit-vault.mjs <vault-program-id> <admin-keypair-file> [local-rpc-url]');

  // 复用初始化脚本查验部署和本地 RPC，并在新账本中创建空金库。
  // Reuse initialization verification to check the deployment and RPC and to create an empty vault on the new ledger.
  await import('./initialize-vault.mjs');
  /** 已在初始化中验证的 Localnet 连接和升级权限签名人。 Localnet connection and upgrade-authority signer validated during initialization. */
  const connection = new Connection(rpcUrl, commitment);
  const programId = new PublicKey(programAddress);
  const administrator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(administratorFile, 'utf8'))));
  /** Vault 状态 PDA 与其内部记录的三个绑定账户。 Vault state PDA and its three stored account bindings. */
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);
  const initializedVault = await connection.getAccountInfo(vault, commitment);
  assert.ok(initializedVault?.owner.equals(programId));
  const assetMint = new PublicKey(initializedVault.data.subarray(40, 72));
  const cashVault = new PublicKey(initializedVault.data.subarray(72, 104));
  const shareMint = new PublicKey(initializedVault.data.subarray(104, 136));

  /**
   * 建立有 200 枚结算资产及空份额账户的独立测试投资者。
   * Create an independent test investor holding 200 settlement tokens and an empty share account.
   */
  async function createInvestor() {
    /** 投资者签名人和互相独立的经典 SPL 账户。 Investor signer and its separate classic SPL accounts. */
    const signer = Keypair.generate();
    const asset = await createAccount(connection, administrator, assetMint, signer.publicKey, Keypair.generate());
    const shares = await createAccount(connection, administrator, shareMint, signer.publicKey, Keypair.generate());
    await mintTo(connection, administrator, assetMint, asset, administrator, 200n * unitsPerToken);
    await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
      fromPubkey: administrator.publicKey,
      toPubkey: signer.publicKey,
      lamports: LAMPORTS_PER_SOL,
    })), [administrator], { commitment });
    return { signer, asset, shares };
  }

  /** 分别执行首存与后续存入的两个独立钱包。 Separate wallets for the first and subsequent deposits. */
  const first = await createInvestor();
  const second = await createInvestor();
  /** 拒绝用例比较整组原始账户，包括余额、供给和配置。 Rejection cases compare the complete account records, including balances, supply, and configuration. */
  const watchedAccounts = [vault, cashVault, assetMint, shareMint, first.asset, first.shares, second.asset, second.shares];

  /**
   * 编码并发送存入指令，读取验证器的实际执行结果及日志。
   * Encode and send the deposit instruction and read actual execution status and logs from the validator.
   * @param {object} investor 投资者签名人及其输入、份额账户，可在拒绝用例替换账户。 Investor signer and its asset/share accounts, replaceable in rejection cases.
   * @param {bigint} assetsIn 输入结算金额的最小单位数量。 Settlement amount in base units.
   * @param {bigint} minimumSharesOut 最少可接受份额的最小单位数量。 Minimum acceptable shares in base units.
   */
  async function deposit(investor, assetsIn, minimumSharesOut) {
    /** 八字节判别符加两个小端 u64 参数。 Eight-byte discriminator followed by two little-endian u64 arguments. */
    const data = Buffer.alloc(24);
    discriminator('global:deposit').copy(data);
    data.writeBigUInt64LE(assetsIn, 8);
    data.writeBigUInt64LE(minimumSharesOut, 16);

    /** 管理员承担本地测试手续费，使投资者账户按指令 ABI 保持只读签名人。 The admin pays test fees, so the investor remains a read-only signer as required by the instruction ABI. */
    const lifetime = await connection.getLatestBlockhash(commitment);
    const transaction = new Transaction({ ...lifetime, feePayer: administrator.publicKey }).add(new TransactionInstruction({
      programId,
      data,
      keys: [
        { pubkey: investor.signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: assetMint, isSigner: false, isWritable: false },
        { pubkey: cashVault, isSigner: false, isWritable: true },
        { pubkey: shareMint, isSigner: false, isWritable: true },
        { pubkey: investor.asset, isSigner: false, isWritable: true },
        { pubkey: investor.shares, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    }));
    transaction.sign(administrator, investor.signer);
    // 负例直接在验证器执行，以便校验真实链上错误和回滚。
    // Execute failures on the validator to verify actual on-chain errors and rollback.
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const status = await connection.confirmTransaction({ signature, ...lifetime }, commitment);
    return { signature, error: status.value.err };
  }

  /**
   * 检查成功存入以及日志中的实际结算、铸造数值。
   * Require a successful deposit and match its logged settlement and minted amounts.
   * @param {object} investor 成功发起存入的钱包及代币账户。 Wallet and accounts that successfully deposit.
   * @param {bigint} assetsIn 预期扣除的结算金额最小单位数。 Expected debit in settlement base units.
   * @param {bigint} sharesOut 预期铸造的份额最小单位数。 Expected mint amount in share base units.
   */
  async function assertAccepted(investor, assetsIn, sharesOut) {
    /** 成功交易签名和链上日志。 Successful transaction signature and on-chain logs. */
    const result = await deposit(investor, assetsIn, sharesOut);
    assert.equal(result.error, null, `Deposit failed (${result.signature}): ${JSON.stringify(result.error)}.`);
    const transaction = await connection.getTransaction(result.signature, { commitment, maxSupportedTransactionVersion: 0 });
    assert.ok(transaction?.meta?.logMessages, `Missing chain logs (${result.signature}).`);
    assert.deepEqual(readDepositEvents(transaction.meta.logMessages, programId), [{
      vault: vault.toBase58(),
      investor: investor.signer.publicKey.toBase58(),
      assetMint: assetMint.toBase58(),
      shareMint: shareMint.toBase58(),
      assetsIn,
      sharesOut,
    }]);
  }

  /**
   * 确认拒绝原因及所有相关账户无变化。
   * Confirm the rejection reason and that all relevant account records remain unchanged.
   * @param {object} investor 本次测试签名人与代币账户。 Test signer and token accounts for the case.
   * @param {bigint} assetsIn 输入的结算金额最小单位数。 Input settlement base units.
   * @param {bigint} minimumSharesOut 最低份额最小单位数。 Minimum output share base units.
   * @param {number} errorCode 预期的 Anchor 链上错误号。 Expected Anchor on-chain error code.
   */
  async function assertRejected(investor, assetsIn, minimumSharesOut, errorCode) {
    /** 失败前读取任一指令可能读取或修改的资金及份额账户。 Read the fund and share accounts the instruction may touch before the failed transaction. */
    const before = await connection.getMultipleAccountsInfo(watchedAccounts, commitment);
    const result = await deposit(investor, assetsIn, minimumSharesOut);
    assert.deepEqual(result.error, { InstructionError: [0, { Custom: errorCode }] }, `Unexpected error (${result.signature}).`);
    assert.deepEqual(await connection.getMultipleAccountsInfo(watchedAccounts, commitment), before);
  }

  /**
   * 汇总托管、份额 Mint 和两个钱包的已确认最小单位余额。
   * Read confirmed base-unit custody, share supply, and both wallets' balances.
   */
  async function readBalances() {
    /** 链上五个代币账户余额和份额 Mint 总供给，各值都是 bigint。 Five token balances and share mint supply, all bigint. */
    const balances = await Promise.all([cashVault, first.asset, first.shares, second.asset, second.shares]
      .map((address) => getAccount(connection, address, commitment)));
    const supply = (await getMint(connection, shareMint, commitment)).supply;
    return [...balances.map(({ amount }) => amount), supply];
  }

  /** 首存以 1:1 比率铸造份额，两个资产和份额均为六位小数。 First deposit mints one-to-one at six decimals. */
  const hundred = 100n * unitsPerToken;
  await assertAccepted(first, hundred, hundred);
  assert.deepEqual(await readBalances(), [hundred, hundred, hundred, 2n * hundred, 0n, hundred]);

  /** 钱包直接转入 20 枚结算资产，只增加金库现金并改变后续报价。 A direct 20-token contribution only raises cash and changes pricing for later deposits. */
  const donation = 20n * unitsPerToken;
  await sendAndConfirmTransaction(connection, new Transaction().add(createTransferCheckedInstruction(
    first.asset, assetMint, cashVault, first.signer.publicKey, donation, decimals,
  )), [first.signer], { commitment });
  assert.deepEqual(await readBalances(), [hundred + donation, hundred - donation, hundred, 2n * hundred, 0n, hundred]);

  /** 第二笔的预期值取自交易前 100 份 / 120 现金，向下保留到一份额最小单位。 Calculate the second deposit from 100 pre-transaction shares and 120 cash, rounded down to the share base unit. */
  const secondShares = 83_333_333n;
  await assertRejected(second, hundred, secondShares + 1n, errors.minimumSharesOutNotMet);
  await assertRejected(second, 0n, 1n, errors.invalidDepositAmount);
  await assertRejected(second, hundred, 0n, errors.invalidMinimumSharesOut);
  await assertRejected(second, 1n, 1n, errors.zeroSharesOut);
  await assertRejected(second, 2n * hundred + 1n, 1n, errors.insufficientDepositBalance);
  await assertRejected({ ...second, asset: first.asset }, hundred, 1n, errors.constraintTokenOwner);
  await assertRejected({ ...second, shares: first.shares }, hundred, 1n, errors.constraintTokenOwner);

  await assertAccepted(second, hundred, secondShares);
  assert.deepEqual(await readBalances(), [2n * hundred + donation, hundred - donation, hundred, hundred, secondShares, hundred + secondShares]);

  // 两钱包主动销毁全部测试份额后，验证现金为正且供给为零时拒绝新存入。
  // Burn both wallets' test shares and verify that deposits are rejected with positive cash and zero supply.
  for (const [investor, shares] of [[first, hundred], [second, secondShares]]) {
    await sendAndConfirmTransaction(connection, new Transaction().add(createBurnCheckedInstruction(
      investor.shares, shareMint, investor.signer.publicKey, shares, decimals,
    )), [investor.signer], { commitment });
  }
  assert.deepEqual(await readBalances(), [2n * hundred + donation, hundred - donation, 0n, hundred, 0n, 0n]);
  await assertRejected(second, hundred, 1n, errors.invalidVaultPricingState);

  console.log('Vault deposits verified on Localnet: first and repriced deposits, exact events, and eight rollback cases.');
}

await verifyDeposits();

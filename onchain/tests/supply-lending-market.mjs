import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createAccount, createMint, createTransferCheckedInstruction, freezeAccount, getAccount,
  getMint, mintTo, thawAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';

/** 使用验证器已确认的账户和执行结果。 Use account and transaction results confirmed by the validator. */
const commitment = 'confirmed';
/** 借款资产和出借份额均为六位小数。 Both the debt asset and supply shares use six decimals. */
const decimals = 6;
const unitsPerToken = 1_000_000n;
/** 判别符、公钥和 u64 数量的布局长度。 Layout sizes for discriminators, public keys, and u64 amounts. */
const discriminatorSize = 8;
const publicKeySize = 32;
const amountSize = 8;

/**
 * 从 Anchor 带命名空间的名称计算八字节判别符。
 * Derive an eight-byte discriminator from a namespaced Anchor name.
 * @param {string} name 带命名空间的名称。 Namespaced Anchor name.
 */
function discriminator(name) {
  return createHash('sha256').update(name).digest().subarray(0, discriminatorSize);
}

/**
 * 解码 Anchor 布局中的指定公钥。
 * Decode an indexed public key from the Anchor layout.
 * @param {Buffer} data 判别符后紧跟公钥的二进制记录。 Record with keys immediately after its discriminator.
 * @param {number} index 从零开始的公钥序号。 Zero-based public key index.
 */
function readKey(data, index) {
  /** 公钥偏移由判别符和之前的公钥个数决定。 The discriminator and preceding keys determine the offset. */
  const offset = discriminatorSize + publicKeySize * index;
  return new PublicKey(data.subarray(offset, offset + publicKeySize)).toBase58();
}

/**
 * 核对程序账户的归属、判别符和记录布局。
 * Verify a program account's owner, discriminator, and layout.
 * @param {object} account Localnet 返回的程序账户。 Program account returned by Localnet.
 * @param {PublicKey} programId 借贷程序的公钥。 Lending program public key.
 * @param {string} name Anchor 账户名称。 Anchor account name.
 * @param {number} length 含判别符的账户长度。 Expected account length including the discriminator.
 */
function readState(account, programId, name, length) {
  assert.ok(account?.owner.equals(programId) && !account.executable, `Invalid ${name} program owner.`);
  assert.equal(account.data.length, length);
  assert.deepEqual(account.data.subarray(0, discriminatorSize), discriminator(`account:${name}`));
  return account.data;
}

/**
 * 解码只由借贷程序发出的成交事件，所有数字均保留最小单位。
 * Decode deposit events from the lending program, retaining exact base units.
 * @param {string[]} logs 交易原始日志。 Raw transaction logs.
 * @param {PublicKey} programId 发出事件的程序公钥。 Emitting program public key.
 */
function readSupplyEvents(logs, programId) {
  /** 调用栈用于排除其他 CPI 程序的同名事件。 Invocation stack excludes events from other CPI programs. */
  const stack = [];
  const events = [];
  const prefix = discriminator('event:LendingSupply');
  const assetsOffset = discriminatorSize + 3 * publicKeySize;
  for (const log of logs) {
    /** 跟踪 Solana 的调用进入与退出记录。 Follow Solana runtime invocation entry and exit records. */
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
    /** 事件 ABI 包含三个公钥以及两个小端数量。 The event ABI contains three keys and two little-endian amounts. */
    const data = Buffer.from(log.slice('Program data: '.length), 'base64');
    if (!data.subarray(0, discriminatorSize).equals(prefix)) continue;
    assert.equal(data.length, assetsOffset + 2 * amountSize);
    events.push({
      market: readKey(data, 0),
      supplier: readKey(data, 1),
      debtMint: readKey(data, 2),
      assetsIn: data.readBigUInt64LE(assetsOffset),
      sharesOut: data.readBigUInt64LE(assetsOffset + amountSize),
    });
  }
  return events;
}

/** 在已经初始化并原位升级的本地市场上验证出借行为。 Verify supply after an initialized Localnet market is upgraded in place. */
async function verifySupply() {
  /** 命令参数指定已升级程序、管理员文件、旧市场的借款 Mint 和本机 RPC。 CLI inputs provide the upgraded program, admin file, old market's debt mint, and local RPC. */
  const [programAddress, administratorFile, mintAddress, rpcUrl = 'http://127.0.0.1:8899'] = process.argv.slice(2);
  assert.ok(programAddress && administratorFile && mintAddress,
    'Usage: node supply-lending-market.mjs <program-id> <admin-file> <debt-mint> [local-rpc-url]');
  /** 仅允许向本机 HTTP 验证器发送测试交易。 Only submit test transactions to a loopback HTTP validator. */
  const endpoint = new URL(rpcUrl);
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Use an HTTP Localnet endpoint on localhost.');

  /** 连接、签名人与旧市场的 Mint 和托管公钥，以及新设的出借记账 PDA。 Connection, signer, old market mint and custodies, and new supply ledger PDA. */
  const connection = new Connection(endpoint.href, commitment);
  const programId = new PublicKey(programAddress);
  const administrator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(administratorFile, 'utf8'))));
  const debtMint = new PublicKey(mintAddress);
  const [market] = PublicKey.findProgramAddressSync([Buffer.from('lending_market')], programId);
  const [cashVault] = PublicKey.findProgramAddressSync([Buffer.from('cash_vault'), market.toBuffer()], programId);
  const [collateralVault] = PublicKey.findProgramAddressSync([Buffer.from('collateral_vault'), market.toBuffer()], programId);
  const [supplyPool] = PublicKey.findProgramAddressSync([Buffer.from('supply_pool'), market.toBuffer()], programId);

  /** 保留旧市场和抵押托管的初始字节，用于验证升级兼容性。 Capture bytes of the old market and collateral custody for compatibility checks. */
  const [marketBefore, collateralBefore, poolBefore] = await connection.getMultipleAccountsInfo(
    [market, collateralVault, supplyPool], commitment,
  );
  const marketData = readState(marketBefore, programId, 'LendingMarket', discriminatorSize + 5 * publicKeySize + 1);
  assert.equal(readKey(marketData, 1), debtMint.toBase58());
  assert.equal(readKey(marketData, 3), cashVault.toBase58());
  assert.equal(readKey(marketData, 4), collateralVault.toBase58());
  assert.ok(collateralBefore?.owner.equals(TOKEN_PROGRAM_ID));
  assert.equal(poolBefore, null, 'Use a fresh market with no supply ledger.');
  assert.equal((await getAccount(connection, cashVault, commitment)).amount, 0n, 'The test requires empty custody.');

  /** 测试管理员同时持有铸造和冻结权限，用于发放资产和触发 SPL CPI 回滚。 The test admin can mint and freeze to fund sources and force an SPL CPI rollback. */
  const mint = await getMint(connection, debtMint, commitment);
  assert.equal(mint.decimals, decimals);
  assert.ok(mint.mintAuthority?.equals(administrator.publicKey) && mint.freezeAuthority?.equals(administrator.publicKey),
    'Use a Localnet debt mint whose mint and freeze authorities are the test admin.');
  /** 使用不同序号生成各自的交易签名，价格单位为 microLamports。 Distinguish test signatures by using a sequence of compute-unit prices in microLamports. */
  let transactionNumber = 0;

  /**
   * 提交实际 Localnet 交易，由管理员支付交易手续费以单独核对租金回滚。
   * Submit a real Localnet transaction with the administrator paying fees, so account-rent rollback can be checked independently.
   * @param {TransactionInstruction} instruction 验收交易的业务指令。 Business instruction for the test transaction.
   * @param {...Keypair} signers 管理员以外的签名人。 Signers other than the administrator.
   */
  async function submit(instruction, ...signers) {
    /** 测试复用同一交易业务输入时，用计算预算价格保证签名不同。 A distinct compute price prevents repeated business inputs from reusing a prior signature. */
    const lifetime = await connection.getLatestBlockhash(commitment);
    const transaction = new Transaction({ ...lifetime, feePayer: administrator.publicKey }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: transactionNumber++ }),
      instruction,
    );
    transaction.sign(administrator, ...signers);
    // 负例也交给验证器执行，以便观察账户创建和回滚。
    // Execute negative cases on the validator to observe account creation and rollback.
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const status = await connection.confirmTransaction({ signature, ...lifetime }, commitment);
    return { signature, error: status.value.err };
  }

  /** 钱包初始测试余额与首笔出借金额，均以最小单位计。 Initial wallet funding and first deposit in base units. */
  const initialAssets = 300n * unitsPerToken;
  const hundred = 100n * unitsPerToken;

  /** 创建独立的测试钱包、来源账户与仓位 PDA。 Create a separate test wallet, source, and position PDA. */
  async function createSupplier() {
    /** 资金来源账户归出借者签名人，未来仓位由该签名人及所选市场派生。 The supplier owns the source, and the signer and market determine its position PDA. */
    const signer = Keypair.generate();
    const source = await createAccount(connection, administrator, debtMint, signer.publicKey, Keypair.generate());
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from('supply_position'), market.toBuffer(), signer.publicKey.toBuffer()], programId,
    );
    await mintTo(connection, administrator, debtMint, source, administrator, initialAssets);
    /** 发放本地测试 SOL 以支付新建 PDA 的免租金余额。 Fund Localnet SOL for rent-exempt PDA balances. */
    const funded = await submit(SystemProgram.transfer({
      fromPubkey: administrator.publicKey, toPubkey: signer.publicKey, lamports: LAMPORTS_PER_SOL,
    }));
    assert.equal(funded.error, null);
    return { signer, source, position };
  }

  /** 两个测试出借人，以及持有正确出借人签名但 Mint 错误的来源账户。 Two test suppliers and a source with the right signer but wrong mint. */
  const alice = await createSupplier();
  const bob = await createSupplier();
  const wrongMint = await createMint(connection, administrator, administrator.publicKey, null, decimals);
  const wrongSource = await createAccount(connection, administrator, wrongMint, bob.signer.publicKey, Keypair.generate());
  await mintTo(connection, administrator, wrongMint, wrongSource, administrator, initialAssets);

  // 首存前直接赠送一最小单位，确认实际现金变化不会创建池总账或改变份额定价。
  // Donate one base unit before the first deposit to confirm extra cash creates no ledger and does not affect share pricing.
  const donation = 1n;
  const donated = await submit(createTransferCheckedInstruction(
    alice.source, debtMint, cashVault, alice.signer.publicKey, donation, decimals,
  ), alice.signer);
  assert.equal(donated.error, null);
  assert.equal((await getAccount(connection, cashVault, commitment)).amount, donation);
  assert.equal(await connection.getAccountInfo(supplyPool, commitment), null);

  /** 追踪旧市场、全部可变业务账户和出借者的 SOL 租金余额。 Watch the original market, all mutable business accounts, and the suppliers' rent-paying SOL wallets. */
  const watched = [
    market, collateralVault, cashVault, debtMint, supplyPool, alice.position, bob.position,
    alice.signer.publicKey, bob.signer.publicKey, alice.source, bob.source, wrongSource,
  ];

  /**
   * 按独立验证的 ABI 组成出借指令。
   * Construct the supply instruction using the independently verified ABI.
   * @param {object} supplier 出借钱包及账户，可为拒绝用例替换指定账户。 Supplier and accounts, with substitutions allowed for negative cases.
   * @param {bigint} assets 输入资产最小单位数。 Input asset base units.
   * @param {bigint} minimum 可接受的最少份额最小单位数。 Minimum accepted share base units.
   */
  function supply(supplier, assets, minimum) {
    /** 业务参数为判别符之后的两个小端 u64。 Arguments are two little-endian u64 values after the discriminator. */
    const data = Buffer.alloc(discriminatorSize + 2 * amountSize);
    discriminator('global:supply').copy(data);
    data.writeBigUInt64LE(assets, discriminatorSize);
    data.writeBigUInt64LE(minimum, discriminatorSize + amountSize);
    return submit(new TransactionInstruction({
      programId,
      data,
      keys: [
        { pubkey: supplier.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: debtMint, isSigner: false, isWritable: false },
        { pubkey: cashVault, isSigner: false, isWritable: true },
        { pubkey: supplier.source, isSigner: false, isWritable: true },
        { pubkey: supplyPool, isSigner: false, isWritable: true },
        { pubkey: supplier.position, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), supplier.signer);
  }

  /**
   * 获取验证器记录的实际 CPI 与事件日志。
   * Read transaction logs recorded by the validator for CPIs and events.
   * @param {string} signature 交易签名。 Transaction signature.
   */
  async function logsFor(signature) {
    /** 必须从已确认交易获取日志。 Require logs on the confirmed transaction. */
    const transaction = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
    assert.ok(transaction?.meta?.logMessages, `Missing logs (${signature}).`);
    return transaction.meta.logMessages;
  }

  /**
   * 验证预期失败及全部追踪账户回滚。
   * Verify an expected failure and rollback of all watched accounts.
   * @param {object} supplier 出借钱包与测试账户替换。 Supplier and negative-case account substitutions.
   * @param {bigint} assets 输入资产最小单位数。 Input asset base units.
   * @param {bigint} minimum 最低份额最小单位数。 Minimum share base units.
   * @param {RegExp} reason 预期执行错误的日志特征。 Expected execution error log pattern.
   */
  async function assertRejected(supplier, assets, minimum, reason) {
    /** 原始账户快照能同时核对权限、代币余额、份额及租金。 Raw account snapshots simultaneously verify authority, token amounts, share amounts, and rent. */
    const before = await connection.getMultipleAccountsInfo(watched, commitment);
    const result = await supply(supplier, assets, minimum);
    assert.equal(result.error?.InstructionError?.[0], 1, `Expected supply to fail after compute budget (${result.signature}).`);
    const logs = await logsFor(result.signature);
    assert.match(logs.join('\n'), reason, `Unexpected failure (${result.signature}).`);
    assert.deepEqual(readSupplyEvents(logs, programId), []);
    assert.deepEqual(await connection.getMultipleAccountsInfo(watched, commitment), before);
    return result.signature;
  }

  /**
   * 验证出借成功，并从实际事件核对入池金额和份额。
   * Verify successful supply and compare deposited assets and shares against the actual event.
   * @param {object} supplier 出借测试钱包与账户。 Test supplier and its accounts.
   * @param {bigint} assets 资产最小单位数，在当前阶段对应等额份额。 Asset base units, corresponding to the same share amount in this phase.
   */
  async function assertAccepted(supplier, assets) {
    /** 最低份额取同等数量，非 1 比 1 的成交即无法通过本用例。 Use the same amount as the share minimum to require 1:1 settlement. */
    const result = await supply(supplier, assets, assets);
    assert.equal(result.error, null, `Supply failed (${result.signature}): ${JSON.stringify(result.error)}.`);
    assert.deepEqual(readSupplyEvents(await logsFor(result.signature), programId), [{
      market: market.toBase58(), supplier: supplier.signer.publicKey.toBase58(), debtMint: debtMint.toBase58(),
      assetsIn: assets, sharesOut: assets,
    }]);
    return result.signature;
  }

  // 冻结来源使首次供应在 SPL 转账 CPI 失败，验证两个 PDA 及其租金回滚。
  // Freeze the source so the first supply fails in SPL transfer CPI and rolls back both PDAs and their rent.
  await freezeAccount(connection, administrator, alice.source, debtMint, administrator);
  const frozenSignature = await assertRejected(alice, hundred, hundred, /Account is frozen|custom program error: 0x11/i);
  /** 解析实际内部指令，核对两个账户先创建，随后才尝试冻结代币的转账。 Parse actual inner instructions to verify both account creations precede the frozen transfer attempt. */
  const frozenTransaction = await connection.getParsedTransaction(frozenSignature, {
    commitment, maxSupportedTransactionVersion: 0,
  });
  assert.deepEqual(frozenTransaction?.meta?.err, { InstructionError: [1, { Custom: 17 }] });
  const inner = frozenTransaction.meta.innerInstructions?.find(({ index }) => index === 1)?.instructions;
  assert.deepEqual(inner?.map(({ programId: owner, parsed }) => [owner.toBase58(), parsed?.type]), [
    [SystemProgram.programId.toBase58(), 'createAccount'],
    [SystemProgram.programId.toBase58(), 'createAccount'],
    [TOKEN_PROGRAM_ID.toBase58(), 'transferChecked'],
  ]);
  assert.equal(inner[0].parsed.info.newAccount, supplyPool.toBase58());
  assert.equal(inner[1].parsed.info.newAccount, alice.position.toBase58());
  assert.equal(inner[2].parsed.info.source, alice.source.toBase58());
  assert.equal(inner[2].parsed.info.destination, cashVault.toBase58());
  assert.equal(await connection.getAccountInfo(supplyPool, commitment), null);
  assert.equal(await connection.getAccountInfo(alice.position, commitment), null);
  await thawAccount(connection, administrator, alice.source, debtMint, administrator);

  /** 正常首笔到账、六位尾数和追加存入示例。 Successful first deposit, sixth-decimal deposit, and later top-up. */
  const firstSignature = await assertAccepted(alice, hundred);
  await assertRejected(bob, 0n, 1n, /Error Code: InvalidSupplyAmount\b/);
  await assertRejected(bob, hundred, 0n, /Error Code: InvalidMinimumSupplyShares\b/);
  await assertRejected(bob, hundred, hundred + 1n, /Error Code: MinimumSupplySharesNotMet\b/);
  await assertRejected(bob, initialAssets + 1n, 1n, /Error Code: InsufficientSupplyBalance\b/);
  await assertRejected({ ...bob, source: alice.source }, hundred, 1n, /Error Code: ConstraintTokenOwner\b/);
  await assertRejected({ ...bob, source: wrongSource }, hundred, 1n, /Error Code: ConstraintTokenMint\b/);
  await assertRejected({ ...bob, position: alice.position }, hundred, 1n, /Error Code: ConstraintSeeds\b/);

  /** 通过独立钱包与重复出借验证精度及原位更新。 Verify precision and in-place updates using a second wallet and a repeated supply. */
  const bobAssets = hundred + 1n;
  const aliceMore = 25n * unitsPerToken;
  const bobSignature = await assertAccepted(bob, bobAssets);
  const repeatSignature = await assertAccepted(alice, aliceMore);

  /** 确认新账户数据匹配想定，并且旧市场状态布局和抵押托管完全保留。 Verify new state matches expectations while the existing market and collateral custody remain intact. */
  const [poolAccount, aliceAccount, bobAccount, marketAfter, collateralAfter] = await connection.getMultipleAccountsInfo(
    [supplyPool, alice.position, bob.position, market, collateralVault], commitment,
  );
  const poolAmountOffset = discriminatorSize + publicKeySize;
  const positionAmountOffset = discriminatorSize + 2 * publicKeySize;
  const pool = readState(poolAccount, programId, 'SupplyPool', poolAmountOffset + 2 * amountSize);
  const alicePosition = readState(aliceAccount, programId, 'SupplyPosition', positionAmountOffset + amountSize);
  const bobPosition = readState(bobAccount, programId, 'SupplyPosition', positionAmountOffset + amountSize);
  const total = hundred + aliceMore + bobAssets;
  assert.equal(readKey(pool, 0), market.toBase58());
  assert.equal(pool.readBigUInt64LE(poolAmountOffset), total);
  assert.equal(pool.readBigUInt64LE(poolAmountOffset + amountSize), total);
  assert.equal(readKey(alicePosition, 0), market.toBase58());
  assert.equal(readKey(alicePosition, 1), alice.signer.publicKey.toBase58());
  assert.equal(alicePosition.readBigUInt64LE(positionAmountOffset), hundred + aliceMore);
  assert.equal(readKey(bobPosition, 0), market.toBase58());
  assert.equal(readKey(bobPosition, 1), bob.signer.publicKey.toBase58());
  assert.equal(bobPosition.readBigUInt64LE(positionAmountOffset), bobAssets);
  assert.deepEqual(marketAfter, marketBefore);
  assert.deepEqual(collateralAfter, collateralBefore);

  /** 账外赠送只计入实际现金，钱包只扣除测试确认的资产流出。 The unsolicited transfer affects physical cash only, and wallet sources reflect only confirmed outflows. */
  const [cash, aliceSource, bobSource] = await Promise.all([cashVault, alice.source, bob.source]
    .map((address) => getAccount(connection, address, commitment)));
  assert.equal(cash.amount, total + donation);
  assert.equal(aliceSource.amount, initialAssets - hundred - aliceMore - donation);
  assert.equal(bobSource.amount, initialAssets - bobAssets);

  console.log(`Localnet supply verified. First=${firstSignature}, second=${bobSignature}, repeat=${repeatSignature}.`);
}

await verifySupply();

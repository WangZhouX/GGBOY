import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createAccount, createMint, createTransferCheckedInstruction, freezeAccount, getAccount,
  getMint, mintTo, thawAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';

/** 验收使用已确认的链上状态。 Read confirmed validator state throughout the verification. */
const commitment = 'confirmed';
/** 结算资产与份额均为六位小数，一个完整代币为一百万最小单位。 Both mints have six decimals with one million base units per whole token. */
const decimals = 6;
const unitsPerToken = 1_000_000n;
/** ProgramData 所属的 Solana 加载器。 Solana loader that owns the ProgramData account. */
const upgradeableLoader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/** 用例期望的 Anchor 账户错误、金库业务错误及 SPL Token CPI 错误。 Anchor account, vault business, and SPL Token CPI errors expected by the test. */
const errors = {
  constraintTokenOwner: 2015,
  invalidRedeemAmount: 6010,
  invalidMinimumAssetsOut: 6011,
  insufficientRedeemShares: 6012,
  minimumAssetsOutNotMet: 6016,
  tokenAccountFrozen: 17,
};

/**
 * 得到 Anchor 指令或事件的八字节判别符。
 * Derive the eight-byte discriminator of an Anchor instruction or event.
 * @param {string} name 带命名空间的 Anchor 名称。 Anchor name with its namespace.
 */
function discriminator(name) {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}

/**
 * 只解码金库程序实际发出的 VaultRedeem 事件。
 * Decode only VaultRedeem events emitted by the vault program.
 * @param {string[]} logs 已确认交易的日志列表。 Logs from a confirmed transaction.
 * @param {PublicKey} programId 发出事件的金库程序地址。 Address of the vault program that emits the event.
 */
function readRedeemEvents(logs, programId) {
  /** CPI 调用栈用于确认 Program data 的来源，事件列表按日志顺序排列。 Track the emitting program through the CPI stack and keep events in log order. */
  const stack = [];
  const events = [];
  const eventPrefix = discriminator('event:VaultRedeem');
  for (const log of logs) {
    /** 进入被调用程序时保存其地址，退出时退回上一级。 Push the callee on entry and pop it on return. */
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
    /** 事件布局由判别符、四个公钥和两个小端 u64 组成。 The event layout contains its discriminator, four public keys, and two little-endian u64s. */
    const data = Buffer.from(log.slice('Program data: '.length), 'base64');
    if (!data.subarray(0, 8).equals(eventPrefix)) continue;
    assert.equal(data.length, 152);
    events.push({
      vault: new PublicKey(data.subarray(8, 40)).toBase58(),
      investor: new PublicKey(data.subarray(40, 72)).toBase58(),
      assetMint: new PublicKey(data.subarray(72, 104)).toBase58(),
      shareMint: new PublicKey(data.subarray(104, 136)).toBase58(),
      sharesIn: data.readBigUInt64LE(136),
      assetsOut: data.readBigUInt64LE(144),
    });
  }
  return events;
}

/** 在同一新金库上检查部分赎回、全部赎回和失败后的原子回滚。 Verify partial redemption, full redemption, and atomic rollback in one fresh vault. */
async function verifyRedemptions() {
  /** 命令行给出金库程序、测试管理员文件和本机 RPC。 Arguments supply the vault program, test administrator file, and local RPC. */
  const [programAddress, administratorFile, rpcUrl = 'http://127.0.0.1:8899'] = process.argv.slice(2);
  assert.ok(programAddress && administratorFile,
    'Usage: node redeem-vault.mjs <vault-program-id> <admin-keypair-file> [local-rpc-url]');
  /** 在读取签名密钥或提交测试交易前限定为本机 Localnet。 Require local HTTP before reading a signing key or submitting test transactions. */
  const endpoint = new URL(rpcUrl);
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Use an HTTP Localnet endpoint on localhost.');
  const connection = new Connection(endpoint.href, commitment);
  /** 已部署的金库和拥有升级权限的本地测试管理员。 Deployed vault and local test administrator holding upgrade authority. */
  const programId = new PublicKey(programAddress);
  const administrator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(administratorFile, 'utf8'))));
  const deployed = await connection.getAccountInfo(programId, commitment);
  assert.ok(deployed?.executable && deployed.owner.equals(upgradeableLoader), 'Deploy the vault as an upgradeable Localnet program first.');
  /** 初始化和资金指令用到的三个金库 PDA 与升级数据。 Three vault PDAs and upgrade data used during initialization and settlement. */
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);
  const [cashVault] = PublicKey.findProgramAddressSync([Buffer.from('cash_vault'), vault.toBuffer()], programId);
  const [shareMint] = PublicKey.findProgramAddressSync([Buffer.from('share_mint'), vault.toBuffer()], programId);
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], upgradeableLoader);
  assert.deepEqual(await connection.getMultipleAccountsInfo([vault, cashVault, shareMint], commitment), [null, null, null]);

  /** 本地结算 Mint 的冻结权限用于使赎回的第二步 CPI 确实失败。 The local settlement mint's freeze authority forces the second redemption CPI to fail. */
  const assetMint = await createMint(connection, administrator, administrator.publicKey, administrator.publicKey, decimals);

  /**
   * 签名并提交交易，在真实执行后读取验证器确认状态。
   * Sign and submit a transaction and read its actual confirmed execution result.
   * @param {TransactionInstruction[]} instructions 本次交易的完整指令。 All instructions in this transaction.
   * @param {...Keypair} signers 手续费付款人以外的签名人。 Signers other than the fee payer.
   */
  async function submit(instructions, ...signers) {
    /** 管理员支付手续费，出资人仍可作为只读签名人被测试。 The administrator pays fees so the ABI can be tested with a read-only investor signer. */
    const lifetime = await connection.getLatestBlockhash(commitment);
    const transaction = new Transaction({ ...lifetime, feePayer: administrator.publicKey }).add(...instructions);
    transaction.sign(administrator, ...signers);
    // 包括失败用例在内都交给验证器执行，避免客户端模拟掩盖回滚行为。
    // Execute negative cases on the validator so client simulation cannot mask rollback behavior.
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const status = await connection.confirmTransaction({ signature, ...lifetime }, commitment);
    return { signature, error: status.value.err };
  }

  /** 单独初始化使用带冻结权限的测试结算 Mint，保持其他验收脚本的初始化行为。 Initialize with a freeze-enabled fixture mint while preserving the other test scripts' initialization behavior. */
  const initialization = await submit([new TransactionInstruction({
    programId,
    data: discriminator('global:initialize_vault'),
    keys: [
      { pubkey: administrator.publicKey, isSigner: true, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: programData, isSigner: false, isWritable: false },
      { pubkey: assetMint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: cashVault, isSigner: false, isWritable: true },
      { pubkey: shareMint, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  })]);
  assert.equal(initialization.error, null, `Initialization failed (${initialization.signature}): ${JSON.stringify(initialization.error)}.`);

  /** 两位投资者分别存入一百枚结算代币。 Each investor deposits 100 settlement tokens. */
  const hundred = 100n * unitsPerToken;
  /**
   * 创建独立测试钱包的结算账户和份额账户，并准备其初始存入金额。
   * Create separate settlement and share accounts for a wallet and fund its initial deposit.
   */
  async function createInvestor() {
    /** 投资者签名人与其两个经典 SPL Token 账户。 Investor signer and its two classic SPL Token accounts. */
    const signer = Keypair.generate();
    const asset = await createAccount(connection, administrator, assetMint, signer.publicKey, Keypair.generate());
    const shares = await createAccount(connection, administrator, shareMint, signer.publicKey, Keypair.generate());
    await mintTo(connection, administrator, assetMint, asset, administrator, hundred);
    /** 创建可在验证器读取的普通钱包账户，并通过链上查询使用当前免租金余额。 Create a normal wallet account on the validator using the current rent-exempt balance. */
    const walletRent = await connection.getMinimumBalanceForRentExemption(0, commitment);
    const walletFunding = await submit([SystemProgram.transfer({
      fromPubkey: administrator.publicKey,
      toPubkey: signer.publicKey,
      lamports: walletRent,
    })]);
    assert.equal(walletFunding.error, null);
    return { signer, asset, shares };
  }

  /**
   * 构造具有相同账户顺序的存入与赎回指令，参数均为两个小端 u64。
   * Build deposit and redeem instructions with matching account ordering and two little-endian u64 arguments.
   * @param {'deposit' | 'redeem'} name 指令名称。 Instruction name.
   * @param {object} investor 投资者签名人及其两个代币账户。 Investor signer and both token accounts.
   * @param {bigint} input 输入资产或份额的最小单位数。 Input asset or share base units.
   * @param {bigint} minimum 输出份额或资产的最小单位下限。 Minimum share or asset output in base units.
   */
  function settlementInstruction(name, investor, input, minimum) {
    /** 八字节判别符后为输入数量和最低输出，分别占八字节。 Input and minimum output each occupy eight bytes after the discriminator. */
    const data = Buffer.alloc(24);
    discriminator(`global:${name}`).copy(data);
    data.writeBigUInt64LE(input, 8);
    data.writeBigUInt64LE(minimum, 16);
    return new TransactionInstruction({
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
    });
  }

  /** 两个签名账户各自持有一百份后续可赎回的份额。 Two separate signers each hold 100 shares for redemption. */
  const first = await createInvestor();
  const second = await createInvestor();
  for (const investor of [first, second]) {
    /** 验证前置存入成功，防止把 fixture 错误当作赎回失败。 Require successful fixture deposits before testing redemption. */
    const result = await submit([settlementInstruction('deposit', investor, hundred, hundred)], investor.signer);
    assert.equal(result.error, null, `Fixture deposit failed (${result.signature}): ${JSON.stringify(result.error)}.`);
  }

  /** 加入一份最小单位的尾数，让部分赎回暴露舍入差并由最后一次赎回取完。 Include one extra base unit so partial rounding leaves a remainder collected by the final redemption. */
  const donation = 20n * unitsPerToken + 1n;
  const source = await createAccount(connection, administrator, assetMint, administrator.publicKey, Keypair.generate());
  await mintTo(connection, administrator, assetMint, source, administrator, donation);
  const contributed = await submit([createTransferCheckedInstruction(
    source, assetMint, cashVault, administrator.publicKey, donation, decimals,
  )]);
  assert.equal(contributed.error, null);

  /** 回滚断言覆盖整个金库状态、相关 Mint 和两位钱包的余额。 Rollback assertions cover vault state, relevant mints, and both wallets' balances. */
  const watchedAccounts = [vault, cashVault, assetMint, shareMint, first.asset, first.shares, second.asset, second.shares];

  /**
   * 检查赎回因预期原因失败，并返回可用于确认 CPI 行为的交易签名。
   * Require the expected redemption failure and return the signature for checking CPI execution.
   * @param {object} investor 赎回签名人与代币账户，拒绝用例可替换账户。 Redeeming signer and token accounts, with substitutions for rejection cases.
   * @param {bigint} sharesIn 输入份额的最小单位数。 Input share base units.
   * @param {bigint} minimumAssetsOut 最低到账资产的最小单位数。 Minimum payout in asset base units.
   * @param {number} errorCode 预期链上错误码。 Expected on-chain error code.
   */
  async function assertRejected(investor, sharesIn, minimumAssetsOut, errorCode) {
    /** 执行前后的原始账户记录应完全相同。 Raw account records must match before and after the rejection. */
    const before = await connection.getMultipleAccountsInfo(watchedAccounts, commitment);
    const result = await submit([settlementInstruction('redeem', investor, sharesIn, minimumAssetsOut)], investor.signer);
    assert.deepEqual(result.error, { InstructionError: [0, { Custom: errorCode }] }, `Unexpected redemption result (${result.signature}).`);
    assert.deepEqual(await connection.getMultipleAccountsInfo(watchedAccounts, commitment), before);
    return result.signature;
  }

  /**
   * 读取已确认交易的日志和解析后的内部指令。
   * Read confirmed transaction logs and parsed inner instructions.
   * @param {string} signature 已确认交易的签名。 Confirmed transaction signature.
   */
  async function readTransactionMeta(signature) {
    /** 解析后的交易确定 CPI 指令类型，日志确定每次调用的结果。 Parsed instructions identify the CPIs and logs establish their outcomes. */
    const transaction = await connection.getParsedTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
    assert.ok(transaction?.meta?.logMessages, `Missing chain logs (${signature}).`);
    return transaction.meta;
  }

  /**
   * 赎回指定份额，并核对发出的实际成交事件。
   * Redeem a given amount of shares and assert its exact settlement event.
   * @param {object} investor 赎回签名人与代币账户。 Redeeming signer and token accounts.
   * @param {bigint} sharesIn 实际销毁的份额最小单位数。 Burned share base units.
   * @param {bigint} assetsOut 实际到账的结算资产最小单位数。 Settlement base units paid out.
   * @param {boolean} afterThaw 重新提交时使用不同交易消息。 Use a distinct transaction message when retrying after thaw.
   */
  async function assertAccepted(investor, sharesIn, assetsOut, afterThaw = false) {
    /** 解冻后使用同一业务请求，但用计算预算指令确保交易签名与失败记录不同。 Keep the same business request after thaw, but use a compute-budget instruction to give it a fresh signature. */
    const redeem = settlementInstruction('redeem', investor, sharesIn, assetsOut);
    const instructions = afterThaw ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), redeem] : [redeem];
    const result = await submit(instructions, investor.signer);
    assert.equal(result.error, null, `Redemption failed (${result.signature}): ${JSON.stringify(result.error)}.`);
    /** 成交事件取自验证器记录的成功交易日志。 Read the settlement event from the validator's successful transaction logs. */
    const metadata = await readTransactionMeta(result.signature);
    assert.deepEqual(readRedeemEvents(metadata.logMessages, programId), [{
      vault: vault.toBase58(),
      investor: investor.signer.publicKey.toBase58(),
      assetMint: assetMint.toBase58(),
      shareMint: shareMint.toBase58(),
      sharesIn,
      assetsOut,
    }]);
  }

  /** 汇总托管现金、钱包资产和份额余额，末项为份额 Mint 总供给。 Read custody cash, both wallets' assets and shares, and total share mint supply last. */
  async function balances() {
    /** 五个代币账户的数量和 Mint 供给均以 bigint 最小单位比较。 Compare the five token balances and mint supply in bigint base units. */
    const tokenAccounts = await Promise.all([cashVault, first.asset, first.shares, second.asset, second.shares]
      .map((address) => getAccount(connection, address, commitment)));
    const supply = (await getMint(connection, shareMint, commitment)).supply;
    return [...tokenAccounts.map(({ amount }) => amount), supply];
  }

  /** 第一笔销毁四十份，向下舍入后到账 44 mockUSDC。 The first redemption burns 40 shares and pays 44 mockUSDC after rounding down. */
  const partialShares = 40n * unitsPerToken;
  const partialAssets = 44n * unitsPerToken;
  assert.deepEqual(await balances(), [2n * hundred + donation, 0n, hundred, 0n, hundred, 2n * hundred]);
  await assertRejected(first, 0n, 1n, errors.invalidRedeemAmount);
  await assertRejected(first, partialShares, 0n, errors.invalidMinimumAssetsOut);
  await assertRejected(first, hundred + 1n, 1n, errors.insufficientRedeemShares);
  await assertRejected(first, partialShares, partialAssets + 1n, errors.minimumAssetsOutNotMet);
  await assertRejected({ ...first, asset: second.asset }, partialShares, 1n, errors.constraintTokenOwner);
  await assertRejected({ ...first, shares: second.shares }, partialShares, 1n, errors.constraintTokenOwner);

  // 冻结到账账户使第一步销毁通过、第二步转账失败，随后核对所有账户均原子回滚。
  // Freeze the destination so the burn succeeds before the transfer fails, then assert atomic rollback for every watched account.
  await freezeAccount(connection, administrator, first.asset, assetMint, administrator);
  const frozenSignature = await assertRejected(first, partialShares, partialAssets, errors.tokenAccountFrozen);
  /** 解析内部指令确定确实先销毁，再转账；SPL Token 的日志可能省略指令名称。 Read inner instructions to confirm burn then transfer even when SPL Token omits instruction names from logs. */
  const frozenMetadata = await readTransactionMeta(frozenSignature);
  const tokenCpiKinds = frozenMetadata.innerInstructions
    ?.flatMap(({ instructions }) => instructions)
    .filter(({ programId }) => programId.equals(TOKEN_PROGRAM_ID))
    .map(({ parsed }) => parsed?.type);
  assert.deepEqual(tokenCpiKinds, ['burn', 'transferChecked']);

  /** 按日志顺序核对第一个 CPI 成功、第二个 CPI 因冻结失败。 Check the logs for the first CPI succeeding and the second failing because the account is frozen. */
  const frozenLogs = frozenMetadata.logMessages;
  const tokenInvocation = `Program ${TOKEN_PROGRAM_ID} invoke [2]`;
  const burn = frozenLogs.indexOf(tokenInvocation);
  const burnSuccess = frozenLogs.indexOf(`Program ${TOKEN_PROGRAM_ID} success`, burn + 1);
  const transfer = frozenLogs.indexOf(tokenInvocation, burnSuccess + 1);
  const transferFailure = frozenLogs.indexOf(`Program ${TOKEN_PROGRAM_ID} failed: custom program error: 0x11`, transfer + 1);
  assert.ok(burn >= 0 && burnSuccess > burn && transfer > burnSuccess && transferFailure > transfer, frozenLogs.join('\n'));
  assert.deepEqual(readRedeemEvents(frozenLogs, programId), []);

  await thawAccount(connection, administrator, first.asset, assetMint, administrator);
  await assertAccepted(first, partialShares, partialAssets, true);
  assert.deepEqual(await balances(), [176_000_001n, partialAssets, 60_000_000n, 0n, hundred, 160_000_000n]);

  /** 先清空第一位钱包的剩余份额，再由第二位钱包最后赎回并取走全部尾差现金。 Empty the first wallet, then let the second wallet collect the leftover cash on the final redemption. */
  await assertAccepted(first, 60_000_000n, 66_000_000n);
  assert.deepEqual(await balances(), [110_000_001n, 110_000_000n, 0n, 0n, hundred, hundred]);
  await assertAccepted(second, hundred, 110_000_001n);
  assert.deepEqual(await balances(), [0n, 110_000_000n, 0n, 110_000_001n, 0n, 0n]);

  console.log(`Vault redemptions verified on Localnet: partial and full redemption, exact events, and burn rollback (${frozenSignature}).`);
}

await verifyRedemptions();

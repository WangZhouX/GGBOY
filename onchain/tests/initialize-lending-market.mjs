import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMint, getAccount, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';

/** 用于派生 ProgramData 账户的可升级加载器公钥。 Upgradeable loader public key used to derive ProgramData. */
const upgradeableLoader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/** 从 Localnet 读取已确认状态，并核对已在验证器执行的失败交易。 Read confirmed Localnet state and verify failed transactions executed by the validator. */
const commitment = 'confirmed';
/** 借款资产与示例抵押资产使用不同的小数位数，防止账户绑定被混用。 Debt and sample collateral mints use different decimal precision to catch swapped bindings. */
const debtDecimals = 6;
const collateralDecimals = 9;
/** Anchor 生成的初始化业务错误和账户约束错误编号。 Anchor error codes for initialization rules and account constraints. */
const errors = {
  invalidProgramData: 6000,
  unauthorizedAdministrator: 6001,
  invalidDebtMintDecimals: 6002,
  identicalAssetMints: 6003,
  unsupportedNativeMint: 6004,
  constraintSeeds: 2006,
  accountOwnedByWrongProgram: 3007,
};

/**
 * 根据 Anchor 命名空间与名称计算八字节判别符。
 * Derive the eight-byte discriminator from an Anchor namespace and name.
 * @param {string} qualifiedName 带 global 或 account 前缀的名称。 Name with the global or account namespace prefix.
 * @returns {Buffer} 指令或账户的二进制判别符。 Binary instruction or account discriminator.
 */
function discriminator(qualifiedName) {
  return createHash('sha256').update(qualifiedName).digest().subarray(0, 8);
}

/**
 * 读取 LendingMarket 的资产绑定、管理员和规范 bump。
 * Decode the asset bindings, administrator, and canonical bump from LendingMarket.
 * @param {Buffer} data 已确认的市场状态账户数据。 Confirmed market state account data.
 * @returns {object} 可与本次初始化参数直接比对的市场配置。 Market configuration comparable with the initialization inputs.
 */
function readMarketState(data) {
  /** 判别符为八字节，以五个 32 字节公钥和一字节 bump 紧随其后。 An eight-byte discriminator precedes five 32-byte keys and a one-byte bump. */
  const discriminatorSize = 8;
  const publicKeySize = 32;
  const bumpOffset = discriminatorSize + publicKeySize * 5;
  assert.equal(data.length, bumpOffset + 1);
  assert.deepEqual(data.subarray(0, discriminatorSize), discriminator('account:LendingMarket'));

  /**
   * 按公开布局读取指定序号的公钥。
   * Read a public key at the given index in the public layout.
   * @param {number} index 公钥下标，从零开始。 Zero-based public key index.
   * @returns {string} 公钥的 Base58 表示。 Base58 public key.
   */
  function readKey(index) {
    /** 公钥字段的字节偏移。 Byte offset of the public key field. */
    const offset = discriminatorSize + index * publicKeySize;
    return new PublicKey(data.subarray(offset, offset + publicKeySize)).toBase58();
  }

  return {
    administrator: readKey(0),
    debtMint: readKey(1),
    collateralMint: readKey(2),
    cashVault: readKey(3),
    collateralVault: readKey(4),
    bump: data[bumpOffset],
  };
}

/**
 * 推导记录指定程序升级权限的 ProgramData 账户。
 * Derive the ProgramData account holding the given program's upgrade authority.
 * @param {PublicKey} program 可升级程序的公钥。 Upgradeable program public key.
 * @returns {PublicKey} 属于该程序的 ProgramData 地址。 ProgramData address for that program.
 */
function programDataAddress(program) {
  return PublicKey.findProgramAddressSync([program.toBuffer()], upgradeableLoader)[0];
}

/**
 * 用真实 Localnet 交易验证单市场初始化、账户绑定、原子回滚与重放保护。
 * Verify singleton market initialization, account bindings, atomic rollback, and replay protection with real Localnet transactions.
 */
async function verifyInitialization() {
  /** 命令行参数指定本地部署、管理员密钥文件、Localnet RPC 和可选的第二个可升级程序。 CLI arguments specify the local deployment, administrator key file, Localnet RPC, and optional second upgradeable program. */
  const [programAddress, administratorFile, rpcUrl = 'http://127.0.0.1:8899', otherProgramAddress] = process.argv.slice(2);
  assert.ok(programAddress && administratorFile,
    'Usage: node initialize-lending-market.mjs <lending-program-id> <admin-keypair-file> [local-rpc-url] [other-upgradeable-program-id]');

  /** 验收交易只允许发送到本机 HTTP 验证器。 Send test transactions only to a loopback HTTP validator. */
  const endpoint = new URL(rpcUrl);
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Use an HTTP Localnet endpoint on localhost.');

  /** 已部署的借贷程序、连接和它的升级权限签名人。 Deployed lending program, connection, and its upgrade-authority signer. */
  const connection = new Connection(endpoint.href, commitment);
  const programId = new PublicKey(programAddress);
  const administrator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(administratorFile, 'utf8'))));
  /** 当前程序的 ProgramData、市场状态和分开托管两种资产的规范 PDA。 ProgramData, market state, and canonical PDAs that hold the two assets separately. */
  const programData = programDataAddress(programId);
  const [market, bump] = PublicKey.findProgramAddressSync([Buffer.from('lending_market')], programId);
  const [cashVault] = PublicKey.findProgramAddressSync([Buffer.from('cash_vault'), market.toBuffer()], programId);
  const [collateralVault] = PublicKey.findProgramAddressSync([Buffer.from('collateral_vault'), market.toBuffer()], programId);
  const watched = [market, cashVault, collateralVault];

  /** 确认从可升级部署和未初始化的市场开始。 Confirm an upgradeable deployment and an uninitialized market. */
  const deployed = await connection.getAccountInfo(programId, commitment);
  assert.ok(deployed?.executable && deployed.owner.equals(upgradeableLoader), 'Deploy the lending program as upgradeable on Localnet first.');
  assert.deepEqual(await connection.getMultipleAccountsInfo(watched, commitment), [null, null, null]);

  /** 正常用例使用两枚独立的经典 SPL Mint，代币 2022 与五位精度的 Mint 用于负例。 Two distinct classic SPL mints serve the main case, with Token-2022 and five-decimal mints for negative cases. */
  const debtMint = await createMint(connection, administrator, administrator.publicKey, null, debtDecimals);
  const collateralMint = await createMint(connection, administrator, administrator.publicKey, null, collateralDecimals);
  const wrongDebtMint = await createMint(connection, administrator, administrator.publicKey, null, debtDecimals - 1);
  const extensionMint = await createMint(connection, administrator, administrator.publicKey, null, collateralDecimals,
    undefined, { commitment }, TOKEN_2022_PROGRAM_ID);
  /** 给普通签名人足够的 lamports 支付手续费和账户租金，单独验证权限约束。 Fund a regular signer with enough lamports for fees and rent to isolate the authority check. */
  const otherSigner = Keypair.generate();
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
    fromPubkey: administrator.publicKey,
    toPubkey: otherSigner.publicKey,
    lamports: LAMPORTS_PER_SOL,
  })), [administrator], { commitment });

  /**
   * 对指定账户提交不带参数的初始化指令，并等待验证器返回实际执行结果。
   * Submit the argument-free initialization with specified accounts and wait for the validator's execution result.
   * @param {object} options 负例替换的签名人或账户，默认使用正确配置。 Signer or accounts overridden for a negative case, defaulting to the correct configuration.
   * @param {Keypair} [options.signer] 付款和授权签名人。 Fee payer and authority signer.
   * @param {PublicKey} [options.debt] 借款资产 Mint。 Debt asset mint.
   * @param {PublicKey} [options.collateral] 抵押资产 Mint。 Collateral asset mint.
   * @param {PublicKey} [options.data] ProgramData 地址。 ProgramData address.
   * @param {PublicKey} [options.collateralCustody] 抵押托管账户地址。 Collateral custody account address.
   * @param {boolean} [options.replay] 是否在初始化成功后改变消息再发一次。 Whether to retry with a distinct message after success.
   * @returns {Promise<{signature: string, error: object | null}>} 已确认交易的签名和执行错误。 Confirmed transaction signature and execution error.
   */
  async function initialize({
    signer = administrator, debt = debtMint, collateral = collateralMint,
    data = programData, collateralCustody = collateralVault, replay = false,
  } = {}) {
    /** 重复初始化改变交易消息，确保验证器执行第二笔交易而非返回旧签名。 Change the replay message so the validator executes a second transaction instead of reusing the first signature. */
    const transaction = new Transaction();
    if (replay) transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));
    transaction.add(new TransactionInstruction({
      programId,
      data: discriminator('global:initialize_lending_market'),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: programId, isSigner: false, isWritable: false },
        { pubkey: data, isSigner: false, isWritable: false },
        { pubkey: debt, isSigner: false, isWritable: false },
        { pubkey: collateral, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: cashVault, isSigner: false, isWritable: true },
        { pubkey: collateralCustody, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }));
    /** 保存实际签名使用的区块哈希及过期高度，供确认使用。 Retain the signed blockhash and expiry height for confirmation. */
    const lifetime = await connection.getLatestBlockhash(commitment);
    transaction.recentBlockhash = lifetime.blockhash;
    transaction.sign(signer);
    // 跳过预检使失败用例真的在验证器执行，便于检查错误与回滚。
    // Skip preflight so negative cases execute on the validator and expose errors and rollback.
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const confirmation = await connection.confirmTransaction({ signature, ...lifetime }, commitment);
    return { signature, error: confirmation.value.err };
  }

  /**
   * 检查指定的 Anchor 错误，确认不存在已部分写入的账户。
   * Check the specified Anchor error and confirm no partially written accounts exist.
   * @param {object} options 转发给初始化的负例参数。 Negative-case arguments passed to initialization.
   * @param {number} code 预期的 Anchor 错误编号。 Expected Anchor error code.
   * @returns {Promise<string>} 可用于进一步检查内部指令的交易签名。 Transaction signature available for inspecting inner instructions.
   */
  async function assertRejected(options, code) {
    /** 已由验证器执行的交易签名和错误。 Validator-executed transaction signature and error. */
    const { signature, error } = await initialize(options);
    assert.deepEqual(error, { InstructionError: [0, { Custom: code }] }, `Unexpected error (${signature}).`);
    assert.deepEqual(await connection.getMultipleAccountsInfo(watched, commitment), [null, null, null]);
    return signature;
  }

  if (otherProgramAddress) {
    /** 使用另一个真实程序的 ProgramData，验证初始化只接受当前借贷部署的升级权限记录。 Use real ProgramData from a second deployment to verify that initialization accepts only this lending program's authority record. */
    const unrelatedData = programDataAddress(new PublicKey(otherProgramAddress));
    assert.ok(!unrelatedData.equals(programData), 'Choose a different upgradeable program.');
    const installed = await connection.getAccountInfo(unrelatedData, commitment);
    assert.ok(installed?.owner.equals(upgradeableLoader), 'Deploy the other upgradeable program first.');
    await assertRejected({ data: unrelatedData }, errors.invalidProgramData);
  }

  // 校验签名权限、精度和 Mint 类型，并在每个负例后检查三个 PDA。
  // Check signer authority, mint precision, and mint type, then inspect all three PDAs after each rejection.
  await assertRejected({ signer: otherSigner }, errors.unauthorizedAdministrator);
  await assertRejected({ debt: wrongDebtMint }, errors.invalidDebtMintDecimals);
  await assertRejected({ collateral: debtMint }, errors.identicalAssetMints);
  await assertRejected({ collateral: NATIVE_MINT }, errors.unsupportedNativeMint);
  await assertRejected({ collateral: extensionMint }, errors.accountOwnedByWrongProgram);

  // 抵押托管地址错误在资金池已初始化的 CPI 之后触发，交易回滚前两笔账户创建。
  // A bad collateral custody address fails after the cash initialization CPI and reverts both prior account creations.
  const wrongCollateralVault = Keypair.generate().publicKey;
  const rollbackSignature = await assertRejected({ collateralCustody: wrongCollateralVault }, errors.constraintSeeds);
  const rollbackTransaction = await connection.getParsedTransaction(rollbackSignature, { commitment, maxSupportedTransactionVersion: 0 });
  /** 解析失败交易的系统创建指令和资金池 SPL 初始化日志，确保回滚用例命中后置校验。 Inspect system creation instructions and successful SPL initialization logs to prove the rollback case reached the late check. */
  const rollbackMeta = rollbackTransaction?.meta;
  assert.ok(rollbackMeta?.logMessages, `Missing rollback logs (${rollbackSignature}).`);
  const createdAddresses = rollbackMeta.innerInstructions
    ?.flatMap(({ instructions }) => instructions)
    .filter((instruction) => instruction.programId.equals(SystemProgram.programId) && instruction.parsed?.type === 'createAccount')
    .map(({ parsed }) => parsed.info.newAccount);
  assert.deepEqual(createdAddresses, [market.toBase58(), cashVault.toBase58()]);
  /** SPL 成功日志应早于抵押托管账户的 PDA 约束错误。 SPL success must precede the collateral custody PDA constraint error. */
  const cashInitialized = rollbackMeta.logMessages.indexOf(`Program ${TOKEN_PROGRAM_ID} success`);
  const collateralRejected = rollbackMeta.logMessages.findIndex((entry) => entry.includes('ConstraintSeeds'));
  assert.ok(cashInitialized >= 0 && collateralRejected > cashInitialized, rollbackMeta.logMessages.join('\n'));
  assert.equal(await connection.getAccountInfo(wrongCollateralVault, commitment), null);

  /** 使用同一组 PDA 由程序升级权限持有人提交正确配置。 Submit the correct configuration against the same PDAs as the program upgrade authority. */
  const initialized = await initialize();
  assert.equal(initialized.error, null, `Initialization failed (${initialized.signature}).`);

  /** 链上实际账户状态，后续作为重复初始化前的比较基准。 Actual chain accounts, also used as the baseline before replay. */
  const accounts = await connection.getMultipleAccountsInfo(watched, commitment);
  const [marketState, cashInfo, collateralInfo] = accounts;
  assert.ok(marketState?.owner.equals(programId));
  assert.ok(cashInfo?.owner.equals(TOKEN_PROGRAM_ID));
  assert.ok(collateralInfo?.owner.equals(TOKEN_PROGRAM_ID));
  assert.deepEqual(readMarketState(marketState.data), {
    administrator: administrator.publicKey.toBase58(),
    debtMint: debtMint.toBase58(),
    collateralMint: collateralMint.toBase58(),
    cashVault: cashVault.toBase58(),
    collateralVault: collateralVault.toBase58(),
    bump,
  });

  /** 两个托管账户的业务 Mint 对应关系，余额按各自 Mint 的最小单位检查。 Custody-to-mint bindings, with balances checked in the respective mint's base units. */
  const custodyBindings = [[cashVault, debtMint], [collateralVault, collateralMint]];
  for (const [address, mint] of custodyBindings) {
    /** SPL Token 解码的托管账户，链上市场 PDA 应是唯一转账权限。 Decoded SPL Token custody account, whose transfer authority must be the market PDA alone. */
    const custody = await getAccount(connection, address, commitment, TOKEN_PROGRAM_ID);
    assert.ok(custody.isInitialized && !custody.isFrozen && !custody.isNative);
    assert.ok(custody.owner.equals(market) && custody.mint.equals(mint));
    assert.equal(custody.amount, 0n);
    assert.equal(custody.delegate, null);
    assert.equal(custody.closeAuthority, null);
  }

  /** 重复初始化必须执行并失败，所有配置和余额都保持不变。 Repeated initialization must execute and fail, preserving all bindings and balances. */
  const duplicate = await initialize({ replay: true });
  assert.notEqual(duplicate.signature, initialized.signature);
  assert.equal(duplicate.error?.InstructionError?.[0], 1, `Replay did not fail at initialize_lending_market (${duplicate.signature}).`);
  assert.deepEqual(await connection.getMultipleAccountsInfo(watched, commitment), accounts);
  console.log(`Lending market initialization verified on Localnet (${initialized.signature}).`);
  console.log(`Late collateral custody validation rolled back account creation (${rollbackSignature}).`);
}

await verifyInitialization();

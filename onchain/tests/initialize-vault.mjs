import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMint, getAccount, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';

/** 用于推导程序升级数据账户的加载器地址。 Loader address used to derive the program data account. */
const upgradeableLoader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/** 读取已确认状态，同时让成功和失败的交易都在验证器执行。 Read confirmed state and let both success and failure cases execute on the validator. */
const commitment = 'confirmed';
/** 主用例中的结算资产和份额使用六位小数。 The settlement and share mints in the primary cases have six decimals. */
const assetDecimals = 6;
/** 账户约束预期返回的 Anchor 错误编号。 Expected Anchor errors for account constraint failures. */
const invalidProgramData = 6000;
const unauthorizedAdministrator = 6001;
const invalidAssetDecimals = 6002;

/**
 * 计算 Anchor 指令或账户的八字节判别符。
 * Derive the eight-byte discriminator for an Anchor instruction or account.
 * @param {string} qualifiedName 带 global 或 account 前缀的 Anchor 名称。 Anchor name with its global or account namespace.
 */
function discriminator(qualifiedName) {
  return createHash('sha256').update(qualifiedName).digest().subarray(0, 8);
}

/**
 * 读取已初始化 Vault 状态，按实际二进制布局校验配置。
 * Read initialized Vault state and check its configuration against the actual binary layout.
 * @param {Buffer} data 由 Localnet 返回的金库状态账户数据。 Vault state account data returned by Localnet.
 */
function readVaultState(data) {
  /** 状态由判别符、四个 32 字节公钥和一个 bump 字节组成。 State holds its discriminator, four 32-byte keys, and one bump byte. */
  const discriminatorSize = 8;
  const publicKeySize = 32;
  const publicKeyCount = 4;
  const bumpOffset = discriminatorSize + publicKeySize * publicKeyCount;
  assert.equal(data.length, bumpOffset + 1);
  assert.deepEqual(data.subarray(0, discriminatorSize), discriminator('account:Vault'));

  /**
   * 按零基字段序号读取链上公钥的 Base58 表达。
   * Read the Base58 representation of a public key by its zero-based field index.
   * @param {number} index 公钥字段下标。 Public-key field index.
   */
  function readKey(index) {
    /** 当前公钥字段的字节偏移。 Byte offset of the current key field. */
    const offset = discriminatorSize + index * publicKeySize;
    return new PublicKey(data.subarray(offset, offset + publicKeySize)).toBase58();
  }

  return {
    administrator: readKey(0),
    assetMint: readKey(1),
    cashVault: readKey(2),
    shareMint: readKey(3),
    bump: data[bumpOffset],
  };
}

/**
 * 推导可升级程序记录其升级权限的 ProgramData 公钥。
 * Derive the ProgramData key holding an upgradeable program's upgrade authority.
 * @param {PublicKey} program 待查询的可升级程序。 Upgradeable program to look up.
 */
function programDataAddress(program) {
  return PublicKey.findProgramAddressSync([program.toBuffer()], upgradeableLoader)[0];
}

/**
 * 在同一组 PDA 上验证初始化权限、资产约束、成功后的配置与重复初始化。
 * Verify initialization authority, asset constraints, initialized configuration, and replay against the same PDAs.
 */
async function verifyInitialization() {
  /** 命令行参数分别指向本地部署、管理员密钥文件、Localnet 和可选的另一个可升级程序。 Arguments identify the deployment, admin key file, Localnet, and an optional second upgradeable program. */
  const [programAddress, administratorFile, rpcUrl = 'http://127.0.0.1:8899', otherProgramAddress] = process.argv.slice(2);
  assert.ok(programAddress && administratorFile,
    'Usage: node initialize-vault.mjs <vault-program-id> <admin-keypair-file> [local-rpc-url] [other-upgradeable-program-id]');

  /** 拒绝向非本机 RPC 提交任何验收交易。 Reject sending any verification transaction to a non-local RPC. */
  const endpoint = new URL(rpcUrl);
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Use an HTTP Localnet endpoint on localhost.');
  /** 本地已部署的金库程序、连接和其升级权限签名人。 Local vault deployment, RPC connection, and its upgrade-authority signer. */
  const connection = new Connection(endpoint.href, commitment);
  const programId = new PublicKey(programAddress);
  const administrator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(administratorFile, 'utf8'))));
  /** 与部署程序绑定的升级数据地址，以及单一空金库使用的三个 PDA。 Bound upgrade data plus the three PDAs for the singleton empty vault. */
  const programData = programDataAddress(programId);
  const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);
  const [cashVault] = PublicKey.findProgramAddressSync([Buffer.from('cash_vault'), vault.toBuffer()], programId);
  const [shareMint] = PublicKey.findProgramAddressSync([Buffer.from('share_mint'), vault.toBuffer()], programId);
  const initializedAddresses = [vault, cashVault, shareMint];

  /** 确认目标已经以可升级程序部署，且当前测试未初始化过。 Confirm the upgradeable deployment exists and this test starts uninitialized. */
  const deployed = await connection.getAccountInfo(programId, commitment);
  assert.ok(deployed?.executable && deployed.owner.equals(upgradeableLoader), 'Deploy the vault as an upgradeable Localnet program first.');
  await assertUninitialized();

  /** 两个独立本地结算 Mint，仅精度不同；另准备有足够费用余额的普通签名人。 Local settlement mints differ only in decimals; a regular signer has enough fees and rent. */
  const assetMint = await createMint(connection, administrator, administrator.publicKey, null, assetDecimals);
  const wrongAssetMint = await createMint(connection, administrator, administrator.publicKey, null, assetDecimals - 1);
  const otherSigner = Keypair.generate();
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
    fromPubkey: administrator.publicKey,
    toPubkey: otherSigner.publicKey,
    lamports: LAMPORTS_PER_SOL,
  })), [administrator], { commitment });

  /**
   * 验证失败后没有留存三类新账户，也可用来校验干净的测试起点。
   * Confirm failed initialization leaves none of the three accounts; also used for the pristine starting point.
   */
  async function assertUninitialized() {
    assert.deepEqual(await connection.getMultipleAccountsInfo(initializedAddresses, commitment), [null, null, null]);
  }

  /**
   * 提交不带参数的 initialize_vault，并返回验证器记录的签名和执行状态。
   * Submit the argument-free initialize_vault and return the validator's signature and execution status.
   * @param {Keypair} signer 本次交易付款及管理员校验使用的签名人。 Fee payer and proposed administrator.
   * @param {PublicKey} mint 本次提供的结算 Mint。 Settlement mint for this attempt.
   * @param {PublicKey} dataAddress 本次提供的 ProgramData。 ProgramData for this attempt.
   * @param {boolean} replay 是否为成功之后的重复初始化。 Whether attempting initialization again after success.
   */
  async function initialize(signer, mint, dataAddress = programData, replay = false) {
    /** 在回放时改变交易消息，保证验证器执行第二笔指令而非返回已确认的旧签名。 Change the replay's transaction message so the validator executes it rather than returning the original signature. */
    const transaction = new Transaction();
    if (replay) transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));
    transaction.add(new TransactionInstruction({
      programId,
      data: discriminator('global:initialize_vault'),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: programId, isSigner: false, isWritable: false },
        { pubkey: dataAddress, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: cashVault, isSigner: false, isWritable: true },
        { pubkey: shareMint, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }));
    /** 用浏览器与命令行 SDK 共用的 blockhash 过期机制确认本次交易。 Confirm using blockhash expiry semantics shared by the browser and CLI SDKs. */
    const lifetime = await connection.getLatestBlockhash(commitment);
    transaction.recentBlockhash = lifetime.blockhash;
    transaction.sign(signer);
    // 负例也必须在验证器执行，这样能核对链上错误和原子回滚。
    // Execute negative cases on the validator to verify on-chain errors and atomic rollback.
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const confirmation = await connection.confirmTransaction({ signature, ...lifetime }, commitment);
    return { signature, error: confirmation.value.err };
  }

  /** 无升级权限的签名人即使能支付费用也无法抢先初始化。 A signer with enough fees still cannot initialize without upgrade authority. */
  const unauthorized = await initialize(otherSigner, assetMint);
  assert.deepEqual(unauthorized.error, { InstructionError: [0, { Custom: unauthorizedAdministrator }] });
  await assertUninitialized();

  /** 合法管理员传入五位小数的 Mint 仍必须失败。 Even the authorized admin must fail with a five-decimal mint. */
  const wrongDecimals = await initialize(administrator, wrongAssetMint);
  assert.deepEqual(wrongDecimals.error, { InstructionError: [0, { Custom: invalidAssetDecimals }] });
  await assertUninitialized();

  if (otherProgramAddress) {
    /** 选用另一真实可升级程序的 ProgramData，可测关联检查而非账户类型检查。 Use a real ProgramData from another upgradeable program to test the association instead of account type. */
    const unrelatedData = programDataAddress(new PublicKey(otherProgramAddress));
    assert.ok(!unrelatedData.equals(programData), 'Choose a different upgradeable program.');
    const installed = await connection.getAccountInfo(unrelatedData, commitment);
    assert.ok(installed?.owner.equals(upgradeableLoader), 'Deploy the other upgradeable program first.');
    const wrongProgramData = await initialize(administrator, assetMint, unrelatedData);
    assert.deepEqual(wrongProgramData.error, { InstructionError: [0, { Custom: invalidProgramData }] });
    await assertUninitialized();
  }

  /** 使用同一有效 Mint，由真正的管理员完成初始化。 Initialize the same valid mint with the actual administrator. */
  const initialized = await initialize(administrator, assetMint);
  assert.equal(initialized.error, null, `Initialization failed (${initialized.signature}).`);

  /** 从 Localnet 检查状态 owner、两类 SPL 账户的 owner 和各自的业务字段。 Check the state owner, both SPL account owners and their business fields on Localnet. */
  const initializedAccounts = await connection.getMultipleAccountsInfo(initializedAddresses, commitment);
  const [vaultState, cashAccountInfo, shareMintInfo] = initializedAccounts;
  assert.ok(vaultState?.owner.equals(programId));
  assert.ok(cashAccountInfo?.owner.equals(TOKEN_PROGRAM_ID));
  assert.ok(shareMintInfo?.owner.equals(TOKEN_PROGRAM_ID));
  assert.deepEqual(readVaultState(vaultState.data), {
    administrator: administrator.publicKey.toBase58(),
    assetMint: assetMint.toBase58(),
    cashVault: cashVault.toBase58(),
    shareMint: shareMint.toBase58(),
    bump,
  });
  /** SPL Token 解码后的托管账户和份额 Mint。 Custody and share mint decoded using the SPL Token layouts. */
  const custody = await getAccount(connection, cashVault, commitment, TOKEN_PROGRAM_ID);
  const shares = await getMint(connection, shareMint, commitment, TOKEN_PROGRAM_ID);
  assert.ok(custody.isInitialized && !custody.isFrozen);
  assert.ok(custody.owner.equals(vault) && custody.mint.equals(assetMint));
  assert.equal(custody.delegate, null);
  assert.equal(custody.closeAuthority, null);
  assert.equal(custody.amount, 0n);
  assert.ok(shares.isInitialized && shares.mintAuthority?.equals(vault));
  assert.equal(shares.freezeAuthority, null);
  assert.equal(shares.decimals, assetDecimals);
  assert.equal(shares.supply, 0n);

  /** 第二次初始化必须在金库指令处失败，三个账户内容与余额保持不变。 A second initialization must fail at the vault instruction and leave all three accounts unchanged. */
  const duplicate = await initialize(administrator, assetMint, programData, true);
  assert.equal(duplicate.error?.InstructionError?.[0], 1, `Replay did not fail at initialize_vault (${duplicate.signature}).`);
  assert.deepEqual(await connection.getMultipleAccountsInfo(initializedAddresses, commitment), initializedAccounts);
  console.log(`Vault initialization verified on Localnet (${initialized.signature}).`);
}

await verifyInitialization();

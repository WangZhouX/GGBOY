import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

/** 编译后的 IDL 提供判别符、账户顺序和默认公钥。 The built IDL provides discriminators, account order, and the default address. */
const idlPath = new URL('../target/idl/ggboy_lending.json', import.meta.url);
/** 读取与确认均使用最终确认状态。 Use finalized commitment for reads and confirmation. */
const commitment = 'finalized';
/** mockUSDC 借款资产使用六位小数。 The mockUSDC debt asset uses six decimals. */
const debtDecimals = 6;
/** Solana 可升级加载器公钥。 Solana upgradeable loader public key. */
const upgradeableLoader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/** 公共网络的创世哈希，用于校验 RPC 实际网络。 Public genesis hashes used to verify the RPC cluster. */
const publicGenesis = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
/** 接受已部署程序、现有 Mint 和本地签名钱包。 Accepts a deployed program, existing mints, and local signer. */
const usage = 'Usage: node initialize-lending-market.mjs --network <devnet|localnet> --rpc-url <url> --admin-keypair <file> --debt-mint <address> --collateral-mint <address> [--program-id <address>]';

/**
 * 读取 Solana CLI 密钥对，错误信息不会带出文件内容。
 * Read a Solana CLI keypair without including file contents in errors.
 * @param {string} path 密钥对文件路径。 Local keypair file path.
 * @returns {Promise<Keypair>} 经过验证的链上签名人。 Validated transaction signer.
 */
async function readAdministrator(path) {
  try {
    /** 密钥对存为 64 个无符号字节。 A CLI keypair is encoded as 64 unsigned bytes. */
    const secret = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Array.isArray(secret) && secret.length === 64
      && secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch {
    throw new Error('Cannot read a valid Solana CLI keypair from --admin-keypair.');
  }
}

/**
 * 校验部署与 ProgramData 绑定，读取当前升级权限。
 * Verify deployment and its ProgramData binding, then read the upgrade authority.
 * @param {import('@solana/web3.js').AccountInfo<Buffer> | null} program 借贷程序账户。 Lending program account.
 * @param {import('@solana/web3.js').AccountInfo<Buffer> | null} metadata 升级数据账户。 Upgrade metadata account.
 * @param {PublicKey} programData 当前程序派生的 ProgramData 公钥。 ProgramData key derived from this program.
 * @returns {PublicKey | null} 升级权限公钥，或不可升级时的空值。 Upgrade authority, or null if immutable.
 */
function readUpgradeAuthority(program, metadata, programData) {
  assert.ok(program?.executable && program.owner.equals(upgradeableLoader),
    'Deploy the upgradeable lending program to this network first.');
  // Program 的 u32 类型标签 2 后保存 32 字节 ProgramData 地址。
  // The u32 Program variant tag 2 is followed by the 32-byte ProgramData key.
  assert.ok(program.data.length >= 36 && program.data.readUInt32LE(0) === 2
    && new PublicKey(program.data.subarray(4, 36)).equals(programData),
  'The program does not point to the expected ProgramData account.');
  // ProgramData 使用类型标签 3，部署 slot 后保存一字节权限标志和可选公钥。
  // ProgramData tag 3 stores a deployment slot followed by an authority flag and an optional key.
  assert.ok(metadata?.owner.equals(upgradeableLoader) && metadata.data.length >= 13
    && metadata.data.readUInt32LE(0) === 3, 'The loader does not own a valid ProgramData account.');
  if (metadata.data[12] === 0) return null;
  assert.ok(metadata.data[12] === 1 && metadata.data.length >= 45, 'Unexpected ProgramData authority encoding.');
  return new PublicKey(metadata.data.subarray(13, 45));
}

/**
 * 校验市场绑定、PDA bump 及托管权限，返回实际余额。
 * Verify market bindings, PDA bump, and custody authority, and return observed balances.
 * @param {object} addresses 使用 Anchor IDL 名称索引的账户公钥。 Account public keys indexed by Anchor IDL names.
 * @param {number} bump 市场 PDA 的规范 bump。 Canonical market PDA bump.
 * @param {Buffer} discriminator LendingMarket 判别符。 LendingMarket discriminator.
 * @param {Array<import('@solana/web3.js').AccountInfo<Buffer> | null>} accounts 同一观测的市场、现金池和抵押托管。 Market, cash custody, and collateral custody from one observation.
 * @returns {{cashBaseUnits: string, collateralBaseUnits: string}} 各自 Mint 最小单位的无损整数文本。 Exact integer strings in each mint's base units.
 */
function verifyMarket(addresses, bump, discriminator, accounts) {
  /** 市场归借贷程序，两类托管由 SPL Token 程序管理。 The lending program owns the market and SPL Token owns both custody accounts. */
  const [market, cash, collateral] = accounts;
  assert.ok(market?.owner.equals(addresses.lending_program) && !market.executable,
    'The market state is absent or has an unexpected program owner.');
  /** 状态按 Rust 布局保存五个公钥和一个 bump 字节。 The Rust layout stores five public keys and one bump byte. */
  const expectedKeys = [addresses.administrator, addresses.debt_mint, addresses.collateral_mint,
    addresses.cash_vault, addresses.collateral_vault];
  const keyBytes = 32;
  const bumpOffset = discriminator.length + expectedKeys.length * keyBytes;
  assert.ok(market.data.length === bumpOffset + 1
    && market.data.subarray(0, discriminator.length).equals(discriminator) && market.data[bumpOffset] === bump,
  'Unexpected LendingMarket account layout or PDA bump.');

  for (const [index, key] of expectedKeys.entries()) {
    /** 当前绑定公钥的字节偏移。 Byte offset of the current binding key. */
    const offset = discriminator.length + index * keyBytes;
    assert.ok(new PublicKey(market.data.subarray(offset, offset + keyBytes)).equals(key),
      'The market is already bound to a different administrator, mint, or custody configuration.');
  }

  /** 两类账户必须保持市场 PDA 独占代币操作权限，且绑定各自的 Mint。 The market PDA must retain sole token authority and each custody must bind its own mint. */
  assert.ok(cash && collateral, 'Both market custody accounts must exist at finalized commitment.');
  const cashCustody = unpackAccount(addresses.cash_vault, cash, TOKEN_PROGRAM_ID);
  const collateralCustody = unpackAccount(addresses.collateral_vault, collateral, TOKEN_PROGRAM_ID);
  assert.ok(cashCustody.mint.equals(addresses.debt_mint)
    && collateralCustody.mint.equals(addresses.collateral_mint)
    && [cashCustody, collateralCustody].every((custody) => custody.isInitialized && !custody.isFrozen
      && !custody.isNative && custody.owner.equals(addresses.market) && !custody.delegate && !custody.closeAuthority),
  'A custody account has unexpected authorities, state, or mint.');
  return { cashBaseUnits: cashCustody.amount.toString(), collateralBaseUnits: collateralCustody.amount.toString() };
}

/**
 * 核对最终确认观测中的两枚 Mint 类型、初始化状态和借款精度。
 * Check mint type, initialization state, and debt precision in a finalized observation.
 * @param {PublicKey} debtMint 借款 Mint 公钥。 Debt mint public key.
 * @param {PublicKey} collateralMint 抵押 Mint 公钥。 Collateral mint public key.
 * @param {import('@solana/web3.js').AccountInfo<Buffer> | null} debtInfo 借款 Mint 账户。 Debt mint account.
 * @param {import('@solana/web3.js').AccountInfo<Buffer> | null} collateralInfo 抵押 Mint 账户。 Collateral mint account.
 * @returns {{debtDecimals: number, collateralDecimals: number}} 两枚 Mint 各自的小数位数。 Decimal precision of each mint.
 */
function verifyMints(debtMint, collateralMint, debtInfo, collateralInfo) {
  assert.ok(debtInfo && collateralInfo, 'Both mints must exist at finalized commitment before market initialization.');
  /** 经典 SPL 解码器检查账户类型、归属和布局。 Classic SPL decoders verify mint type, owner, and layout. */
  const debt = unpackMint(debtMint, debtInfo, TOKEN_PROGRAM_ID);
  const collateral = unpackMint(collateralMint, collateralInfo, TOKEN_PROGRAM_ID);
  assert.ok(debt.isInitialized && debt.decimals === debtDecimals && collateral.isInitialized,
    'Both mints must be initialized classic SPL Token mints and the debt mint must have six decimals.');
  return { debtDecimals: debt.decimals, collateralDecimals: collateral.decimals };
}

/**
 * 初始化目标测试网络的借贷市场，或核验已存在的相同配置。
 * Initialize the market on the target test network or verify the matching existing deployment.
 * @returns {Promise<void>} 把公开地址、余额和确认信息以 JSON 写入标准输出。 Writes public keys, balances, and confirmation details as JSON.
 */
async function main() {
  /** 命令参数指定网络、RPC、密钥路径和两类 Mint。 CLI inputs select the cluster, RPC, keypair path, and both mints. */
  const { values: options } = parseArgs({ options: {
    network: { type: 'string' },
    'rpc-url': { type: 'string' },
    'admin-keypair': { type: 'string' },
    'debt-mint': { type: 'string' },
    'collateral-mint': { type: 'string' },
    'program-id': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (options.help) {
    console.log(usage);
    return;
  }
  assert.ok((options.network === 'devnet' || options.network === 'localnet')
    && options['rpc-url'] && options['admin-keypair'] && options['debt-mint'] && options['collateral-mint'], usage);

  /** 签名前先核对 RPC 协议和当前实际网络。 Check the endpoint protocol and actual network before signing. */
  const endpoint = new URL(options['rpc-url']);
  const isLocal = options.network === 'localnet';
  assert.ok(isLocal
    ? endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    : endpoint.protocol === 'https:', 'Use an HTTP loopback RPC for Localnet or an HTTPS RPC for Devnet.');
  const connection = new Connection(endpoint.href, commitment);
  const genesisHash = await connection.getGenesisHash();
  assert.ok(isLocal ? !Object.values(publicGenesis).includes(genesisHash) : genesisHash === publicGenesis.devnet,
    'The RPC genesis hash does not match --network.');

  /** 编译后的 ABI 提供签名指令和市场状态的判别符。 The built ABI supplies discriminators for the signed instruction and market state. */
  const idl = JSON.parse(await readFile(idlPath, 'utf8'));
  const initialize = idl.instructions.find(({ name }) => name === 'initialize_lending_market');
  const marketDefinition = idl.accounts.find(({ name }) => name === 'LendingMarket');
  assert.ok(initialize?.args.length === 0 && initialize.discriminator.length === 8
    && marketDefinition?.discriminator.length === 8, 'The built IDL is missing the expected lending initializer or account.');
  const programId = new PublicKey(options['program-id'] ?? idl.address);
  assert.equal(programId.toBase58(), idl.address, 'The program ID does not match the built lending IDL.');
  const administrator = await readAdministrator(options['admin-keypair']);

  /** 借款与抵押资产使用不同的测试 Mint，排除包装原生 SOL。 Debt and collateral use distinct test mints, excluding wrapped native SOL. */
  const debtMint = new PublicKey(options['debt-mint']);
  const collateralMint = new PublicKey(options['collateral-mint']);
  assert.ok(!debtMint.equals(collateralMint) && !debtMint.equals(NATIVE_MINT) && !collateralMint.equals(NATIVE_MINT),
    'Debt and collateral must use distinct non-native SPL Token mints.');

  /** 使用 Rust 账户约束中的固定种子。 Use the fixed seeds enforced by the Rust account constraints. */
  const [market, bump] = PublicKey.findProgramAddressSync([Buffer.from('lending_market')], programId);
  const [cashVault] = PublicKey.findProgramAddressSync([Buffer.from('cash_vault'), market.toBuffer()], programId);
  const [collateralVault] = PublicKey.findProgramAddressSync([Buffer.from('collateral_vault'), market.toBuffer()], programId);
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], upgradeableLoader);
  /** IDL 的账户名对应实际交易公钥。 IDL account names map to transaction public keys. */
  const addresses = {
    administrator: administrator.publicKey, lending_program: programId, program_data: programData,
    debt_mint: debtMint, collateral_mint: collateralMint, market,
    cash_vault: cashVault, collateral_vault: collateralVault,
    token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
  };

  /** 在同一个最终确认观测中核实部署、权限、Mint 和托管状态。 Sample deployment, authority, mints, and custody at one finalized slot. */
  const sampleKeys = [programId, programData, debtMint, collateralMint, market, cashVault, collateralVault];
  let sample = await connection.getMultipleAccountsInfoAndContext(sampleKeys, { commitment });
  let observedAt = new Date().toISOString();
  const [program, metadata, debtInfo, collateralInfo, ...persisted] = sample.value;
  const authority = readUpgradeAuthority(program, metadata, programData);
  verifyMints(debtMint, collateralMint, debtInfo, collateralInfo);

  /** 只有首次初始化才记录新签名和交易确认 slot。 Only first-time initialization has a new signature and confirmation slot. */
  const alreadyInitialized = persisted[0]?.owner.equals(programId) ?? false;
  let signature = null;
  let confirmationSlot = null;
  if (!alreadyInitialized) {
    // 接受给未分配 PDA 预转 SOL，遇到已分配的账户冲突则停止。
    // Accept SOL prefunding of unallocated PDAs, and stop on allocated account conflicts.
    assert.ok(persisted.every((account) => !account
      || (!account.executable && account.owner.equals(SystemProgram.programId) && account.data.length === 0)),
    'An unexpected account is already allocated at a lending PDA.');
    assert.ok(authority?.equals(administrator.publicKey), 'The administrator must hold the lending program upgrade authority.');

    /** 按 IDL 的顺序与属性组装账户元数据。 Build account metadata in the order and with the privileges specified by the IDL. */
    const keys = initialize.accounts.map(({ name, writable, signer }) => {
      assert.ok(Object.hasOwn(addresses, name), `Unknown initialize_lending_market account: ${name}`);
      return { pubkey: addresses[name], isWritable: writable === true, isSigner: signer === true };
    });
    /** 交易使用新鲜的区块哈希和作为付款人的管理员。 The administrator pays for the transaction, which uses a recent blockhash. */
    const lifetime = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ ...lifetime, feePayer: administrator.publicKey }).add(new TransactionInstruction({
      programId, keys, data: Buffer.from(initialize.discriminator),
    }));
    transaction.sign(administrator);
    signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed' });
    try {
      /** 等待最终确认后重新读取同一或更高 slot 的所有账户。 Wait for finalization before reading all accounts at or above the confirmation slot. */
      const confirmation = await connection.confirmTransaction({ ...lifetime, signature }, commitment);
      if (confirmation.value.err) throw new Error(JSON.stringify(confirmation.value.err));
      confirmationSlot = confirmation.context.slot;
      sample = await connection.getMultipleAccountsInfoAndContext(sampleKeys, { commitment, minContextSlot: confirmationSlot });
      observedAt = new Date().toISOString();
    } catch (error) {
      throw new Error(`Initialization transaction ${signature}: ${error.message}`, { cause: error });
    }
  }

  /** 输出可用于市场登记的链上账户绑定与读回的托管余额。 Report verified account bindings and custody balances for market registration. */
  const [observedProgram, observedMetadata, observedDebt, observedCollateral, ...observedMarket] = sample.value;
  const observedAuthority = readUpgradeAuthority(observedProgram, observedMetadata, programData);
  const precision = verifyMints(debtMint, collateralMint, observedDebt, observedCollateral);
  const amounts = verifyMarket(addresses, bump, Buffer.from(marketDefinition.discriminator), observedMarket);
  console.log(JSON.stringify({
    status: alreadyInitialized ? 'already-initialized' : 'initialized',
    network: options.network,
    programId: programId.toBase58(),
    programData: programData.toBase58(),
    administrator: administrator.publicKey.toBase58(),
    upgradeAuthority: observedAuthority?.toBase58() ?? null,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    debtMint: debtMint.toBase58(),
    collateralMint: collateralMint.toBase58(),
    ...precision,
    market: market.toBase58(),
    cashVault: cashVault.toBase58(),
    collateralVault: collateralVault.toBase58(),
    ...amounts,
    signature,
    confirmationSlot,
    observedSlot: sample.context.slot,
    observedAt,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message || error.name);
  process.exitCode = 1;
}

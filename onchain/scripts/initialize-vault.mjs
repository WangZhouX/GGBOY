import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getMint, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

/** 编译后的 IDL 提供指令判别符、账户顺序和默认程序地址。 The built IDL provides the discriminator, account order, and default program address. */
const idlPath = new URL('../target/idl/ggboy_vault.json', import.meta.url);
/** 初始化和读取均使用已确认状态。 Use confirmed state for both initialization and reads. */
const commitment = 'confirmed';
/** 测试结算资产与金库份额的小数位数。 Decimals shared by the test settlement asset and the vault shares. */
const tokenDecimals = 6;
/** GGBOY 初始化识别的 Solana 可升级加载器。 The Solana upgradeable loader recognized by GGBOY's initializer. */
const upgradeableLoader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/** 公用网络的创世哈希用于核对指定 RPC 对应的网络。 Public-network genesis hashes verify the network behind the supplied RPC. */
const publicGenesis = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
/** 初始化入口接受已部署的项目程序、现有资产 Mint 和管理员钱包。 The initializer takes a deployed program, existing asset mint, and administrator wallet. */
const usage = 'Usage: node initialize-vault.mjs --network <devnet|localnet> --rpc-url <url> --admin-keypair <file> --asset-mint <address> [--program-id <address>]';

/**
 * 读取并验证 Solana CLI 使用的 64 字节密钥对，错误信息不输出文件内容。
 * Read and validate a 64-byte Solana CLI keypair without exposing file contents in errors.
 * @param {string} path 管理员密钥对文件路径。 Administrator keypair file path.
 */
async function readAdministrator(path) {
  try {
    /** Solana CLI 将私钥和公钥字节编码成 JSON 整数数组。 The Solana CLI encodes secret and public key bytes as a JSON integer array. */
    const secret = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Array.isArray(secret) && secret.length === 64
      && secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch {
    throw new Error('Cannot read a valid Solana CLI keypair from --admin-keypair.');
  }
}

/**
 * 校验程序已部署，并读取加载器记录的当前升级权限。
 * Verify deployment and read the upgrade authority recorded by the loader.
 * @param {import('@solana/web3.js').AccountInfo<Buffer> | null} program 已确认的程序账户。 Confirmed program account.
 * @param {import('@solana/web3.js').AccountInfo<Buffer> | null} metadata 已确认的 ProgramData 账户。 Confirmed ProgramData account.
 * @param {PublicKey} programData 推导出的 ProgramData 公钥。 Derived ProgramData public key.
 */
function readUpgradeAuthority(program, metadata, programData) {
  assert.ok(program?.executable && program.owner.equals(upgradeableLoader), 'Deploy the upgradeable vault program to this network first.');
  // 可升级加载器的 Program 状态由 u32 类型标签 2 及 32 字节 ProgramData 地址组成。
  // The loader's Program variant stores u32 tag 2 followed by the 32-byte ProgramData key.
  assert.ok(program.data.length >= 36 && program.data.readUInt32LE(0) === 2
    && new PublicKey(program.data.subarray(4, 36)).equals(programData), 'The program does not point to the expected ProgramData account.');
  // ProgramData 由标签 3、u64 部署 slot、Option 标志以及可选的权限公钥开头。
  // ProgramData starts with tag 3, a u64 deployment slot, an option flag, and the optional authority key.
  assert.ok(metadata?.owner.equals(upgradeableLoader) && metadata.data.length >= 13
    && metadata.data.readUInt32LE(0) === 3, 'The upgradeable loader does not own a valid ProgramData account.');
  if (metadata.data[12] === 0) return null;
  assert.ok(metadata.data[12] === 1 && metadata.data.length >= 45, 'Unexpected ProgramData authority encoding.');
  return new PublicKey(metadata.data.subarray(13, 45));
}

/**
 * 校验金库状态以及两个代币账户的链上权限，返回当前最小单位数量。
 * Verify the vault state and both token accounts' on-chain authorities, and return current base-unit quantities.
 * @param {object} addresses 本次初始化的预期程序、管理员与账户公钥。 Expected program, administrator and account keys.
 * @param {number} bump 金库 PDA 的规范 bump。 Canonical vault PDA bump.
 * @param {Buffer} discriminator 已编译 IDL 中的 Vault 账户判别符。 Vault account discriminator from the built IDL.
 * @param {Array<import('@solana/web3.js').AccountInfo<Buffer> | null>} accounts 链上的金库、托管和份额账户。 Vault, custody, and share accounts on-chain.
 */
function verifyVault(addresses, bump, discriminator, accounts) {
  /** 按查询顺序读取金库状态、托管代币账户和份额 Mint。 Read state, custody and share mint in request order. */
  const [state, cash, shares] = accounts;
  assert.ok(state?.owner.equals(addresses.vault_program), 'The vault state account is absent or belongs to another program.');
  /** 判别符后保存四个公钥，再保存一字节的 bump。 Four public keys and a one-byte bump follow the discriminator. */
  const stateStart = discriminator.length;
  const keySize = 32;
  const expectedKeys = [addresses.administrator, addresses.asset_mint, addresses.cash_vault, addresses.share_mint];
  const bumpOffset = stateStart + expectedKeys.length * keySize;
  // 策略激活在原字段后扩展一字节，核验继续使用相同的公钥与 bump 偏移。
  // Strategy activation appends one byte. Verification continues to use the original key and bump offsets.
  const legacyLength = bumpOffset + 1;
  assert.ok([legacyLength, legacyLength + 1].includes(state.data.length)
    && state.data.subarray(0, stateStart).equals(discriminator)
    && state.data[bumpOffset] === bump, 'Unexpected Vault account layout or PDA bump.');
  for (const [index, expectedKey] of expectedKeys.entries()) {
    /** 当前绑定公钥在 Vault 账户中的字节偏移。 Byte offset of the current binding key in the Vault account. */
    const start = stateStart + index * keySize;
    assert.ok(new PublicKey(state.data.subarray(start, start + keySize)).equals(expectedKey),
      'The vault is already bound to a different administrator or asset configuration.');
  }

  /** 经典 SPL 解码器校验账户存在、程序归属及布局。 Classic SPL decoders check account existence, owner program and layout. */
  const cashAccount = unpackAccount(addresses.cash_vault, cash, TOKEN_PROGRAM_ID);
  const shareMint = unpackMint(addresses.share_mint, shares, TOKEN_PROGRAM_ID);
  assert.ok(cashAccount.isInitialized && !cashAccount.isFrozen && cashAccount.owner.equals(addresses.vault)
    && cashAccount.mint.equals(addresses.asset_mint) && !cashAccount.delegate && !cashAccount.closeAuthority,
  'The cash custody account has unexpected authorities or asset mint.');
  assert.ok(shareMint.isInitialized && shareMint.decimals === tokenDecimals
    && shareMint.mintAuthority?.equals(addresses.vault) && !shareMint.freezeAuthority,
  'The share mint has unexpected precision or authorities.');
  return { cashBaseUnits: cashAccount.amount.toString(), shareSupplyBaseUnits: shareMint.supply.toString() };
}

/**
 * 初始化指定网络上的 GGBOY 金库，或核验已初始化的相同配置。
 * Initialize the GGBOY vault on the requested network or verify the matching existing configuration.
 * @returns {Promise<void>} 向标准输出写入公开账户和确认交易信息。 Writes public accounts and confirmation information to stdout.
 */
async function main() {
  /** 显式传入网络、RPC、签名钱包和结算资产，以便脚本在不同测试环境复用。 Explicit inputs select the network, RPC, signer and settlement mint. */
  const { values: options } = parseArgs({ options: {
    'network': { type: 'string' },
    'rpc-url': { type: 'string' },
    'admin-keypair': { type: 'string' },
    'asset-mint': { type: 'string' },
    'program-id': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (options.help) {
    console.log(usage);
    return;
  }
  assert.ok((options.network === 'devnet' || options.network === 'localnet')
    && options['rpc-url'] && options['admin-keypair'] && options['asset-mint'], usage);

  /** 依据端点协议和创世哈希确认目标网络，然后再读取签名文件。 Confirm the target using the endpoint protocol and genesis hash before reading the signing file. */
  const endpoint = new URL(options['rpc-url']);
  const isLocal = options.network === 'localnet';
  assert.ok(isLocal
    ? endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    : endpoint.protocol === 'https:', 'Use an HTTP loopback RPC for Localnet or an HTTPS RPC for Devnet.');
  const connection = new Connection(endpoint.href, commitment);
  const genesisHash = await connection.getGenesisHash();
  assert.ok(isLocal ? !Object.values(publicGenesis).includes(genesisHash) : genesisHash === publicGenesis.devnet,
    'The RPC genesis hash does not match --network.');

  /** 本地构建的项目 ABI、账户判别符和已部署的程序地址。 The compiled project ABI, account discriminator and deployed program address. */
  const idl = JSON.parse(await readFile(idlPath, 'utf8'));
  const initialize = idl.instructions.find(({ name }) => name === 'initialize_vault');
  const vaultDefinition = idl.accounts.find(({ name }) => name === 'Vault');
  assert.ok(initialize?.args.length === 0 && initialize.discriminator.length === 8 && vaultDefinition?.discriminator.length === 8,
    'The built IDL does not contain the expected vault initializer and account.');
  const programId = new PublicKey(options['program-id'] ?? idl.address);
  const administrator = await readAdministrator(options['admin-keypair']);
  const assetMint = new PublicKey(options['asset-mint']);
  /** 固定种子与 Rust 初始化账户约束一致。 Fixed seeds match the Rust initialization account constraints. */
  const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);
  const [cashVault] = PublicKey.findProgramAddressSync([Buffer.from('cash_vault'), vault.toBuffer()], programId);
  const [shareMint] = PublicKey.findProgramAddressSync([Buffer.from('share_mint'), vault.toBuffer()], programId);
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], upgradeableLoader);
  const addresses = {
    administrator: administrator.publicKey,
    vault_program: programId,
    program_data: programData,
    asset_mint: assetMint,
    vault,
    cash_vault: cashVault,
    share_mint: shareMint,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  };

  /** 已存在的结算资产必须是初始化完成的六位小数经典 SPL Token Mint。 The existing settlement asset must be an initialized six-decimal classic SPL mint. */
  const settlement = await getMint(connection, assetMint, commitment, TOKEN_PROGRAM_ID);
  assert.ok(settlement.isInitialized && settlement.decimals === tokenDecimals,
    'The settlement asset must be an initialized classic SPL Token mint with six decimals.');

  /** 同一批查询读取部署、升级权限和已有金库状态。 Fetch the deployment, upgrade metadata and existing vault state in one RPC request. */
  const [program, metadata, ...persisted] = await connection.getMultipleAccountsInfo(
    [programId, programData, vault, cashVault, shareMint], commitment,
  );
  const authority = readUpgradeAuthority(program, metadata, programData);
  /** 已被金库程序分配的 PDA 表示金库已经初始化。 A PDA assigned to the vault program indicates an initialized vault. */
  const alreadyInitialized = persisted[0]?.owner.equals(programId) ?? false;
  let accounts = persisted;
  /** 新发交易的签名和确认 slot，重复核验时不产生交易。 New transaction signature and confirmation slot. Verification alone submits no transaction. */
  let signature = null;
  let confirmationSlot = null;

  if (!alreadyInitialized) {
    // 允许其他钱包仅向尚未分配的 PDA 转入 SOL。已分配的冲突账户则停止初始化。
    // Accept SOL prefunding of unallocated PDAs, and stop when any conflicting account is already allocated.
    assert.ok(persisted.every((account) => !account
      || (!account.executable && account.owner.equals(SystemProgram.programId) && account.data.length === 0)),
    'An unexpected account is already allocated at a vault PDA.');
    assert.ok(authority?.equals(administrator.publicKey), 'The administrator keypair must hold the deployed vault program upgrade authority.');

    /** 从 IDL 读取初始化账户顺序和读写、签名属性。 The IDL defines initialization account order, writability and signers. */
    const keys = initialize.accounts.map(({ name, writable, signer }) => {
      assert.ok(Object.hasOwn(addresses, name), `Unknown initialize_vault account: ${name}`);
      return { pubkey: addresses[name], isWritable: writable === true, isSigner: signer === true };
    });
    /** 区块哈希、有效高度和交易付款方共同确定本次初始化请求。 Blockhash, expiry height and fee payer define this initialization request. */
    const lifetime = await connection.getLatestBlockhash(commitment);
    const transaction = new Transaction({ ...lifetime, feePayer: administrator.publicKey }).add(new TransactionInstruction({
      programId,
      keys,
      data: Buffer.from(initialize.discriminator),
    }));
    transaction.sign(administrator);
    signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: commitment });
    try {
      /** 确认写入并以确认 slot 为下界重新读取金库账户。 Confirm the write, then read the vault accounts at or after the confirmed slot. */
      const confirmation = await connection.confirmTransaction({ ...lifetime, signature }, commitment);
      if (confirmation.value.err) throw new Error(JSON.stringify(confirmation.value.err));
      confirmationSlot = confirmation.context.slot;
      accounts = await connection.getMultipleAccountsInfo(
        [vault, cashVault, shareMint], { commitment, minContextSlot: confirmationSlot },
      );
    } catch (error) {
      throw new Error(`Initialization transaction ${signature}: ${error.message}`, { cause: error });
    }
  }

  /** 输出链上已校验的公开地址及最小单位数量，便于接入前端配置。 Output verified public addresses and base-unit quantities for frontend configuration. */
  const amounts = verifyVault(addresses, bump, Buffer.from(vaultDefinition.discriminator), accounts);
  console.log(JSON.stringify({
    status: alreadyInitialized ? 'already-initialized' : 'initialized',
    network: options.network,
    programId: programId.toBase58(),
    programData: programData.toBase58(),
    administrator: administrator.publicKey.toBase58(),
    upgradeAuthority: authority?.toBase58() ?? null,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    assetMint: assetMint.toBase58(),
    vault: vault.toBase58(),
    cashVault: cashVault.toBase58(),
    shareMint: shareMint.toBase58(),
    ...amounts,
    signature,
    confirmationSlot,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

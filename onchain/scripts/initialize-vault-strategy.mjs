import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

/** 已编译的 IDL 作为程序地址、账户与指令判别符的来源。 Built IDLs supply program addresses and account and instruction discriminators. */
const vaultIdlPath = new URL('../target/idl/ggboy_vault.json', import.meta.url);
const lendingIdlPath = new URL('../target/idl/ggboy_lending.json', import.meta.url);
/** 链上读取和写后验证使用最终确认。 Use finalized commitment for observations and verification after initialization. */
const commitment = 'finalized';
/** 核对实际网络时使用的公共创世哈希。 Public genesis hashes used to verify the actual network. */
const publicGenesis = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
/** 程序公钥宽度、结算与策略 Mint 小数位数，以及比例单位。 Public key width, settlement and spot mint decimals, and unit for ratios. */
const keyBytes = 32;
const cashDecimals = 6;
const strategyDecimals = 9;
const fullBps = 10_000;
/** 初始化参数名称与账户配置中的比例字段顺序一致。 CLI ratio options follow the field order in strategy state. */
const ratioFlags = ['reserve-bps', 'lending-cap-bps', 'max-trade-bps'];
/** 默认只读。显式执行须另外提供管理员和完整策略配置。 Reads by default. Explicit execution also requires the administrator and full strategy settings. */
const usage = 'Usage: node initialize-vault-strategy.mjs --network <localnet|devnet> --rpc-url <url> --asset-mint <address> --strategy-mint <address> [--manager <address> --reserve-bps <bps> --lending-cap-bps <bps> --max-trade-bps <bps>] [--execute --admin-keypair <file>]';

/**
 * 根据链上固定种子派生账户公钥和规范 bump。
 * Derive the account public key and canonical bump from the on-chain seeds.
 * @param {PublicKey} program PDA 所属程序。 Program that owns the PDA namespace.
 * @param {string} seed 固定 UTF-8 种子。 Fixed UTF-8 seed.
 * @param {...PublicKey} keys 按链上顺序附加的公钥。 Public keys appended in on-chain order.
 */
function derive(program, seed, ...keys) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map((key) => key.toBuffer())], program);
}

/**
 * 读取 Solana CLI 密钥对并校验私钥和公钥的匹配关系。
 * Read a Solana CLI keypair and verify that the private and public key bytes match.
 * @param {string} path 管理员密钥文件路径，文件内容不写入输出。 Administrator keypair path. Never print file contents.
 */
async function readAdministrator(path) {
  try {
    /** Solana CLI 使用 64 个无符号字节记录密钥对。 Solana CLI keypairs store 64 unsigned bytes. */
    const secret = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Array.isArray(secret) && secret.length === 64
      && secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch {
    throw new Error('Cannot read a valid Solana CLI keypair from --admin-keypair.');
  }
}

/**
 * 解析可选的预计配置。提供配置时须一次填齐管理者和三项比例。
 * Parse optional expected settings. A supplied configuration must contain the manager and all three ratios.
 * @param {Record<string, string | boolean | undefined>} options 命令行参数。 Parsed CLI options.
 */
function parseSettings(options) {
  /** 可分别核验链上有效配置或预计启用的公钥与比例。 Inspect active settings or verify proposed keys and ratios. */
  const fields = ['manager', ...ratioFlags];
  if (fields.every((field) => options[field] === undefined)) return null;
  assert.ok(fields.every((field) => typeof options[field] === 'string' && options[field].length > 0),
    'Provide --manager and all three ratio flags together.');
  /** 管理钱包和三个整数基点，最后一项为正的单笔交易上限。 Manager key and three integer basis-point values, with a positive per-trade limit. */
  const manager = new PublicKey(options.manager);
  assert.ok(!manager.equals(PublicKey.default), 'The manager cannot be the default public key.');
  const ratios = ratioFlags.map((flag, index) => {
    /** 现金留存与出借上限允许为零，单笔调仓上限从一个基点起。 Cash reserve and lending cap may be zero. The per-swap limit starts at one basis point. */
    const raw = options[flag];
    const value = Number(raw);
    assert.ok(/^\d{1,5}$/.test(raw) && value >= (index === 2 ? 1 : 0) && value <= fullBps,
      `Invalid integer basis points for --${flag}.`);
    return value;
  });
  return { manager: manager.toBase58(), reserveBps: ratios[0], lendingCapBps: ratios[1], maxTradeBps: ratios[2] };
}

/**
 * 解码由已知 Anchor 程序持有的账户，拒绝未知判别符和账户长度。
 * Decode an account held by its expected Anchor program and reject unknown layouts or discriminators.
 * @param {object | null} account RPC 原始账户数据。 Raw RPC account data.
 * @param {PublicKey} program 预期程序所有者。 Expected program owner.
 * @param {object} idl 该程序的编译 IDL。 Compiled IDL for the program.
 * @param {string} name Anchor 账户类型名。 Anchor account type.
 * @param {number[]} sizes 去掉判别符后的支持长度，单位字节。 Supported body lengths in bytes after the discriminator.
 */
function accountBody(account, program, idl, name, sizes) {
  /** 此类型的 Anchor 判别符在账户正文之前。 This type's Anchor discriminator precedes the account body. */
  const spec = idl.accounts.find((entry) => entry.name === name);
  assert.ok(spec?.discriminator.length === 8 && account?.owner.equals(program) && !account.executable,
    `Missing or invalid ${name} at the expected program address.`);
  const prefix = Buffer.from(spec.discriminator);
  const body = account.data.subarray(prefix.length);
  assert.ok(account.data.subarray(0, prefix.length).equals(prefix) && sizes.includes(body.length),
    `Unexpected ${name} layout.`);
  return body;
}

/**
 * 核对经典 SPL 托管账户绑定，并返回当前最小单位余额。
 * Verify classic SPL custody bindings and return its base-unit balance.
 * @param {PublicKey} address 规范代币账户地址。 Canonical token account.
 * @param {object | null} info RPC 原始账户数据。 Raw RPC account data.
 * @param {PublicKey} mint 代币 Mint。 Token mint.
 * @param {PublicKey} authority 托管的代币权限 PDA。 PDA with custody token authority.
 */
function custodyAmount(address, info, mint, authority) {
  /** SPL 解码器校验数据账户归属经典 SPL Token。 The SPL decoder checks classic token program ownership. */
  const account = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  assert.ok(account.isInitialized && !account.isFrozen && !account.isNative && !account.delegate
    && !account.closeAuthority && account.mint.equals(mint) && account.owner.equals(authority),
  `Unexpected token or authority at ${address.toBase58()}.`);
  return account.amount.toString();
}

/**
 * 读取多个公钥组成的账户正文前缀。
 * Read the leading public keys from an account body.
 * @param {Buffer} body 去掉判别符的账户正文。 Account body without its discriminator.
 * @param {number} count 公钥数量。 Number of public keys to read.
 */
function leadingKeys(body, count) {
  return Array.from({ length: count }, (_, index) =>
    new PublicKey(body.subarray(index * keyBytes, (index + 1) * keyBytes)));
}

/** 核对目标租金账户尚未分配空间，允许 PDA 在初始化前收到 SOL。 Require an unallocated rent account while accepting SOL prefunding of the PDA. */
function isUnallocated(account) {
  return account === null || (!account.executable && account.owner.equals(SystemProgram.programId)
    && account.data.length === 0);
}

/** 核对部署并按命令选项查询或初始化策略。 Verify the deployment and inspect or initialize strategy as requested. */
async function main() {
  /** 选择目标测试网络、明确资产和可选写入权限。 Select the test network, explicit mints, and optional write authorization. */
  const { values: options } = parseArgs({ options: {
    network: { type: 'string' },
    'rpc-url': { type: 'string' },
    'asset-mint': { type: 'string' },
    'strategy-mint': { type: 'string' },
    manager: { type: 'string' },
    'reserve-bps': { type: 'string' },
    'lending-cap-bps': { type: 'string' },
    'max-trade-bps': { type: 'string' },
    'admin-keypair': { type: 'string' },
    execute: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (options.help) {
    console.log(usage);
    return;
  }
  assert.ok((options.network === 'localnet' || options.network === 'devnet')
    && options['rpc-url'] && options['asset-mint'] && options['strategy-mint'], usage);
  /** 可选预期设置。执行交易时必须明示所有初始化参数。 Optional expected settings. Execution requires all initializer inputs. */
  const settings = parseSettings(options);
  assert.ok(!options.execute || (settings && options['admin-keypair']), usage);
  assert.ok(options.execute || !options['admin-keypair'], 'A keypair is only needed with --execute.');

  /** 在读取任何签名文件前核对 RPC 地址和创世哈希。 Verify the RPC address and genesis hash before accessing any signing file. */
  const endpoint = new URL(options['rpc-url']);
  const isLocal = options.network === 'localnet';
  assert.ok(isLocal
    ? endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    : endpoint.protocol === 'https:', 'Use an HTTP loopback RPC for Localnet or an HTTPS RPC for Devnet.');
  const connection = new Connection(endpoint.href, commitment);
  const genesisHash = await connection.getGenesisHash();
  assert.ok(isLocal ? !Object.values(publicGenesis).includes(genesisHash) : genesisHash === publicGenesis.devnet,
    'The RPC genesis hash does not match --network.');

  /** 两个程序的编译版本与初始化指令 ABI。 Compiled versions of both programs and the initializer ABI. */
  const [vaultIdl, lendingIdl] = await Promise.all([vaultIdlPath, lendingIdlPath]
    .map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  const initialize = vaultIdl.instructions.find(({ name }) => name === 'initialize_vault_strategy');
  assert.ok(initialize?.discriminator.length === 8, 'Build the current vault program IDL before running this script.');
  assert.deepEqual(initialize.args.map(({ name, type }) => [name, type]),
    [['manager', 'pubkey'], ['reserve_bps', 'u16'], ['lending_cap_bps', 'u16'], ['max_trade_bps', 'u16']],
    'Unexpected strategy initializer arguments in the built IDL.');
  const vaultProgram = new PublicKey(vaultIdl.address);
  const lendingProgram = new PublicKey(lendingIdl.address);
  /** 初始化指令中的跨程序种子应与本地构建的借贷程序一致。 Cross-program seeds in the initializer must match the built lending program. */
  const marketProgram = initialize.accounts.find(({ name }) => name === 'market')?.pda?.program;
  assert.ok(marketProgram?.kind === 'const' && new PublicKey(marketProgram.value).equals(lendingProgram),
    'Vault and lending IDLs refer to different lending program addresses.');

  /** 结算及策略使用与市场绑定的两枚独立测试 Mint。 Settlement and spot use the two distinct test mints bound to the market. */
  const assetMint = new PublicKey(options['asset-mint']);
  const spotMint = new PublicKey(options['strategy-mint']);
  assert.ok(!assetMint.equals(spotMint) && !assetMint.equals(NATIVE_MINT) && !spotMint.equals(NATIVE_MINT),
    'Settlement and spot must use distinct non-native SPL Token mints.');
  /** 金库及其现金、份额、策略和市场账户。 Vault and its cash, share, strategy, and market accounts. */
  const [vault, vaultBump] = derive(vaultProgram, 'vault');
  const [cashVault] = derive(vaultProgram, 'cash_vault', vault);
  const [shareMint] = derive(vaultProgram, 'share_mint', vault);
  const [strategy, strategyBump] = derive(vaultProgram, 'strategy', vault);
  const [strategyCustody] = derive(vaultProgram, 'strategy_custody', strategy);
  const [swapCash] = derive(vaultProgram, 'swap_cash', strategy);
  const [swapStrategy] = derive(vaultProgram, 'swap_strategy', strategy);
  const [market, marketBump] = derive(lendingProgram, 'lending_market');
  const [oracle] = derive(lendingProgram, 'mock_collateral_price', market);

  /** 同一最终确认 slot 中观测所有绑定与兑换余额。 Observe all bindings and exchange balances at one finalized slot. */
  const sampleKeys = [vaultProgram, lendingProgram, vault, market, assetMint, spotMint,
    strategy, strategyCustody, swapCash, swapStrategy];

  /**
   * 验证两份部署、已有金库和借贷市场，以及策略启用后的绑定和余额。
   * Verify both deployments, the existing vault and market, and the active strategy's bindings and balances.
   * @param {number} [minContextSlot] 可选的最终确认读回下界。 Optional minimum finalized slot for verification.
   */
  async function inspect(minContextSlot) {
    /** 同一 slot 的账户列表，顺序与上方请求一致。 Accounts at a common slot, in request order. */
    const { context, value } = await connection.getMultipleAccountsInfoAndContext(sampleKeys, { commitment, minContextSlot });
    const [vaultCode, lendingCode, vaultState, marketState, cashMintInfo, spotMintInfo, ...strategyAccounts] = value;
    const [config, custody, reserveCash, reserveSpot] = strategyAccounts;
    assert.ok(vaultCode?.executable && lendingCode?.executable, 'Deploy both programs on the target test network first.');

    /** 原始金库正文含四个公钥和 bump，激活策略后扩展一字节。 The original vault stores four keys and its bump; activation adds one byte. */
    const legacyVaultLength = 4 * keyBytes + 1;
    const vaultData = accountBody(vaultState, vaultProgram, vaultIdl, 'Vault', [legacyVaultLength, legacyVaultLength + 1]);
    const [administrator, vaultMint, vaultCash, vaultShares] = leadingKeys(vaultData, 4);
    assert.ok(vaultMint.equals(assetMint) && vaultCash.equals(cashVault) && vaultShares.equals(shareMint)
      && vaultData[legacyVaultLength - 1] === vaultBump, 'The vault does not match the requested settlement mint or its canonical accounts.');

    /** 市场正文含管理员、代币和托管公钥及 bump。 The market body holds administrator, mint and custody keys plus its bump. */
    const marketData = accountBody(marketState, lendingProgram, lendingIdl, 'LendingMarket', [5 * keyBytes + 1]);
    const [, marketDebt, marketCollateral, marketCash, marketCollateralVault] = leadingKeys(marketData, 5);
    assert.ok(marketDebt.equals(assetMint) && marketCollateral.equals(spotMint)
      && marketCash.equals(derive(lendingProgram, 'cash_vault', market)[0])
      && marketCollateralVault.equals(derive(lendingProgram, 'collateral_vault', market)[0])
      && marketData[5 * keyBytes] === marketBump, 'The market must match the requested mint pair and its canonical accounts.');
    /** 两枚现有 Mint 的经典 SPL 布局和金额精度。 Classic SPL layout and amount precision of the existing mints. */
    const cash = unpackMint(assetMint, cashMintInfo, TOKEN_PROGRAM_ID);
    const spot = unpackMint(spotMint, spotMintInfo, TOKEN_PROGRAM_ID);
    assert.ok(cash.isInitialized && cash.decimals === cashDecimals && spot.isInitialized && spot.decimals === strategyDecimals,
      'The settlement and spot mints must be initialized with six and nine decimals.');

    if (vaultData.length === legacyVaultLength) {
      assert.ok(strategyAccounts.every(isUnallocated), 'Unexpected accounts are allocated at the inactive strategy addresses.');
      return { administrator, slot: context.slot, configuration: null, reserveBalances: null };
    }

    /** 配置正文含四个公钥、三个 u16 基点参数和 bump。 Strategy state holds four keys, three u16 basis-point parameters, and its bump. */
    const ratiosStart = 4 * keyBytes;
    const configData = accountBody(config, vaultProgram, vaultIdl, 'VaultStrategy', [ratiosStart + 7]);
    const [configuredVault, manager, configuredSpot, configuredMarket] = leadingKeys(configData, 4);
    const configuration = {
      manager: manager.toBase58(),
      reserveBps: configData.readUInt16LE(ratiosStart),
      lendingCapBps: configData.readUInt16LE(ratiosStart + 2),
      maxTradeBps: configData.readUInt16LE(ratiosStart + 4),
    };
    assert.ok(configuredVault.equals(vault) && configuredSpot.equals(spotMint) && configuredMarket.equals(market)
      && configData[ratiosStart + 6] === strategyBump && !manager.equals(PublicKey.default)
      && configuration.reserveBps <= fullBps && configuration.lendingCapBps <= fullBps
      && configuration.maxTradeBps > 0 && configuration.maxTradeBps <= fullBps, 'Unexpected active strategy configuration.');
    custodyAmount(strategyCustody, custody, spotMint, vault);
    if (settings) assert.deepEqual(configuration, settings, 'The active configuration differs from the requested settings.');
    return { administrator, slot: context.slot, configuration, reserveBalances: {
      cashBaseUnits: custodyAmount(swapCash, reserveCash, assetMint, strategy),
      strategyBaseUnits: custodyAmount(swapStrategy, reserveSpot, spotMint, strategy),
    } };
  }

  /** 现有链上配置和首次初始化的确认信息。 On-chain configuration and first-initialization confirmation details. */
  let current = await inspect();
  let signature = null;
  if (!current.configuration && options.execute) {
    /** 仅首次执行时加载管理员密钥，并按原金库状态校验其身份。 Load the administrator key only on first execution and match the existing vault. */
    const admin = await readAdministrator(options['admin-keypair']);
    assert.ok(admin.publicKey.equals(current.administrator), 'The supplied signer is not the vault administrator.');
    const payer = await connection.getAccountInfo(admin.publicKey, { commitment, minContextSlot: current.slot });
    assert.ok(payer && !payer.executable && payer.owner.equals(SystemProgram.programId) && payer.lamports > 0,
      'The vault administrator needs a funded system wallet to pay transaction fees and account rent.');

    /** 指令账户对应当前部署，读写和签名属性来自构建版本。 Instruction accounts correspond to the current deployment. Mutability and signers come from the build. */
    const addresses = {
      administrator: admin.publicKey, vault, strategy, asset_mint: assetMint, strategy_mint: spotMint, market,
      strategy_custody: strategyCustody, swap_cash: swapCash, swap_strategy: swapStrategy,
      token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
    };
    const keys = initialize.accounts.map(({ name, writable, signer }) => {
      assert.ok(Object.hasOwn(addresses, name), `Unknown initialize_vault_strategy account: ${name}`);
      return { pubkey: addresses[name], isSigner: signer === true, isWritable: writable === true };
    });
    /** Borsh 参数先写管理者公钥，随后写三个小端 u16 基点。 Borsh arguments start with the manager key, followed by three little-endian u16 basis-point values. */
    const ratios = Buffer.alloc(6);
    ratios.writeUInt16LE(settings.reserveBps, 0);
    ratios.writeUInt16LE(settings.lendingCapBps, 2);
    ratios.writeUInt16LE(settings.maxTradeBps, 4);
    const data = Buffer.concat([Buffer.from(initialize.discriminator), new PublicKey(settings.manager).toBuffer(), ratios]);
    /** 管理员为单笔交易签名，同时支付 SOL 手续费和新增账户租金。 The administrator signs the transaction and pays both SOL fees and rent for new accounts. */
    const lifetime = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ ...lifetime, feePayer: admin.publicKey })
      .add(new TransactionInstruction({ programId: vaultProgram, keys, data }));
    transaction.sign(admin);
    signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed' });
    try {
      /** 最终确认后读回同一 slot 或更新的配置。 After finalization, read back the configuration at that slot or later. */
      const confirmed = await connection.confirmTransaction({ ...lifetime, signature }, commitment);
      assert.equal(confirmed.value.err, null, 'Strategy initialization did not succeed.');
      current = await inspect(confirmed.context.slot);
      assert.ok(current.configuration, 'The finalized transaction did not produce a readable strategy configuration.');
    } catch (error) {
      throw new Error(`Strategy initialization transaction ${signature}: ${error.message}`, { cause: error });
    }
  }

  console.log(JSON.stringify({
    status: signature ? 'initialized' : current.configuration ? 'already-initialized' : 'not-initialized',
    network: options.network,
    observedSlot: current.slot,
    vaultProgram: vaultProgram.toBase58(),
    lendingProgram: lendingProgram.toBase58(),
    administrator: current.administrator.toBase58(),
    vault: vault.toBase58(),
    strategy: strategy.toBase58(),
    assetMint: assetMint.toBase58(),
    strategyMint: spotMint.toBase58(),
    market: market.toBase58(),
    oracle: oracle.toBase58(),
    strategyCustody: strategyCustody.toBase58(),
    swapCash: swapCash.toBase58(),
    swapStrategy: swapStrategy.toBase58(),
    configuration: current.configuration,
    proposedConfiguration: current.configuration ? null : settings,
    reserveBalances: current.reserveBalances,
    signature,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message || error.name);
  process.exitCode = 1;
}

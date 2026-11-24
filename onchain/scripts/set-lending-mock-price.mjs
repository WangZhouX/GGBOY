import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

/** 工作区构建出的 Anchor 借贷 ABI。 Anchor lending ABI built by this workspace. */
const idlPath = new URL('../target/idl/ggboy_lending.json', import.meta.url);
/** 使用最终确认的市场和价格，交易模拟使用已确认的近期区块哈希。 Use finalized market and price state and a recent confirmed blockhash for preflight. */
const commitment = 'finalized';
/** 经典升级加载器和公共网络创世哈希用于核对部署及 RPC。 The classic upgradeable loader and public genesis hashes identify deployments and RPC clusters. */
const upgradeableLoader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const genesisHashes = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
/** 每 1 整单位 tSOL 的 mockUSDC 价格精度和账户整数边界。 Precision of the mockUSDC price per whole tSOL and its on-chain integer bound. */
const decimals = 6;
const priceScale = 10n ** BigInt(decimals);
const maxRawPrice = (1n << 64n) - 1n;
/** 发布需要显式金额和本地管理员密钥，查询只需要公开的市场绑定。 Publishing requires an explicit price and administrator keypair. Inspection requires only the public market bindings. */
const usage = [
  'Usage: node set-lending-mock-price.mjs --network <devnet|localnet> --rpc-url <url>',
  '  --debt-mint <address> --collateral-mint <address> [--program-id <address>]',
  '  Either --read-only or --admin-keypair <file> --price <positive mockUSDC per tSOL>',
].join('\n');

/**
 * 读取 Solana CLI 的管理员密钥文件，并保持错误信息不含密钥内容。
 * Read a Solana CLI administrator keypair without including its contents in diagnostics.
 * @param {string} path 密钥文件本地路径。 Local keypair path.
 * @returns {Promise<Keypair>} 已核验的交易签名人。 Validated transaction signer.
 */
async function readAdministrator(path) {
  try {
    /** Solana CLI 密钥对由 64 个无符号字节组成。 A Solana CLI keypair contains 64 unsigned bytes. */
    const bytes = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Array.isArray(bytes) && bytes.length === 64 && bytes.every((byte) =>
      Number.isInteger(byte) && byte >= 0 && byte <= 255));
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new Error('Cannot read a valid Solana CLI keypair from --admin-keypair.');
  }
}

/**
 * 将输入单价精确转换成程序使用的正 u64。
 * Convert the decimal price exactly to a positive u64 used by the program.
 * @param {string} source 每 1 整单位 tSOL 对应的 mockUSDC 十进制字符串。 Decimal mockUSDC per whole tSOL.
 * @returns {bigint} 每 1 整单位 tSOL 对应的 mockUSDC 最小单位。 mockUSDC base units per whole tSOL.
 */
function parsePrice(source) {
  assert.match(source, /^(0|[1-9]\d{0,13})(?:\.\d{1,6})?$/,
    'Use a positive decimal price with at most six fractional digits.');
  /** 分割整数字符和小数字符，价格全程避免使用浮点数。 Split whole and fractional digits to avoid floating point. */
  const [whole, fraction = ''] = source.split('.');
  const raw = BigInt(whole) * priceScale + BigInt(fraction.padEnd(decimals, '0'));
  assert.ok(raw > 0n && raw <= maxRawPrice, 'The price must be a positive u64 in mockUSDC base units.');
  return raw;
}

/**
 * 核验实际程序、规范市场以及管理员、Mint 和托管地址绑定。
 * Validate the executable program, canonical market, and administrator, mint, and custody bindings.
 * @param {object} target 由 ABI 与显式参数确定的规范市场账户和判别符。 Canonical market accounts and discriminator determined by the ABI and explicit inputs.
 * @param {Array} accounts 同一最终确认 slot 的程序、市场与 Mint 账户。 Program, market, and mint accounts at one finalized slot.
 * @returns {PublicKey} 市场状态里已经登记的管理员公钥。 Administrator recorded in the market state.
 */
function verifyMarket(target, [program, marketInfo, debtInfo, collateralInfo]) {
  const { programId, market, marketBump, marketDiscriminator, debtMint, collateralMint } = target;
  assert.ok(program?.executable && program.owner.equals(upgradeableLoader), 'The expected lending program is not deployed.');
  assert.ok(marketInfo && !marketInfo.executable && marketInfo.owner.equals(programId), 'The expected lending market is not initialized.');

  /** 市场布局依序保存判别符、五个公钥和 PDA bump。 The market layout holds the discriminator, five public keys, and the PDA bump in order. */
  const data = marketInfo.data;
  assert.ok(data.length === 169 && data.subarray(0, 8).equals(marketDiscriminator) && data[168] === marketBump,
    'The market state has an unexpected layout or PDA bump.');
  const [cashVault] = PublicKey.findProgramAddressSync([Buffer.from('cash_vault'), market.toBuffer()], programId);
  const [collateralVault] = PublicKey.findProgramAddressSync([Buffer.from('collateral_vault'), market.toBuffer()], programId);
  const expectedKeys = [debtMint, collateralMint, cashVault, collateralVault];
  for (const [index, expected] of expectedKeys.entries()) {
    /** 管理员占第一个公钥，资产和托管地址从第二个公钥开始。 The first key is the administrator, followed by the mint and custody keys. */
    const offset = 40 + index * 32;
    assert.ok(new PublicKey(data.subarray(offset, offset + 32)).equals(expected),
      'The supplied mints or derived custody addresses do not match this market.');
  }

  // 价格单位绑定经典 SPL mockUSDC 的六位精度，抵押 Mint 必须已初始化。
  // Price units depend on a classic six-decimal SPL mockUSDC mint and an initialized collateral mint.
  const debt = unpackMint(debtMint, debtInfo, TOKEN_PROGRAM_ID);
  const collateral = unpackMint(collateralMint, collateralInfo, TOKEN_PROGRAM_ID);
  assert.ok(debt.isInitialized && debt.decimals === decimals && collateral.isInitialized,
    'Both registered mints must be initialized, with six decimals on the debt mint.');
  return new PublicKey(data.subarray(8, 40));
}

/**
 * 从规范价格账户核验所属市场及价格发布时间。
 * Check the market binding and publication time of the canonical price account.
 * @param {object} target 规范市场、程序和价格判别符。 Canonical market, program, and price discriminator.
 * @param {object|null} account 同一最终确认观测中的价格 PDA。 Price PDA sampled at the same finalized commitment.
 * @returns {{priceRaw: bigint, publishedAt: string}|null} 价格及 UTC 发布时间，未发布时为空。 Price and UTC publication time, or null if unpublished.
 */
function decodePrice({ programId, market, priceDiscriminator }, account) {
  if (!account || (!account.executable && account.owner.equals(SystemProgram.programId) && account.data.length === 0)) {
    return null;
  }

  /** 价格布局为判别符、市场公钥、u64 价格和 i64 Unix 秒。 Price layout consists of the discriminator, market key, u64 price, and i64 Unix seconds. */
  const data = account.data;
  assert.ok(!account.executable && account.owner.equals(programId) && data.length === 56
    && data.subarray(0, 8).equals(priceDiscriminator) && new PublicKey(data.subarray(8, 40)).equals(market),
  'The canonical mock price account has an unexpected owner, layout, or market binding.');
  const priceRaw = data.readBigUInt64LE(40);
  const unixSeconds = data.readBigInt64LE(48);
  assert.ok(priceRaw > 0n && unixSeconds > 0n && unixSeconds <= 8_640_000_000_000n,
    'The stored price or publication time is invalid.');
  return { priceRaw, publishedAt: new Date(Number(unixSeconds) * 1000).toISOString() };
}

/**
 * 发布显式测试价格，失败时保留已提交的公开签名供核对。
 * Publish the explicit test price and preserve the public signature for rechecking post-submission failures.
 * @returns {Promise<void>} 在标准输出打印最终确认的价格和公开地址。 Report finalized price and public addresses as JSON.
 */
async function main() {
  /** 解析可以明确区别查询和发布的命令参数。 Parse command arguments that distinguish inspection from publishing. */
  const { values: options } = parseArgs({ options: {
    network: { type: 'string' },
    'rpc-url': { type: 'string' },
    'admin-keypair': { type: 'string' },
    'debt-mint': { type: 'string' },
    'collateral-mint': { type: 'string' },
    'program-id': { type: 'string' },
    price: { type: 'string' },
    'read-only': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (options.help) {
    console.log(usage);
    return;
  }

  /** 只读不接受密钥或价格，以免操作模式含糊。 Reject keypair and price inputs during inspection to keep its mode explicit. */
  const readOnly = options['read-only'] === true;
  assert.ok((options.network === 'localnet' || options.network === 'devnet')
    && options['rpc-url'] && options['debt-mint'] && options['collateral-mint']
    && (readOnly ? !options.price && !options['admin-keypair'] : options.price && options['admin-keypair']), usage);
  const priceRaw = readOnly ? null : parsePrice(options.price);

  // 明确限制到测试网络，并在读取签名密钥前检查 RPC 创世哈希。
  // Restrict operations to test environments and verify the RPC genesis hash before loading the signer.
  const endpoint = new URL(options['rpc-url']);
  const localnet = options.network === 'localnet';
  assert.ok(localnet
    ? endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
    : endpoint.protocol === 'https:', 'Use an HTTP loopback RPC for Localnet or an HTTPS RPC for Devnet.');
  const connection = new Connection(endpoint.href, { commitment, disableRetryOnRateLimit: true });
  const genesis = await connection.getGenesisHash();
  assert.ok(localnet ? !Object.values(genesisHashes).includes(genesis) : genesis === genesisHashes.devnet,
    'The RPC genesis hash does not match --network.');

  /** 从 ABI 核对程序地址、指令参数与账户判别符。 Verify the program address, instruction parameters, and account discriminators against the ABI. */
  const idl = JSON.parse(await readFile(idlPath, 'utf8'));
  const programId = new PublicKey(options['program-id'] ?? idl.address);
  assert.equal(programId.toBase58(), idl.address, 'The program ID does not match the built lending IDL.');
  const instruction = idl.instructions.find(({ name }) => name === 'set_mock_collateral_price');
  const marketDefinition = idl.accounts.find(({ name }) => name === 'LendingMarket');
  const priceDefinition = idl.accounts.find(({ name }) => name === 'MockCollateralPrice');
  assert.ok(instruction?.discriminator.length === 8 && instruction.args.length === 1
    && instruction.args[0].name === 'price_raw' && instruction.args[0].type === 'u64'
    && marketDefinition?.discriminator.length === 8 && priceDefinition?.discriminator.length === 8,
  'Build the lending program with the mock price instruction and accounts before running this command.');

  /** 市场已登记的两枚不同测试 Mint 公钥。 Distinct test mint keys registered to the market. */
  const debtMint = new PublicKey(options['debt-mint']);
  const collateralMint = new PublicKey(options['collateral-mint']);
  assert.ok(!debtMint.equals(collateralMint) && !debtMint.equals(NATIVE_MINT) && !collateralMint.equals(NATIVE_MINT),
    'Debt and collateral must use distinct non-native SPL Token mints.');

  /** 价格 PDA 绑定程序的规范市场。同批观测避免混用 RPC slot。 The price PDA belongs to the canonical market. Read the same batch to avoid mixing RPC slots. */
  const [market, marketBump] = PublicKey.findProgramAddressSync([Buffer.from('lending_market')], programId);
  const [mockPrice] = PublicKey.findProgramAddressSync([Buffer.from('mock_collateral_price'), market.toBuffer()], programId);
  const target = {
    programId, market, marketBump, debtMint, collateralMint,
    marketDiscriminator: Buffer.from(marketDefinition.discriminator),
    priceDiscriminator: Buffer.from(priceDefinition.discriminator),
  };
  const sampleKeys = [programId, market, debtMint, collateralMint, mockPrice];
  let sample = await connection.getMultipleAccountsInfoAndContext(sampleKeys, { commitment });
  let marketAdministrator = verifyMarket(target, sample.value);
  let observed = decodePrice(target, sample.value[4]);

  /** 公开交易签名及最终确认 slot 仅在发布时填入。 Public transaction signature and finalized slot are populated only when publishing. */
  let signature = null;
  let confirmationSlot = null;
  if (!readOnly) {
    /** 价格更新必须与初始化时保存的市场管理员匹配。 Publication requires the administrator recorded by market initialization. */
    const signer = await readAdministrator(options['admin-keypair']);
    assert.ok(marketAdministrator.equals(signer.publicKey), 'The signer does not match the recorded market administrator.');
    const addresses = { administrator: signer.publicKey, market, mock_collateral_price: mockPrice, system_program: SystemProgram.programId };
    const keys = instruction.accounts.map(({ name, writable, signer: isSigner }) => {
      assert.ok(Object.hasOwn(addresses, name), 'The built IDL lists an unknown mock price instruction account.');
      return { pubkey: addresses[name], isWritable: writable === true, isSigner: isSigner === true };
    });

    /** 指令参数是判别符后的八字节小端 u64。 The instruction argument is an eight-byte little-endian u64 after the discriminator. */
    const data = Buffer.alloc(16);
    Buffer.from(instruction.discriminator).copy(data);
    data.writeBigUInt64LE(priceRaw, 8);
    const minContextSlot = sample.context.slot;
    const { value: lifetime } = await connection.getLatestBlockhashAndContext({ commitment: 'confirmed', minContextSlot });
    const transaction = new Transaction({ ...lifetime, feePayer: signer.publicKey }).add(
      new TransactionInstruction({ programId, keys, data }),
    );
    transaction.sign(signer);
    signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed', minContextSlot });
    try {
      /** 确认价格写入后，从不早于确认位置的 slot 读回验证。 After finalization, verify the on-chain price at or after the confirmation slot. */
      const confirmation = await connection.confirmTransaction({ ...lifetime, signature }, commitment);
      assert.equal(confirmation.value.err, null, 'The on-chain mock price update failed.');
      confirmationSlot = confirmation.context.slot;
      sample = await connection.getMultipleAccountsInfoAndContext(sampleKeys, { commitment, minContextSlot: confirmationSlot });
      marketAdministrator = verifyMarket(target, sample.value);
      observed = decodePrice(target, sample.value[4]);
      assert.equal(observed?.priceRaw, priceRaw, 'The latest finalized price differs from this update.');
    } catch (error) {
      throw new Error('Mock price transaction ' + signature + ': ' + error.message, { cause: error });
    }
  }

  // 只输出公共链上数据。价格保留无损最小单位字符串，时间统一为 UTC。
  // Report only public on-chain data. Preserve the exact price as a base-unit string and use UTC for time.
  console.log(JSON.stringify({
    status: readOnly ? observed ? 'published' : 'unpublished' : 'updated',
    network: options.network,
    programId: programId.toBase58(),
    market: market.toBase58(),
    administrator: marketAdministrator.toBase58(),
    priceAccount: mockPrice.toBase58(),
    debtMint: debtMint.toBase58(),
    collateralMint: collateralMint.toBase58(),
    priceDecimals: decimals,
    priceRaw: observed?.priceRaw.toString() ?? null,
    publishedAt: observed?.publishedAt ?? null,
    signature,
    confirmationSlot,
    observedSlot: sample.context.slot,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message || error.name);
  process.exitCode = 1;
}

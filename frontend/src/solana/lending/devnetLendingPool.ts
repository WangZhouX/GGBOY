import {
  ACCOUNT_SIZE, AccountLayout, AccountState, MINT_SIZE, NATIVE_MINT, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, unpackAccount, unpackMint,
} from '@solana/spl-token';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { devnetRpcUrl } from '../getDevnetSolBalance';

/** Devnet 借贷程序及其可升级加载器的公开地址。 Public addresses of the Devnet lending program and its upgradeable loader. */
const programId = new PublicKey('8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H');
const upgradeableLoader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/** 借贷账户的规范 PDA 与 bump，由链上程序中的固定种子派生。 Canonical lending PDAs and bump derived from the on-chain program's fixed seeds. */
const encoder = new TextEncoder();
const [marketAddress, marketBump] = PublicKey.findProgramAddressSync([encoder.encode('lending_market')], programId);
const [cashVault] = PublicKey.findProgramAddressSync([encoder.encode('cash_vault'), marketAddress.toBytes()], programId);
const [collateralVault] = PublicKey.findProgramAddressSync([encoder.encode('collateral_vault'), marketAddress.toBytes()], programId);
/** 市场只对应一个出借记账账户，首笔出借时才在链上创建。 A market has one supply ledger, created on its first supply. */
const [supplyPool] = PublicKey.findProgramAddressSync([encoder.encode('supply_pool'), marketAddress.toBytes()], programId);
/** 借款总账和受市场管理员控制的测试价格各自使用独立 PDA。 The debt ledger and administrator-controlled test price each use a separate PDA. */
const [borrowMarket] = PublicKey.findProgramAddressSync([encoder.encode('borrow_market'), marketAddress.toBytes()], programId);
const [mockCollateralPrice] = PublicKey.findProgramAddressSync([encoder.encode('mock_collateral_price'), marketAddress.toBytes()], programId);

/** 市场页匹配登记项时使用的 Devnet 公开地址。 Public Devnet addresses used to match a market registry entry. */
export const devnetLendingPool = { programId: programId.toBase58(), marketAddress: marketAddress.toBase58() } as const;
/** 来自 LendingMarket IDL 的 Anchor 判别符及 Rust 状态结构的固定字节位置。 Anchor discriminator from the LendingMarket IDL and fixed offsets from the Rust state structure. */
const marketDiscriminator = [246, 114, 50, 98, 72, 157, 28, 120];
const marketLayout = { debtMint: 40, collateralMint: 72, cashVault: 104, collateralVault: 136, bump: 168, length: 169 } as const;
/** 单次 Devnet RPC 请求的最长等待时间，单位为毫秒。 Time budget for one Devnet RPC request in milliseconds. */
const readTimeoutMs = 12_000;
/** 当前版本的借款 Mint 由链上初始化指令限定为六位小数。 The current on-chain initializer requires six decimal places for the debt mint. */
const debtMintDecimals = 6;
/** 出借仓位的链上份额精度，单位为小数位数。 On-chain supply share precision in decimal places. */
export const lendingShareDecimals = 6;
/** 出借账户的判别符及字段偏移，取自链上程序的 IDL 与 Rust 状态。 Supply account discriminators and offsets from the program IDL and Rust state. */
const supplyPoolDiscriminator = [238, 91, 229, 152, 53, 213, 165, 153];
const supplyPoolLayout = { accountedAssets: 40, totalShares: 48, length: 56 } as const;
const supplyPositionDiscriminator = [248, 221, 250, 222, 37, 167, 64, 209];
const supplyPositionLayout = { supplier: 40, shares: 72, length: 80 } as const;
/** 借款账户判别符来自 Anchor，偏移量对应链上 Rust 状态的序列化顺序。 Anchor borrow account discriminators and offsets follow the serialized Rust state. */
const borrowMarketDiscriminator = [148, 133, 18, 242, 248, 66, 156, 99];
const borrowMarketLayout = { totalDebt: 40, length: 48 } as const;
const borrowPositionDiscriminator = [243, 140, 20, 139, 32, 243, 114, 55];
const borrowPositionLayout = { borrower: 40, collateral: 72, debt: 80, length: 88 } as const;
const mockPriceDiscriminator = [21, 63, 245, 69, 219, 1, 9, 14];
const mockPriceLayout = { price: 40, publishedAt: 48, length: 56 } as const;
/** 借贷 PDA 的市场公钥占据判别符之后的 32 字节。 Lending PDAs store their market key in the 32 bytes after the discriminator. */
const lendingMarketField = { start: 8, end: 40 } as const;
/** Clock 系统账户的归属与 Unix 时间戳字节位置。 Clock sysvar ownership and serialized Unix timestamp offset. */
const sysvarProgramId = new PublicKey('Sysvar1111111111111111111111111111111111111');
const clockLayout = { unixTimestamp: 32, length: 40 } as const;

/** 后端市场目录中的资产配置，读取时与链上账户复核。 Asset configuration from the market registry, checked against on-chain accounts. */
export interface RegisteredPoolAssets {
  /** 借款资产的 Mint 公钥和小数位数。 Public key and decimal places of the debt mint. */
  debtAsset: { mint: string; decimals: number };
  /** 抵押资产的 Mint 公钥和小数位数。 Public key and decimal places of the collateral mint. */
  collateralAsset: { mint: string; decimals: number };
}

/** 同一个已最终确认 slot 读取到的池内现金。 Pool cash read at one finalized slot. */
interface DevnetLendingCash {
  /** RPC 响应中的最终确认 slot。 Finalized slot from the RPC response. */
  slot: number;
  /** 池内现金，单位为六位小数借款 Mint 的最小单位。 Pool cash in base units of the six-decimal debt mint. */
  cashRaw: bigint;
}

/** 同一个最终确认 slot 的现金、出借记账和钱包仓位。 Cash, supply accounting, and the wallet position at one finalized slot. */
export interface DevnetLendingSupply extends DevnetLendingCash {
  /** 已计入出借定价的资产，单位为借款 Mint 最小单位。 Assets counted toward supply pricing, in debt mint base units. */
  accountedAssetsRaw: bigint;
  /** 借贷池总出借份额，单位为出借份额最小单位。 Total pool supply shares in share base units. */
  totalSharesRaw: bigint;
  /** 池中未偿还的本金，按借款 Mint 最小单位计。 Outstanding principal recorded in debt mint base units. */
  totalDebtRaw: bigint;
  /** 当前钱包持有的出借份额，未建仓时为零。 Supply shares of this wallet in base units, zero before the position exists. */
  sharesRaw: bigint;
  /** 当前钱包关联代币账户可用于出借的最小单位金额，缺失或被冻结时为零。 Spendable wallet ATA balance in mint base units, zero when missing or frozen. */
  walletAssetRaw: bigint;
  /** 关联代币账户是否被冻结。 Whether the wallet ATA is frozen. */
  walletAssetFrozen: boolean;
  /** 当前钱包是否已经建立链上出借仓位。 Whether the wallet already has an on-chain supply position. */
  positionExists: boolean;
  /** 客户端收到该最终确认样本的 UTC 时间。 UTC time when the client received this finalized observation. */
  observedAt: string;
}

/** 可刷新至已确认交易的 slot，并在切换钱包时取消读链。 Options to refresh at or after a transaction slot and cancel when the wallet changes. */
export interface LendingReadOptions {
  /** 请求取消信号，会传给底层 HTTP。 Cancellation signal forwarded to the underlying HTTP request. */
  signal?: AbortSignal;
  /** 可以接受的最早观测 slot，通常来自已最终确认的交易。 Earliest acceptable observation slot, usually from a finalized transaction. */
  minContextSlot?: number;
}

/**
 * 取得借贷出借指令的市场、公用账户及钱包仓位地址。
 * Resolve the market, pool accounts, and wallet position addresses for a supply.
 *
 * @param walletAddress Phantom 出借人的 Base58 公钥。 Phantom supplier's Base58 public key.
 * @returns 规范 PDA 与出借人公钥。 Canonical PDAs and the supplier public key.
 */
export function devnetLendingSupplyAddresses(walletAddress: string) {
  /** 个人仓位按市场与钱包隔离，避免不同出借人共用份额。 Position seeds separate balances by market and supplier. */
  const supplier = new PublicKey(walletAddress);
  const [supplyPosition] = PublicKey.findProgramAddressSync([
    encoder.encode('supply_position'), marketAddress.toBytes(), supplier.toBytes(),
  ], programId);
  return { programId, marketAddress, cashVault, supplyPool, supplyPosition, supplier };
}

/**
 * 派生借款指令和查询共用的市场账户与钱包仓位。
 * Derive the market accounts and wallet position used by borrow instructions and reads.
 *
 * @param walletAddress 已连接钱包的 Base58 公钥。 Connected wallet Base58 public key.
 * @returns 地址都由部署程序和规范 PDA 种子派生。 All addresses follow the deployment and canonical PDA seeds.
 */
export function devnetLendingBorrowAddresses(walletAddress: string) {
  /** 借款仓位由市场和个人钱包共同派生。 Derive each borrowing position from its market and wallet. */
  const borrower = new PublicKey(walletAddress);
  const [borrowPosition] = PublicKey.findProgramAddressSync([
    encoder.encode('borrow_position'), marketAddress.toBytes(), borrower.toBytes(),
  ], programId);
  return { programId, marketAddress, cashVault, collateralVault, supplyPool, borrowMarket, borrowPosition, mockCollateralPrice, borrower };
}

/**
 * 核对市场状态与已登记的 Mint、规范托管 PDA 和 bump。
 * Check market state against the registered mints, canonical custody PDAs, and bump.
 *
 * @param info RPC 返回的市场 PDA 账户元数据和原始字节。 Account metadata and raw market PDA data returned by the RPC.
 * @param debtMint 目录登记的借款资产 Mint 公钥。 Registered debt mint public key.
 * @param collateralMint 目录登记的抵押资产 Mint 公钥。 Registered collateral mint public key.
 * @throws 市场归属、布局或任一绑定不符。 When market ownership, layout, or an account binding does not match.
 */
function validateMarket(info: AccountInfo<Buffer> | null, debtMint: PublicKey, collateralMint: PublicKey) {
  if (!info || info.executable || !info.owner.equals(programId) || info.data.length !== marketLayout.length) {
    throw new Error('The Devnet lending market account has an invalid owner or layout.');
  }

  /** 按 Rust 序列化字段位置核对两种 Mint 和两个托管账户。 Verify both mints and custody accounts at their serialized Rust field offsets. */
  const { data } = info;
  if (
    !marketDiscriminator.every((byte, index) => data[index] === byte) ||
    !new PublicKey(data.subarray(marketLayout.debtMint, marketLayout.collateralMint)).equals(debtMint) ||
    !new PublicKey(data.subarray(marketLayout.collateralMint, marketLayout.cashVault)).equals(collateralMint) ||
    !new PublicKey(data.subarray(marketLayout.cashVault, marketLayout.collateralVault)).equals(cashVault) ||
    !new PublicKey(data.subarray(marketLayout.collateralVault, marketLayout.bump)).equals(collateralVault) ||
    data[marketLayout.bump] !== marketBump
  ) {
    throw new Error('The Devnet lending market does not match the registered assets or derived custodians.');
  }
}

/**
 * 确认 Mint 属于经典 SPL Token，已初始化且精度与目录一致。
 * Require a classic SPL Token mint initialized with the registered decimal precision.
 *
 * @param address 通过目录配置传入的 Mint 公钥。 Mint public key supplied by the registry.
 * @param info 与市场同一 slot 观测到的 Mint 账户。 Mint account sampled at the market slot.
 * @param decimals 目录登记的小数位数。 Registered decimal places.
 * @throws Mint 布局、归属、状态或精度无效。 When mint layout, owner, state, or decimals are invalid.
 */
function validateMint(address: PublicKey, info: AccountInfo<Buffer> | null, decimals: number) {
  if (!info || info.executable || info.data.length !== MINT_SIZE) {
    throw new Error('A lending asset does not have the classic SPL mint layout.');
  }
  /** 解码器依据指定的经典 Token 程序校验 Mint 的归属。 The decoder verifies ownership against the classic Token program. */
  const mint = unpackMint(address, info, TOKEN_PROGRAM_ID);
  if (!mint.isInitialized || mint.decimals !== decimals) {
    throw new Error('A lending asset mint does not match its registered precision.');
  }
}

/**
 * 打包读取市场基础账户与可选的业务账户，并验证共享的链上绑定。
 * Fetch common market and optional lending accounts together, then validate their shared bindings.
 *
 * @param assets 目录中的两类资产 Mint 与精度。 Mint keys and precision of the two registry assets.
 * @param lendingAccounts 需要在同一 slot 附带读取的借贷账户。 Optional lending accounts to read at the same slot.
 * @param options 底层取消信号及可接受的最早观测 slot。 Request cancellation and the earliest usable observation slot.
 * @returns 已验证的现金、观测 slot 和同批未解码的借贷账户。 Validated cash and slot plus undecoded lending accounts from the same read.
 */
async function readMarketAccounts(
  assets: RegisteredPoolAssets,
  lendingAccounts: PublicKey[],
  { signal, minContextSlot = 0 }: LendingReadOptions,
) {
  /** 登记的 Mint 必须不同，且借款 Mint 精度符合初始化指令。 Registry mints must differ, with debt precision matching the initializer. */
  const debtMint = new PublicKey(assets.debtAsset.mint);
  const collateralMint = new PublicKey(assets.collateralAsset.mint);
  if (
    assets.debtAsset.decimals !== debtMintDecimals || debtMint.equals(collateralMint) ||
    debtMint.equals(NATIVE_MINT) || collateralMint.equals(NATIVE_MINT)
  ) {
    throw new Error('The Devnet lending market has invalid registered mints.');
  }
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
    throw new Error('The minimum Devnet lending observation slot is invalid.');
  }

  /** 超时与调用方取消均终止底层 HTTP 请求。 Both timeout and caller cancellation abort the underlying HTTP request. */
  const timeout = AbortSignal.timeout(readTimeoutMs);
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const connection = new Connection(devnetRpcUrl, {
    commitment: 'finalized',
    disableRetryOnRateLimit: true,
    // 将读取的总取消信号传入 RPC 的底层 fetch。
    // Pass the combined signal into the underlying RPC fetch.
    fetch: (input, init) => fetch(input, { ...init, signal: readSignal }),
  });

  /** 同一个 RPC 响应提供市场、现金、Mint 及附加借贷账户。 One RPC response covers the market, cash, both mints, and optional lending accounts. */
  const addresses = [programId, marketAddress, cashVault, debtMint, collateralMint, ...lendingAccounts];
  const { context: { slot }, value: accounts } = await connection.getMultipleAccountsInfoAndContext(addresses, {
    commitment: 'finalized',
    minContextSlot,
  });
  if (!Number.isSafeInteger(slot) || slot < minContextSlot || accounts.length !== addresses.length) {
    throw new Error('Devnet RPC returned an invalid lending observation.');
  }

  /** 先核对市场配置及资金托管，借贷账户随后在调用方单独解码。 Validate market bindings and custody first, then decode lending accounts in the caller. */
  const [program, market, custody, debtInfo, collateralInfo, ...extra] = accounts;
  if (!program?.executable || !program.owner.equals(upgradeableLoader)) {
    throw new Error('The configured Devnet lending program is not executable under the expected loader.');
  }
  validateMarket(market, debtMint, collateralMint);
  validateMint(debtMint, debtInfo, debtMintDecimals);
  validateMint(collateralMint, collateralInfo, assets.collateralAsset.decimals);

  /** 市场 PDA 授权且绑定借款 Mint 的独立托管账户。 Independent debt mint custody controlled by the market PDA. */
  const account = decodeTokenAccount(cashVault, custody, debtMint, marketAddress);
  if (account.isFrozen || account.delegate || account.closeAuthority) {
    throw new Error('The Devnet lending cash custody does not match the market.');
  }

  readSignal.throwIfAborted();
  return { slot, cashRaw: account.amount, extra };
}

/**
 * 验证经典 SPL 代币账户及其 Mint 和持有人。
 * Validate a classic SPL token account, its mint, and its owner.
 *
 * @param address 规范现金托管或钱包关联代币账户地址。 Canonical cash custody or wallet ATA address.
 * @param info 同一 RPC 观测中返回的账户数据。 Account data from the same RPC observation.
 * @param mint 预期匹配的借款 Mint。 Expected debt mint key.
 * @param authority 市场 PDA 或签名钱包的公钥。 Public key of the market PDA or signing wallet.
 * @returns 通过校验的代币账户及最小单位余额。 Validated token account and its base-unit balance.
 */
function decodeTokenAccount(address: PublicKey, info: AccountInfo<Buffer> | null, mint: PublicKey, authority: PublicKey) {
  if (!info || info.executable || info.data.length !== ACCOUNT_SIZE) {
    throw new Error('The lending token account does not have the classic SPL account layout.');
  }

  /** 显式区分已初始化、冻结及无效状态。 Explicitly distinguish initialized, frozen, and invalid states. */
  const stateOffset = AccountLayout.offsetOf('state');
  const state = stateOffset === undefined ? undefined : info.data[stateOffset];
  if (state !== AccountState.Initialized && state !== AccountState.Frozen) {
    throw new Error('The lending token account does not have a valid initialized state.');
  }

  /** 解码器同时核对经典 SPL Token Program 归属。 The decoder also checks classic SPL Token Program ownership. */
  const account = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  if (account.isNative || !account.mint.equals(mint) || !account.owner.equals(authority)) {
    throw new Error('The lending token account does not match the expected mint or authority.');
  }
  return account;
}

/**
 * 判断账户是否尚未分配，允许已有人转入 SOL 但仍可被正常初始化的 PDA。
 * Recognize accounts that are unallocated, including PDAs prefunded with SOL but still available to initialize.
 *
 * @param info 规范 PDA 的 RPC 账户数据。 RPC account info for a canonical PDA.
 * @returns 尚无程序状态时返回真。 True when no program state exists yet.
 */
function isUnallocated(info: AccountInfo<Buffer> | null): boolean {
  return info === null || (!info.executable && info.owner.equals(SystemProgram.programId) && info.data.length === 0);
}

/**
 * 校验借贷记账或个人仓位的 Anchor 布局与市场公钥。
 * Validate a lending ledger or wallet position's Anchor layout and market binding.
 *
 * @param info 该借贷 PDA 的账户数据。 Account info for the lending PDA.
 * @param discriminator 该账户的 Anchor 判别符。 Anchor discriminator for the account type.
 * @param length 该账户的链上字节长度。 On-chain byte size of the account.
 * @returns 已验证的序列化数据，未建账时为空。 Validated serialized state, or null before creation.
 */
function readLendingAccount(
  info: AccountInfo<Buffer> | null,
  discriminator: readonly number[],
  length: number,
): Buffer | null {
  if (isUnallocated(info)) return null;
  if (!info || info.executable || !info.owner.equals(programId) || info.data.length !== length ||
    !discriminator.every((byte, index) => info.data[index] === byte) ||
    !new PublicKey(info.data.subarray(lendingMarketField.start, lendingMarketField.end)).equals(marketAddress)) {
    throw new Error('A Devnet lending account has an invalid layout or market binding.');
  }
  return info.data;
}

/**
 * 验证现金、未偿本金与池账本的关系。直接转入的额外现金不构成新的记账资产。
 * Verify cash, outstanding principal, and supply accounting. Direct cash deposits are outside the ledger.
 *
 * @param cashRaw 池的实际托管现金，按借款 Mint 最小单位。 Actual pool custody cash in debt mint base units.
 * @param poolInfo 同 slot 下池内出借账本 PDA。 Supply ledger PDA observed at the same slot.
 * @param borrowMarketInfo 同 slot 下全池借款记账 PDA。 Aggregate borrowing ledger PDA observed at the same slot.
 */
function readLendingAccounting(
  cashRaw: bigint,
  poolInfo: AccountInfo<Buffer> | null,
  borrowMarketInfo: AccountInfo<Buffer> | null,
) {
  /** 旧市场在第一笔借款前没有债务总账，未创建时按零处理。 Older markets have no debt ledger until the first loan, so absence means zero. */
  const pool = readLendingAccount(poolInfo, supplyPoolDiscriminator, supplyPoolLayout.length);
  const debtLedger = readLendingAccount(borrowMarketInfo, borrowMarketDiscriminator, borrowMarketLayout.length);
  const accountedAssetsRaw = pool?.readBigUInt64LE(supplyPoolLayout.accountedAssets) ?? 0n;
  const totalSharesRaw = pool?.readBigUInt64LE(supplyPoolLayout.totalShares) ?? 0n;
  const totalDebtRaw = debtLedger?.readBigUInt64LE(borrowMarketLayout.totalDebt) ?? 0n;

  // 新增借款由本金和现金共同覆盖出借资产，账外入账仅增加现金。
  // Cash and outstanding principal jointly back supplied assets. Unaccounted transfers increase only cash.
  if ((accountedAssetsRaw === 0n) !== (totalSharesRaw === 0n) ||
      totalDebtRaw > accountedAssetsRaw || accountedAssetsRaw > cashRaw + totalDebtRaw) {
    throw new Error('The Devnet lending pool has invalid cash and debt accounting.');
  }
  return { poolExists: pool !== null, accountedAssetsRaw, totalSharesRaw, totalDebtRaw };
}

/**
 * 在同一个 Devnet 最终确认 slot 核验并读取市场现金。
 * Verify and read market cash at a single finalized Devnet slot.
 *
 * @param assets 已选市场登记的两种资产。 Both registered assets of the selected market.
 * @param signal 在离开页面或切换市场时取消读取。 Signal for canceling the read on navigation or a market change.
 * @returns 借款 Mint 最小单位的精确余额和观测 slot。 Exact balance in debt mint base units and the observation slot.
 */
export async function readDevnetLendingCash(assets: RegisteredPoolAssets, signal?: AbortSignal): Promise<DevnetLendingCash> {
  /** 保留资金池首页使用的余额和 slot 响应结构。 Preserve the pool overview response shape of balance and slot. */
  const { slot, cashRaw } = await readMarketAccounts(assets, [], { signal });
  return { slot, cashRaw };
}

/**
 * 读取并校验 Devnet 钱包的出借仓位、全池记账、资金池现金和可出借余额。
 * Read and validate a Devnet wallet's supply position, pool accounting, cash custody and spendable balance.
 *
 * @param assets 已选市场的登记资产配置。 Registered asset configuration of the selected market.
 * @param walletAddress 已连接钱包的公开 Base58 地址。 Connected wallet's public Base58 address.
 * @param options 可在钱包切换时取消，或指定出借交易完成后的最低 slot。 Cancellation for wallet changes or a minimum slot for post-supply reads.
 * @returns 同一个已最终确认 slot 下的精确资产和份额最小单位。 Exact asset and share base-unit amounts at a single finalized slot.
 */
export async function readDevnetLendingSupply(
  assets: RegisteredPoolAssets,
  walletAddress: string,
  options: LendingReadOptions = {},
): Promise<DevnetLendingSupply> {
  /** 钱包余额来自同一笔交易用来扣款的经典 SPL 关联账户。 Read spendable balance from the same classic SPL ATA used as the transaction source. */
  const { supplier, supplyPosition } = devnetLendingSupplyAddresses(walletAddress);
  const debtMint = new PublicKey(assets.debtAsset.mint);
  const walletAsset = getAssociatedTokenAddressSync(debtMint, supplier);
  const {
    slot, cashRaw, extra: [poolInfo, debtLedgerInfo, positionInfo, assetInfo],
  } = await readMarketAccounts(assets, [supplyPool, borrowMarket, supplyPosition, walletAsset], options);

  /** 从链上 u64 字节直接解码，避免把份额和金额转换为浮点数。 Decode on-chain u64 bytes directly, without converting shares or amounts to floating-point values. */
  const { poolExists, ...accounting } = readLendingAccounting(cashRaw, poolInfo, debtLedgerInfo);
  const position = readLendingAccount(positionInfo, supplyPositionDiscriminator, supplyPositionLayout.length);
  const sharesRaw = position?.readBigUInt64LE(supplyPositionLayout.shares) ?? 0n;
  if (position) {
    /** 个人份额属于本钱包且不能超过全池份额。 Wallet position shares must belong to this supplier and fit within the pool total. */
    const positionSupplier = new PublicKey(position.subarray(supplyPositionLayout.supplier, supplyPositionLayout.shares));
    if (!poolExists || !positionSupplier.equals(supplier) || sharesRaw > accounting.totalSharesRaw) {
      throw new Error('The Devnet supply position does not match the wallet or pool accounting.');
    }
  }

  /** 余额为零的有效账户、尚未创建的 ATA 和被冻结账户均不能作为正额出借来源。 A zero balance, a missing ATA, and a frozen ATA cannot fund a positive supply. */
  const asset = isUnallocated(assetInfo) ? null : decodeTokenAccount(walletAsset, assetInfo, debtMint, supplier);
  return {
    slot, cashRaw, ...accounting, sharesRaw,
    walletAssetRaw: asset && !asset.isFrozen ? asset.amount : 0n,
    walletAssetFrozen: asset?.isFrozen ?? false,
    positionExists: position !== null,
    observedAt: new Date().toISOString(),
  };
}

/**
 * 读取用于真实借款仓位与交易报价的同槽账户，将 ATA 和潜在为空的 PDA 分开验证。
 * Load same-slot data for the borrowing position and quotes, validating ATAs and optional PDAs separately.
 *
 * @param assets 已登记的 Mint 与精度。 Registered mints and their precision.
 * @param walletAddress 借款钱包的 Base58 公钥。 Base58 borrowing wallet public key.
 * @param options 请求取消信号或最早可接受的最终确认 slot。 Request cancellation or earliest accepted finalized slot.
 */
export async function readDevnetBorrowAccounts(
  assets: RegisteredPoolAssets,
  walletAddress: string,
  options: LendingReadOptions,
) {
  /** 查询的钱包 ATA 与交易使用的扣款、收款账户相同。 Queried wallet ATAs are the same source and destination accounts used by transactions. */
  const { borrower, borrowPosition } = devnetLendingBorrowAddresses(walletAddress);
  const collateralMint = new PublicKey(assets.collateralAsset.mint);
  const debtMint = new PublicKey(assets.debtAsset.mint);
  const collateralAta = getAssociatedTokenAddressSync(collateralMint, borrower);
  const debtAta = getAssociatedTokenAddressSync(debtMint, borrower);

  /** 使用链上 Clock 判断价格时效，受同一个最终确认 slot 约束。 Use the on-chain Clock to judge price freshness at the same finalized slot. */
  const { slot, cashRaw, extra: [pool, debtLedger, positionInfo, priceInfo, custodyInfo, collateralInfo, debtInfo, clock] } =
    await readMarketAccounts(assets, [
      supplyPool, borrowMarket, borrowPosition, mockCollateralPrice, collateralVault, collateralAta, debtAta, SYSVAR_CLOCK_PUBKEY,
    ], options);
  const { poolExists: _poolExists, ...accounting } = readLendingAccounting(cashRaw, pool, debtLedger);
  const position = readLendingAccount(positionInfo, borrowPositionDiscriminator, borrowPositionLayout.length);
  const price = readLendingAccount(priceInfo, mockPriceDiscriminator, mockPriceLayout.length);
  if (!clock || clock.executable || !clock.owner.equals(sysvarProgramId) || clock.data.length !== clockLayout.length) {
    throw new Error('The Devnet Clock sysvar has an invalid owner or layout.');
  }

  /** 对照规范抵押托管余额和总贷款本金，检查个人仓位的一致性。 Check the wallet position against canonical collateral custody and aggregate debt. */
  const custody = decodeTokenAccount(collateralVault, custodyInfo, collateralMint, marketAddress);
  const collateralRaw = position?.readBigUInt64LE(borrowPositionLayout.collateral) ?? 0n;
  const debtRaw = position?.readBigUInt64LE(borrowPositionLayout.debt) ?? 0n;
  if (custody.delegate || custody.closeAuthority || collateralRaw > custody.amount || debtRaw > accounting.totalDebtRaw ||
      (position && !new PublicKey(position.subarray(borrowPositionLayout.borrower, borrowPositionLayout.collateral)).equals(borrower))) {
    throw new Error('The Devnet borrowing position has invalid custody, owner, or debt.');
  }

  /** ATA 缺失表示钱包尚无可用余额。冻结账户仍能安全查看仓位，转账时不能使用。 An absent ATA has no spendable balance. A frozen ATA still allows position viewing but cannot transfer. */
  const collateralAccount = isUnallocated(collateralInfo) ? null : decodeTokenAccount(collateralAta, collateralInfo, collateralMint, borrower);
  const debtAccount = isUnallocated(debtInfo) ? null : decodeTokenAccount(debtAta, debtInfo, debtMint, borrower);
  return {
    slot, cashRaw, ...accounting, positionExists: position !== null, collateralRaw, debtRaw,
    collateralBalanceRaw: collateralAccount && !collateralAccount.isFrozen ? collateralAccount.amount : 0n,
    debtBalanceRaw: debtAccount && !debtAccount.isFrozen ? debtAccount.amount : 0n,
    priceRaw: price?.readBigUInt64LE(mockPriceLayout.price) ?? null,
    pricePublishedAt: price?.readBigInt64LE(mockPriceLayout.publishedAt) ?? null,
    chainUnixTimestamp: clock.data.readBigInt64LE(clockLayout.unixTimestamp),
  };
}

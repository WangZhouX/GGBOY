import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction,
  type TransactionError, type VersionedTransactionResponse,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { devnetRpcUrl } from '../getDevnetSolBalance';
import { devnetLendingBorrowAddresses, devnetLendingPool, readDevnetBorrowAccounts, type LendingReadOptions } from './devnetLendingPool';
import lendingIdl from './ggboyLendingIdl.json';
import { readLendingBorrowActions } from './readBorrowActivity';

/** 本次借款业务支持的交易与活动类型。 Borrowing transaction and activity types for this market. */
export type BorrowOperation = 'depositCollateral' | 'borrow' | 'repay' | 'withdrawCollateral';

/** 链上报价只使用市场的公开身份和两种代币的精度。 On-chain quotes use the deployment identity and both mint precisions. */
type BorrowMarketRegistration = Pick<LendingMarketListItem, 'address' | 'network' | 'programId' | 'debtAsset' | 'collateralAsset'>;

/** 从一个已最终确认 slot 验证的借款仓位与可执行额度。 Borrow position and executable limits verified at one finalized slot. */
export interface DevnetBorrowPosition {
  /** RPC 返回的最终确认 slot。 Finalized observation slot returned by RPC. */
  slot: number;
  /** 是否已经创建个人借款仓位 PDA。 Whether the wallet's borrow position PDA has been created. */
  positionExists: boolean;
  /** 锁定的抵押数量，按抵押 Mint 的最小单位。 Locked collateral in collateral mint base units. */
  collateralRaw: bigint;
  /** 个人未偿借款本金，按借款 Mint 的最小单位。 Outstanding wallet principal in debt mint base units. */
  debtRaw: bigint;
  /** 链上现金账户中的实际借款代币余额。 Actual lending cash custody balance in debt mint base units. */
  cashRaw: bigint;
  /** 已记账且可以从现金支付的额度，按借款 Mint 的最小单位。 Cash-backed recorded liquidity in debt mint base units. */
  availableToBorrowRaw: bigint;
  /** 全市场未偿本金，按借款 Mint 的最小单位。 Market-wide outstanding principal in debt mint base units. */
  totalDebtRaw: bigint;
  /** 钱包关联账户可用于抵押的代币最小单位。 Wallet ATA collateral base units available to deposit. */
  collateralBalanceRaw: bigint;
  /** 钱包关联账户可用于还款的代币最小单位。 Wallet ATA debt mint base units available to repay. */
  debtBalanceRaw: bigint;
  /** 上次有效发布的价格，每一整单位抵押品价值多少借款最小单位。 Last positive published price in debt base units per whole collateral token. */
  priceRaw: bigint | null;
  /** 价格发布时的链上 Unix 时间，单位为秒。 Price publication time in on-chain Unix seconds. */
  pricePublishedAt: number | null;
  /** 价格须以同一观测的链上时钟检查有效期。 Price freshness is determined by the chain clock from the same observation. */
  priceStatus: 'fresh' | 'missing' | 'stale';
  /** 当前可增加的最大本金，单位为借款最小单位；需价格但价格不可用时为空。 Maximum additional principal in debt base units, null when a required price is unavailable. */
  maxBorrowRaw: bigint | null;
  /** 当前可取回的抵押品最小单位，需价格但价格不可用时为空。 Maximum withdrawal in collateral base units, null when a required price is unavailable. */
  maxWithdrawRaw: bigint | null;
  /** 当前借款价值比，按基点向下取整。 Current debt-to-value ratio rounded down to whole basis points. */
  currentLtvBps: bigint | null;
  /** 健康度值乘以 10^6 后取整；没有债务时为空。 Health factor truncated after multiplying by 10^6, or null without debt. */
  healthFactorE6: bigint | null;
  /** 使仓位满足清算阈值的最低整数价格，使用预言机价格单位。 Minimum whole oracle price satisfying the liquidation threshold. */
  liquidationPriceRaw: bigint | null;
  /** 新增本金和有债务的抵押品取回所用 LTV 上限，单位为基点。 LTV limit in basis points for both new debt and collateral withdrawal with debt. */
  borrowLtvBps: bigint;
  /** 计算健康度的清算 LTV，单位为基点。 Liquidation LTV in basis points used to compute health. */
  liquidationLtvBps: bigint;
}

/** 用户为一笔借款交易核对的参数。 Reviewed parameters for one borrowing transaction. */
interface BorrowOperationRequest {
  /** 当前 Devnet 借贷市场登记记录。 Selected Devnet market registration. */
  market: BorrowMarketRegistration;
  /** 在 Phantom 签名并承担手续费的借款钱包。 Wallet signing through Phantom and paying the transaction fee. */
  walletAddress: string;
  /** 用户选择的借款业务动作。 Selected borrowing operation. */
  operation: BorrowOperation;
  /** 操作对应 Mint 的整数最小单位数量。 Amount in base units of the operation's mint. */
  amountRaw: bigint;
}

/** 保留原签名与识别交易过期所需的上下文。 Track a submission by its signature and blockhash expiry context. */
export interface BorrowOperationLifetime {
  /** RPC 支持的最后有效区块高度。 Last valid block height reported by RPC. */
  lastValidBlockHeight: number;
  /** 模拟时已确认的 slot，下游 RPC 不得早于该槽。 Confirmed simulation slot required as the lower bound for later RPCs. */
  minContextSlot: number;
}

/** 交易构造和无签名模拟通过后交给 Phantom 的结果。 Unsigned transaction and lifetime after successful simulation. */
export interface PreparedBorrowOperation extends BorrowOperationLifetime {
  /** 钱包审阅和签名的 unsigned legacy 交易。 Unsigned legacy transaction for wallet review and signing. */
  transaction: Transaction;
  /** 已写入交易的 Base58 区块哈希。 Base58 blockhash written into the transaction. */
  blockhash: string;
}

/** 经验证的单笔链上操作及执行完成时的仓位结果。 Verified action and position result at the end of one on-chain execution. */
export interface BorrowOperationReceipt {
  /** 交易执行的最终确认 slot。 Finalized execution slot. */
  slot: number;
  /** 此次完成的仓位操作类型。 Position operation completed by this transaction. */
  operation: BorrowOperation;
  /** 本次实际转移的 Mint 最小单位数量。 Actual amount transferred in the operation's mint base units. */
  amountRaw: bigint;
  /** 此操作完成时锁定的抵押最小单位。 Collateral base units locked when this operation completed. */
  collateralRaw: bigint;
  /** 此操作完成时实际未偿借款最小单位。 Outstanding debt base units when this operation completed. */
  debtRaw: bigint;
}

/** 页面用于提示与重试的稳定借款错误码。 Stable borrowing error codes for UI messages and retries. */
export type BorrowOperationErrorCode =
  | 'invalidAmount' | 'unsupportedMarket' | 'insufficientAsset' | 'insufficientSol'
  | 'insufficientCollateral' | 'insufficientLiquidity' | 'priceUnavailable' | 'noDebt'
  | 'preparationFailed' | 'transactionFailed' | 'expired' | 'confirmationUnknown' | 'receiptUnavailable';

/** 用错误码连接链上校验与界面语言，并保留诊断原因。 Expose a stable code for localization while preserving the underlying diagnostic. */
export class BorrowOperationError extends Error {
  /** 以稳定借款错误码构造可翻译错误。 Construct a localizable error with a stable borrowing code. */
  constructor(
    /** 用于页面展示的错误分类。 Error category used by the page. */
    readonly code: BorrowOperationErrorCode,
    /** 可选的底层异常。 Optional underlying error. */
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = 'BorrowOperationError';
  }
}

/** 业务参数与 Rust 实现一致，单位分别为基点、秒及无量纲定点倍率。 Match Rust policy using basis points, seconds, and a dimensionless fixed-point scale. */
const basisPoints = 10_000n;
const borrowLtvBps = 7_000n;
const liquidationLtvBps = 8_000n;
const priceMaxAgeSeconds = 604_800n;
const healthFactorScale = 1_000_000n;
/** 链上指令金额范围为非零 u64。 Valid on-chain instruction amounts are positive u64 values. */
const maxAmount = (1n << 64n) - 1n;
/** 指令名、事件操作码和操作方向与公开 IDL 对应。 Instruction names, event opcodes, and transfer directions match the public IDL. */
const operationDefinitions = {
  depositCollateral: { instruction: 'deposit_collateral', kind: 0, asset: 'collateralAsset', creditsWallet: false },
  borrow: { instruction: 'borrow', kind: 1, asset: 'debtAsset', creditsWallet: true },
  repay: { instruction: 'repay', kind: 2, asset: 'debtAsset', creditsWallet: false },
  withdrawCollateral: { instruction: 'withdraw_collateral', kind: 3, asset: 'collateralAsset', creditsWallet: true },
} as const satisfies Record<BorrowOperation, { instruction: string; kind: number; asset: 'debtAsset' | 'collateralAsset'; creditsWallet: boolean }>;

/**
 * 仅在项目公开登记并部署的 Devnet 借贷市场读取或交易。
 * Read or transact only on the registered GGBOY Devnet lending deployment.
 *
 * @param market 后端目录中的所选市场。 Selected market from the backend registry.
 */
function assertMarket(market: BorrowMarketRegistration): void {
  if (market.network !== 'devnet' || market.programId !== devnetLendingPool.programId ||
      market.address !== devnetLendingPool.marketAddress || lendingIdl.address !== market.programId) {
    throw new BorrowOperationError('unsupportedMarket');
  }
}

/**
 * 取两个最小单位整数中的小值。
 * Return the smaller of two integer base-unit values.
 *
 * @param left 第一项整数。 First integer.
 * @param right 第二项整数。 Second integer.
 */
function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

/**
 * 将任意有符号差额截断为非负额度。
 * Clamp a signed difference to a nonnegative limit.
 *
 * @param amount 以整数最小单位计的差额。 Difference in integer base units.
 */
function nonNegative(amount: bigint): bigint {
  return amount > 0n ? amount : 0n;
}

/**
 * 对正分母执行整数向上取整，供计算最低保留抵押量或价格。
 * Divide with ceiling for a positive denominator, to calculate minimum retained collateral or price.
 *
 * @param numerator 分子。 Numerator.
 * @param denominator 正整数分母。 Positive integer denominator.
 */
function divideCeiling(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * 从同一个最终确认 slot 读取仓位、钱包余额、价格和池内流动性，并按链上精度计算额度。
 * Load the position, wallet balances, price, and liquidity at one finalized slot and quote limits with on-chain precision.
 *
 * @param market 后端登记市场及两类 Mint 精度。 Registered market and both mint precisions.
 * @param walletAddress Phantom 钱包 Base58 公钥。 Base58 Phantom public key.
 * @param options 取消信号及可接受的最早最终确认 slot。 Cancellation and earliest acceptable finalized slot.
 * @returns 能从该观测确定的金额和风险数据，缺失报价输入时保留空值。 Verified amounts and risk metrics, using null for unavailable quote inputs.
 */
export async function readDevnetBorrowPosition(
  market: BorrowMarketRegistration,
  walletAddress: string,
  options: LendingReadOptions = {},
): Promise<DevnetBorrowPosition> {
  assertMarket(market);

  /** 原始抵押品用 Mint 精度归一化，价格已经按借款 Mint 最小单位计。 Normalize collateral by its mint precision. Price is already in debt mint base units. */
  const { accountedAssetsRaw, totalSharesRaw: _totalSharesRaw, priceRaw: observedPrice, pricePublishedAt: published, chainUnixTimestamp, ...position } =
    await readDevnetBorrowAccounts(market, walletAddress, options);
  const { collateralRaw, debtRaw, cashRaw, totalDebtRaw } = position;
  const collateralScale = 10n ** BigInt(market.collateralAsset.decimals);
  /** 只使用现金和已记账权益的较小值，直接转入的代币不会提高可借额度。 Limit borrowing to both cash and book assets, excluding direct cash transfers from the lending limit. */
  const availableToBorrowRaw = minimum(cashRaw, accountedAssetsRaw - totalDebtRaw);

  /** 保留已发布价格供界面核对；只有新鲜价格可用于风险评估和借款报价。 Retain the published price for display, but use only fresh prices for risk and borrowing quotes. */
  const priceRaw = observedPrice !== null && observedPrice > 0n ? observedPrice : null;
  const priceStatus = priceRaw === null || published === null ? 'missing'
    : published <= 0n || published > chainUnixTimestamp || chainUnixTimestamp - published > priceMaxAgeSeconds
      ? 'stale' : 'fresh';
  const livePrice = priceStatus === 'fresh' ? priceRaw : null;
  const pricePublishedAt = published !== null && published > 0n && published <= 8_640_000_000_000n ? Number(published) : null;

  /** 保留分子全精度到最后除法，避免先舍入抵押估值而改变允许借款的边界。 Keep full numerator precision until the final divide so rounding cannot change the borrowing bound. */
  const collateralValueNumerator = livePrice === null ? null : collateralRaw * livePrice;
  const collateralCapacityRaw = collateralValueNumerator === null ? null
    : collateralValueNumerator * borrowLtvBps / (collateralScale * basisPoints);
  const maxBorrowRaw = collateralRaw === 0n || availableToBorrowRaw === 0n ? 0n
    : collateralCapacityRaw === null ? null : minimum(availableToBorrowRaw, nonNegative(collateralCapacityRaw - debtRaw));
  const maxWithdrawRaw = debtRaw === 0n ? collateralRaw
    : collateralRaw === 0n ? 0n
    : livePrice === null ? null
    : nonNegative(collateralRaw - divideCeiling(debtRaw * collateralScale * basisPoints, livePrice * borrowLtvBps));

  /** 风险比率从全精度整数和定点倍率计算，显示舍入不参与合约风控。 Risk ratios use exact integers and a fixed-point scale. Display rounding does not decide program risk checks. */
  const currentLtvBps = collateralValueNumerator && collateralValueNumerator > 0n
    ? debtRaw * collateralScale * basisPoints / collateralValueNumerator : null;
  const healthFactorE6 = collateralValueNumerator !== null && debtRaw > 0n
    ? collateralValueNumerator * liquidationLtvBps * healthFactorScale / (collateralScale * basisPoints * debtRaw)
    : null;
  const liquidationPriceRaw = debtRaw > 0n && collateralRaw > 0n
    ? divideCeiling(debtRaw * collateralScale * basisPoints, collateralRaw * liquidationLtvBps) : null;

  return {
    ...position, availableToBorrowRaw, priceRaw, priceStatus, pricePublishedAt, maxBorrowRaw,
    maxWithdrawRaw, currentLtvBps, healthFactorE6, liquidationPriceRaw, borrowLtvBps, liquidationLtvBps,
  };
}

/**
 * 为指定操作返回最大的输入金额。
 * Return the maximum input amount for the selected action.
 *
 * @param position 已验证的借款报价与钱包余额。 Verified borrowing quote and wallet balances.
 * @param operation 借款表单对应的操作。 Action chosen in the borrowing form.
 */
export function getBorrowOperationLimit(position: DevnetBorrowPosition, operation: BorrowOperation): bigint | null {
  switch (operation) {
    case 'depositCollateral': return position.collateralBalanceRaw;
    case 'borrow': return position.maxBorrowRaw;
    case 'repay': return minimum(position.debtBalanceRaw, position.debtRaw);
    case 'withdrawCollateral': return position.maxWithdrawRaw;
  }
}

/**
 * 在最新仓位上检查用户核对的金额，程序执行时会再次检查。
 * Validate the reviewed amount against fresh state. The program repeats all checks at execution.
 *
 * @param request 用户已核对的交易与最小单位数量。 Reviewed operation and base-unit amount.
 * @param position 当前钱包与市场的最终确认观测。 Finalized position and market observation.
 */
function validateOperation(request: BorrowOperationRequest, position: DevnetBorrowPosition): void {
  /** 识别失效报价、余额不足以及抵押不足，使用户在钱包弹出前知道原因。 Detect missing quotes, insufficient wallet balance, and insufficient collateral before prompting the wallet. */
  const { amountRaw, operation } = request;
  if (amountRaw <= 0n || amountRaw > maxAmount) throw new BorrowOperationError('invalidAmount');
  const limit = getBorrowOperationLimit(position, operation);
  if (limit === null) throw new BorrowOperationError('priceUnavailable');
  if (amountRaw <= limit) return;

  switch (operation) {
    case 'depositCollateral':
      throw new BorrowOperationError('insufficientAsset');
    case 'repay':
      if (position.debtRaw === 0n) throw new BorrowOperationError('noDebt');
      throw new BorrowOperationError(amountRaw > position.debtRaw ? 'invalidAmount' : 'insufficientAsset');
    case 'borrow':
      throw new BorrowOperationError(amountRaw > position.availableToBorrowRaw ? 'insufficientLiquidity' : 'insufficientCollateral');
    case 'withdrawCollateral':
      throw new BorrowOperationError('insufficientCollateral');
  }
}

/**
 * 按公开的 Anchor IDL 构造单项借款指令，并派生受钱包控制的资金账户。
 * Construct one borrowing instruction from the public Anchor IDL and derive the wallet-controlled token account.
 *
 * @param request 市场、签名钱包、操作以及整数最小单位金额。 Market, signing wallet, action, and integer base-unit amount.
 */
function buildOperation(request: BorrowOperationRequest) {
  assertMarket(request.market);
  if (request.amountRaw <= 0n || request.amountRaw > maxAmount) throw new BorrowOperationError('invalidAmount');

  /** ABI 定义来自实际构建产物，账户名称明确绑定到本次操作的规范地址。 Use the actual build IDL and bind every ABI account name to this operation's canonical address. */
  const { market, walletAddress, operation, amountRaw } = request;
  const action = operationDefinitions[operation];
  const definition = lendingIdl.instructions.find(({ name }) => name === action.instruction);
  if (!definition || definition.discriminator.length !== 8) throw new BorrowOperationError('unsupportedMarket');
  const {
    borrower, marketAddress, cashVault, collateralVault, supplyPool, borrowMarket, borrowPosition, mockCollateralPrice, programId,
  } = devnetLendingBorrowAddresses(walletAddress);
  const debtMint = new PublicKey(market.debtAsset.mint);
  const collateralMint = new PublicKey(market.collateralAsset.mint);
  const transferMint = new PublicKey(market[action.asset].mint);
  const walletTokenAccount = getAssociatedTokenAddressSync(transferMint, borrower);
  const addresses: Readonly<Record<string, PublicKey>> = {
    borrower,
    market: marketAddress,
    debt_mint: debtMint,
    collateral_mint: collateralMint,
    cash_vault: cashVault,
    collateral_vault: collateralVault,
    supply_pool: supplyPool,
    borrow_market: borrowMarket,
    borrow_position: borrowPosition,
    mock_collateral_price: mockCollateralPrice,
    source: walletTokenAccount,
    destination: walletTokenAccount,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  };

  /** 唯一的金额参数是判别符后的定长小端 u64。 The only amount argument is a fixed-width little-endian u64 after the discriminator. */
  const data = Buffer.alloc(definition.discriminator.length + 8);
  Buffer.from(definition.discriminator).copy(data);
  data.writeBigUInt64LE(amountRaw, definition.discriminator.length);

  /** 钱包首次接收资产时可在同一笔交易创建 ATA；已存在时不重复扣租金。 Create the wallet ATA in the same transaction on first receipt. Existing ATAs incur no additional rent. */
  const setup = action.creditsWallet
    ? [createAssociatedTokenAccountIdempotentInstruction(borrower, walletTokenAccount, borrower, transferMint)]
    : [];
  const instruction = new TransactionInstruction({
    programId,
    data,
    keys: definition.accounts.map((account) => {
      /** Anchor 元数据决定账户顺序和权限；拒绝任何未绑定的账户。 Anchor metadata controls account order and permissions. Reject unbound accounts. */
      const pubkey = addresses[account.name];
      if (!pubkey) throw new BorrowOperationError('preparationFailed');
      return {
        pubkey,
        isSigner: 'signer' in account && account.signer === true,
        isWritable: 'writable' in account && account.writable === true,
      };
    }),
  });
  return { borrower, setup, instruction };
}

/** 每次 RPC、整轮确认及单次轮询间隔的毫秒上限。 Millisecond budgets for each RPC, the whole confirmation, and the poll interval. */
const rpcTimeoutMs = 8_000;
const confirmationTimeoutMs = 120_000;
const confirmationPollMs = 2_500;

/**
 * 建立只使用配置 Devnet RPC 的限时连接。
 * Open a time-bounded connection to the configured Devnet RPC.
 *
 * @param signal 操作级可选取消信号。 Optional operation-level abort signal.
 */
function makeBorrowConnection(signal?: AbortSignal): Connection {
  return new Connection(devnetRpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (input, init) => {
      /** 单个请求超时与整体取消都结束底层 HTTP。 The request timeout and overall cancel both stop the HTTP request. */
      const timeout = AbortSignal.timeout(rpcTimeoutMs);
      return fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    },
  });
}

/** 将借款 Anchor 错误名映射为稳定的客户端语义。 Map Anchor borrowing errors to stable client meanings. */
const programErrorCodes: Partial<Record<string, BorrowOperationErrorCode>> = {
  InvalidBorrowAmount: 'invalidAmount',
  RepaymentExceedsDebt: 'invalidAmount',
  InsufficientBorrowTokenBalance: 'insufficientAsset',
  CollateralTooLow: 'insufficientCollateral',
  InsufficientBorrowLiquidity: 'insufficientLiquidity',
  InvalidMockPrice: 'priceUnavailable',
  StaleMockPrice: 'priceUnavailable',
};

/**
 * 按出错的顶层指令索引区分借贷错误、费用和其他模拟失败。
 * Distinguish lending errors, fees, and other simulation failures by the top-level instruction index.
 *
 * @param error RPC 模拟错误。 RPC simulation error.
 * @param logs 模拟程序日志。 Program simulation logs.
 * @param instructionIndex 借贷指令在设置指令后的索引，从零开始。 Zero-based lending instruction index after setup instructions.
 */
function borrowSimulationError(error: TransactionError, logs: string[] | null, instructionIndex: number): BorrowOperationError {
  if (error === 'InsufficientFundsForFee' ||
      (typeof error === 'object' && 'InsufficientFundsForRent' in error) ||
      logs?.some((line) => /insufficient lamports/i.test(line))) {
    return new BorrowOperationError('insufficientSol', error);
  }

  /** 地址初始化等 CPI 的错误不能误解成同编号的借贷 Anchor 错误。 Setup and CPI errors must not be misread as matching Anchor error numbers. */
  const failure = typeof error === 'object' && 'InstructionError' in error ? error.InstructionError : null;
  if (Array.isArray(failure) && failure[0] === instructionIndex) {
    /** 仅按本程序 IDL 解析出错的自定义错误。 Resolve the failing custom error only through this program's IDL. */
    const detail = failure[1];
    const custom = detail && typeof detail === 'object' && 'Custom' in detail ? detail.Custom : null;
    const name = lendingIdl.errors.find((entry) => entry.code === custom)?.name;
    if (name && programErrorCodes[name]) return new BorrowOperationError(programErrorCodes[name], error);
  }
  return new BorrowOperationError('preparationFailed', error);
}

/**
 * 在已核对的 slot 下重新验证报价，模拟由 Phantom 审阅的借款交易。
 * Revalidate the quote at or after its reviewed slot and simulate the transaction submitted for Phantom approval.
 *
 * @param request 操作、精确数量和当前报价所用观测 slot。 Operation, exact amount, and quote observation slot.
 * @returns 模拟成功的未签名交易及可确认的有效期。 Unsigned simulated transaction and its lifetime for confirmation.
 */
export async function prepareBorrowOperation(
  request: BorrowOperationRequest & Pick<BorrowOperationLifetime, 'minContextSlot'>,
): Promise<PreparedBorrowOperation> {
  try {
    /** 将前端重读和后续模拟全部限定在已核对观测的同槽或更新位置。 Keep both fresh validation and simulation at or after the reviewed observation. */
    const { borrower, setup, instruction } = buildOperation(request);
    const position = await readDevnetBorrowPosition(request.market, request.walletAddress, { minContextSlot: request.minContextSlot });
    validateOperation(request, position);

    /** 获取新的已确认区块哈希并保留有效高度，便于签名后安全处理重试。 Fetch a fresh confirmed blockhash and its expiry for safe post-signing recovery. */
    const connection = makeBorrowConnection();
    const { context, value } = await connection.getLatestBlockhashAndContext({
      commitment: 'confirmed',
      minContextSlot: position.slot,
    });
    if (!Number.isSafeInteger(context.slot) || context.slot < position.slot ||
        !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight < 1) {
      throw new BorrowOperationError('preparationFailed');
    }

    /** 钱包接收原始 legacy 交易；模拟使用无签名包装并保持账户及指令完全一致。 Phantom receives the legacy transaction. Simulation wraps the identical instructions and accounts without a signature. */
    const transaction = new Transaction({ ...value, feePayer: borrower }).add(...setup, instruction);
    const simulation = await connection.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {
      commitment: 'confirmed',
      minContextSlot: context.slot,
      sigVerify: false,
    });
    if (!Number.isSafeInteger(simulation.context.slot) || simulation.context.slot < context.slot) {
      throw new BorrowOperationError('preparationFailed');
    }
    if (simulation.value.err) throw borrowSimulationError(simulation.value.err, simulation.value.logs, setup.length);
    return { transaction, ...value, minContextSlot: simulation.context.slot };
  } catch (error) {
    if (error instanceof BorrowOperationError) throw error;
    throw new BorrowOperationError('preparationFailed', error);
  }
}

/**
 * 将已最终确认的交易和用户核对的借贷指令、账户、钱包及事件逐一匹配。
 * Match the finalized transaction to the reviewed lending instruction, accounts, wallet, and event.
 *
 * @param result 最终确认的交易记录。 Finalized transaction record.
 * @param signature Phantom 提供的原交易签名。 Original transaction signature returned by Phantom.
 * @param request 用户原先确认的借款操作。 Borrowing action confirmed by the user.
 * @param instruction 按原参数重建的预期指令。 Expected instruction rebuilt from the reviewed parameters.
 * @param lifetime 模拟使用的 slot 下限和区块哈希有效高度。 Simulation slot floor and blockhash expiration height.
 */
function readBorrowReceipt(
  result: VersionedTransactionResponse,
  signature: string,
  request: BorrowOperationRequest,
  instruction: TransactionInstruction,
  lifetime: BorrowOperationLifetime,
): BorrowOperationReceipt {
  if (!Number.isSafeInteger(result.slot) || result.slot < lifetime.minContextSlot ||
      result.transaction.signatures[0] !== signature || !result.meta) {
    throw new BorrowOperationError('receiptUnavailable');
  }
  if (result.meta.err) throw new BorrowOperationError('transactionFailed', result.meta.err);

  /** 支持钱包追加优先费设置，同时完整核对唯一的顶层借贷指令。 Allow wallet-added priority fee setup while matching the complete, unique top-level lending instruction. */
  const message = result.transaction.message;
  const keys = message.getAccountKeys({ accountKeysFromLookups: result.meta.loadedAddresses });
  const operations = message.compiledInstructions.filter((entry) => keys.get(entry.programIdIndex)?.equals(instruction.programId));
  const [executed] = operations;
  if (operations.length !== 1 || !keys.get(0)?.equals(instruction.keys[0].pubkey) ||
      !Buffer.from(executed.data).equals(instruction.data) || executed.accountKeyIndexes.length !== instruction.keys.length ||
      !executed.accountKeyIndexes.every((index, offset) => keys.get(index)?.equals(instruction.keys[offset].pubkey))) {
    throw new BorrowOperationError('receiptUnavailable');
  }

  /** 金额和操作不能从客户端预览猜测，必须匹配唯一经过验证的链上事件。 Use the single verified on-chain event for the actual amount and operation, never the client preview. */
  const events = readLendingBorrowActions(result, request.market, request.walletAddress);
  const [event] = events;
  if (events.length !== 1 || event.kind !== operationDefinitions[request.operation].kind || event.amountRaw !== request.amountRaw) {
    throw new BorrowOperationError('receiptUnavailable');
  }
  return {
    slot: result.slot, operation: request.operation, amountRaw: event.amountRaw,
    collateralRaw: event.collateralRaw, debtRaw: event.debtRaw,
  };
}

/**
 * 等到下一次查询时机或用户取消。
 * Wait for the next polling interval or cancellation.
 *
 * @param signal 整体确认的取消与超时信号。 Confirmation cancellation and timeout signal.
 */
function delayBorrowPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    /** 轮询等待结束时移除监听器和调度计时器。 Remove the listener and scheduled timer after waiting. */
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }

    /** 相邻确认查询之间的毫秒计时器。 Millisecond timer between consecutive confirmation queries. */
    const timer = setTimeout(finish, confirmationPollMs);
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 只用原交易签名跟踪最终确认并核对实际事件。
 * Follow finalization of the original signature and verify the actual event.
 *
 * @param signature 钱包提交后返回的原交易签名。 Original submitted signature returned by the wallet.
 * @param request 用户最初确认的市场、操作、账户和金额。 Initially reviewed market, action, account, and amount.
 * @param lifetime 实际提交交易的模拟 slot 下限和 blockhash 最后有效高度。 Simulation slot floor and validity height of the submitted transaction.
 * @param signal 调用方可选取消信号。 Optional caller cancellation signal.
 * @returns 已核验的本次实际转账和仓位结果。 Verified transfer and resulting debt and collateral from this operation.
 */
export async function waitForBorrowOperation(
  signature: string,
  request: BorrowOperationRequest,
  lifetime: BorrowOperationLifetime,
  signal?: AbortSignal,
): Promise<BorrowOperationReceipt> {
  /** 一轮查询有期限，超时保留签名并允许继续查询同一笔交易。 Each lookup attempt is bounded. Timeout preserves the signature for rechecking the same transaction. */
  const deadline = AbortSignal.timeout(confirmationTimeoutMs);
  const lookupSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const connection = makeBorrowConnection(lookupSignal);
  const { instruction } = buildOperation(request);
  const config = { commitment: 'finalized', maxSupportedTransactionVersion: 0 } as const;
  /** RPC 可能先返回最终确认状态，稍后才返回完整日志。 RPC can expose finalized status before full transaction logs. */
  let finalized = false;
  let lastError: unknown;

  while (!lookupSignal.aborted) {
    try {
      /** 完整交易是最终确认和实际事件的直接证据，已核对过签名的重试也可从历史直接恢复。 A full transaction proves finalization and the actual event, also recovering a prior signature directly from history. */
      const result = await connection.getTransaction(signature, config);
      lookupSignal.throwIfAborted();
      if (result) return readBorrowReceipt(result, signature, request, instruction, lifetime);

      if (!finalized) {
        /** 缺少交易内容时通过签名状态识别已确认失败与已过期情形。 When details are absent, check signature status for finalized failure and expiry. */
        const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const [status] = statuses.value;
        if (status?.confirmationStatus === 'finalized') {
          if (status.err) throw new BorrowOperationError('transactionFailed', status.err);
          finalized = true;
        } else if (!status && statuses.context.slot >= lifetime.minContextSlot &&
          await connection.getBlockHeight({ commitment: 'finalized', minContextSlot: lifetime.minContextSlot }) > lifetime.lastValidBlockHeight) {
          // 超过有效期后重查签名和交易内容，避免把晚返回的已成交交易判为过期。
          // After blockhash expiration, recheck both status and details before declaring expiry.
          const recheck = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
          if (recheck.context.slot >= statuses.context.slot && recheck.value[0] === null) {
            const history = await connection.getTransaction(signature, config);
            lookupSignal.throwIfAborted();
            if (history) return readBorrowReceipt(history, signature, request, instruction, lifetime);
            throw new BorrowOperationError('expired');
          }
        }
      }
    } catch (error) {
      if (error instanceof BorrowOperationError) throw error;
      lastError = error;
    }
    await delayBorrowPoll(lookupSignal);
  }
  signal?.throwIfAborted();
  throw new BorrowOperationError(finalized ? 'receiptUnavailable' : 'confirmationUnknown', lastError);
}

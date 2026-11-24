import { i18n } from '../../../app/i18n/i18n';
import { ApiError, createApiClient, unwrapApiResponse } from '../../../shared/api/client';
import type { Network } from '../../../shared/navigation/network';

/** 查询已登记的借贷市场所需的网络参数。 Required network for listing registered lending markets. */
export interface LendingMarketListRequest {
  /** 借贷市场部署的 Solana 网络。 Solana network hosting the lending markets. */
  network: Network;
}

/** 成功响应的资金池概况。 Market overview payload of a successful response. */
export interface LendingMarketListResponse {
  /** 按市场地址排序，没有登记市场时为空数组。 Markets ordered by address, or empty if the network has no registrations. */
  items: LendingMarketListItem[];
}

/** 市场登记和最近一次资金池观测。 A market registration and its most recent pool observation. */
export interface LendingMarketListItem {
  /** 本条市场登记所属的 Solana 网络。 Solana network of this market registration. */
  network: Network;
  /** 借贷市场状态账户的 Base58 公钥。 Base58 public key of the lending market state account. */
  address: string;
  /** 拥有市场状态账户的借贷程序公钥。 Public key of the program that owns the market state account. */
  programId: string;
  /** 出借、借款与还款使用的资产。 Asset used for supplying, borrowing, and repayment. */
  debtAsset: LendingMarketAsset;
  /** 借款时使用的抵押资产。 Asset used as collateral for borrowing. */
  collateralAsset: LendingMarketAsset;
  /** 最近观测的市场数据，从未采集时为 null。 Latest market observation, or null before the first sample. */
  latestSnapshot: LendingMarketSnapshot | null;
}

/** 市场资产的 Mint 及用于显示金额的元数据。 Market asset mint and metadata for displaying amounts. */
export interface LendingMarketAsset {
  /** 资产 Mint 的 Base58 公钥。 Base58 public key of the asset mint. */
  mint: string;
  /** 展示简称，未配置时为 null。 Display ticker, or null when unconfigured. */
  symbol: string | null;
  /** Mint 小数位数，范围 0 至 255。 Mint decimal places, from 0 to 255. */
  decimals: number;
}

/** 同一次观测的资金池金额和利率，金额保留十进制整数字符串。 Pool amounts and rates from one observation, with amounts preserved as decimal integer strings. */
export interface LendingMarketSnapshot {
  /** 已观测 slot 的十进制 u64 文本。 Decimal u64 text for the observation slot. */
  slot: string;
  /** 采集时间，使用 ISO 8601 UTC 文本。 Observation time in ISO 8601 UTC text. */
  observedAt: string;
  /** 池内现金，以借款资产最小单位计。 Pool cash in debt asset base units. */
  cashRaw: string;
  /** 受市场级额度约束的可借金额，以借款资产最小单位计。 Borrowable amount after market limits, in debt asset base units. */
  availableToBorrowRaw: string;
  /** 计息且排除已核销债务后的未偿债务，以借款资产最小单位计。 Accrued outstanding debt excluding write-offs, in debt asset base units. */
  totalDebtRaw: string;
  /** 资金利用率基点，100 基点等于 1%。 Utilization in basis points, where 100 basis points equal 1%. */
  utilizationBps: number;
  /** 借款年化利率基点。 Annual borrowing rate in basis points. */
  borrowRateBps: number;
  /** 出借年化利率基点。 Annual supplying rate in basis points. */
  supplyRateBps: number;
  /** 服务端按观测时间和阈值计算的状态。 Status computed by the server from the observation time and threshold. */
  freshness: 'FRESH' | 'STALE';
}

/** 每次请求以当前界面语言协商后端文案。 Negotiate backend messages with the current UI language on each request. */
const api = createApiClient(() => i18n.language);
/** 观测 slot 与池内现金使用的无符号 64 位整数上限。 Maximum unsigned 64-bit integer for slots and pool cash. */
const MAX_U64 = (1n << 64n) - 1n;
/** 年化利率基点在接口中的有符号 32 位整数上限。 Maximum signed 32-bit integer used for API annual rates in basis points. */
const MAX_RATE_BPS = 2_147_483_647;

/**
 * 确认未知值可按 JSON 对象检查字段。
 * Checks whether an unknown value has JSON object fields.
 *
 * @param value 待检查的响应内容。 Response value to inspect.
 * @returns 非空且非数组的对象为 true。 True for a non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 检查链上公钥显示所需的 Base58 字符和编码长度。
 * Checks Base58 characters and encoded length for a displayed public key.
 *
 * @param value 接口返回的公钥。 Public key returned by the API.
 * @returns 符合 Solana 公钥编码形状时为 true。 True when the string matches the Solana public key format.
 */
function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/**
 * 在金额进入 BigInt 格式化前检查非负十进制整数文本。
 * Checks nonnegative decimal integer text before sending it to BigInt formatting.
 *
 * @param value 待检查的金额或 slot。 Amount or slot to inspect.
 * @param maxDigits 数据库或接口允许的最大十进制位数。 Maximum decimal digits allowed by the database or API.
 * @returns 可以安全保留为整数文本时为 true。 True when the value can safely be kept as integer text.
 */
function isUnsignedDecimal(value: unknown, maxDigits: number): value is string {
  return typeof value === 'string' && value.length <= maxDigits && /^(0|[1-9][0-9]*)$/.test(value);
}

/**
 * 检查为 JSON 数字传输的精度或基点是否落在允许范围内。
 * Checks whether decimals or basis points sent as a JSON number are within range.
 *
 * @param value 接口返回的精度或基点。 Precision or basis points returned by the API.
 * @param maxInclusive 允许的整数上界，包含边界。 Inclusive upper bound.
 * @returns 介于零和上界之间的整数为 true。 True for an integer from zero through the upper bound.
 */
function isBoundedInteger(value: unknown, maxInclusive: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maxInclusive;
}

/**
 * 验证资产单位与精度，确保页面可以安全地格式化对应金额。
 * Validates asset units and decimals so pages can safely format their amounts.
 *
 * @param value 接口返回的借款资产或抵押资产。 Debt or collateral asset returned by the API.
 * @returns 资产对象符合接口约定时为 true。 True when the asset matches the API contract.
 */
function isAsset(value: unknown): value is LendingMarketAsset {
  return isObject(value) && isAddress(value.mint) && (value.symbol === null || typeof value.symbol === 'string') &&
    isBoundedInteger(value.decimals, 255);
}

/**
 * 校验已采集的资金池观测及金额、利率范围。
 * Validates a sampled pool observation and its amount and rate ranges.
 *
 * @param value 接口返回的非空观测。 Non-null observation returned by the API.
 * @returns 观测对象可以安全展示时为 true。 True when the observation is safe to display.
 */
function isSnapshot(value: unknown): value is LendingMarketSnapshot {
  if (!isObject(value) || !isUnsignedDecimal(value.slot, 20) || !isUnsignedDecimal(value.cashRaw, 20) ||
    !isUnsignedDecimal(value.availableToBorrowRaw, 39) || !isUnsignedDecimal(value.totalDebtRaw, 39)) {
    return false;
  }

  // PostgreSQL 对现金、slot 和全池可借额度的约束也是前端展示的输入边界。
  // PostgreSQL bounds for cash, slot, and pool borrowing are also display input boundaries.
  return BigInt(value.slot) <= MAX_U64 && BigInt(value.cashRaw) <= MAX_U64 &&
    BigInt(value.availableToBorrowRaw) <= BigInt(value.cashRaw) &&
    typeof value.observedAt === 'string' && value.observedAt.endsWith('Z') && Number.isFinite(Date.parse(value.observedAt)) &&
    isBoundedInteger(value.utilizationBps, 10_000) && isBoundedInteger(value.borrowRateBps, MAX_RATE_BPS) &&
    isBoundedInteger(value.supplyRateBps, MAX_RATE_BPS) && (value.freshness === 'FRESH' || value.freshness === 'STALE');
}

/**
 * 校验市场登记和当前网络，保留尚未观测时的 null。
 * Validates the market registration and selected network, preserving null for an unsampled pool.
 *
 * @param value 接口返回的市场条目。 Market item returned by the API.
 * @param network 调用方当前选择的网络。 Network selected by the caller.
 * @returns 属于指定网络且字段有效时为 true。 True for a valid market on the requested network.
 */
function isMarket(value: unknown, network: Network): value is LendingMarketListItem {
  return isObject(value) && value.network === network && isAddress(value.address) && isAddress(value.programId) &&
    isAsset(value.debtAsset) && isAsset(value.collateralAsset) &&
    (value.latestSnapshot === null || isSnapshot(value.latestSnapshot));
}

/**
 * 读取当前网络的市场目录及资金池现况。
 * Loads the market catalog and pool overview for the selected network.
 *
 * @param request 市场目录查询参数。 Market catalog query parameters.
 * @param signal 用户切换网络或离开页面时用于取消旧请求。 Signal for canceling the previous request after a network or route change.
 * @returns 保持接口顺序的市场列表，原样保留整数文本和空观测。 Markets in API order with integer text and null observations preserved.
 * @throws ApiError 后端请求失败或响应格式无效。 Backend failure or an invalid response format.
 */
export async function listLendingMarkets(
  request: LendingMarketListRequest,
  signal?: AbortSignal,
): Promise<LendingMarketListResponse> {
  /** 生成的展示模型重用了快照名称，按真实响应的资金池契约校验业务字段。 The generated models reuse snapshot names, so validate business fields against the actual pool contract. */
  const { items }: { items?: unknown } = await unwrapApiResponse(
    api.GET('/api/v1/lending-markets', { params: { query: { network: request.network } }, signal }),
  );
  if (!Array.isArray(items) || !items.every((item: unknown): item is LendingMarketListItem => isMarket(item, request.network))) {
    throw new ApiError('The API returned an invalid lending market list.', 'invalid-response');
  }

  return { items };
}

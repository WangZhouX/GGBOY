import { i18n } from '../../../app/i18n/i18n';
import { ApiError, createApiClient, unwrapApiResponse } from '../../../shared/api/client';
import type { Network } from '../../../shared/navigation/network';

/** 清算候选页的查询范围，首屏省略游标。 Scope of a liquidation candidate page, omitting the cursor on the first page. */
export interface LendingLiquidationListRequest {
  /** 借贷市场登记所属的测试网络。 Test network for this lending market registration. */
  network: Network;
  /** 所选市场状态账户公钥。 Public key of the selected market state account. */
  marketAddress: string;
  /** 后端提供的原样续页游标。 Unchanged continuation cursor supplied by the backend. */
  cursor?: string;
}

/** 最新评估批次可用时才显示候选并允许进入实时预览。 Candidates and live previews are available only for a usable evaluation batch. */
export type LendingLiquidationAvailability = 'READY' | 'NO_SNAPSHOT' | 'STALE' | 'PRICE_UNAVAILABLE';

/** 一条被索引器标记可清算的仓位，同一批次按健康度排序。 A position the indexer marked eligible, sorted by health factor within its batch. */
export interface LendingLiquidationCandidate {
  /** 借款人钱包 Base58 公钥。 Borrower's Base58 wallet public key. */
  walletAddress: string;
  /** 已锁定抵押 Mint 最小单位数。 Locked collateral mint base units. */
  collateralRaw: string;
  /** 估值时未偿债务，按借款 Mint 最小单位计。 Outstanding debt at the observation, in debt mint base units. */
  debtRaw: string;
  /** 展示精度的无量纲健康度，保持十进制文本。 Dimensionless health factor at display precision, kept as decimal text. */
  healthFactor: string;
  /** 评估该仓位的十进制 slot 与 ISO UTC 时间。 Decimal slot and ISO UTC time of the position observation. */
  slot: string;
  observedAt: string;
  /** 后端以完整精度确认的候选标记。 Eligibility confirmed by the backend at full precision. */
  isLiquidatable: true;
}

/** 一页候选及其同批的市场与价格来源。 One page of candidates and their shared market and price source. */
export interface LendingLiquidationPage {
  /** 本页查阅的测试网络与市场公钥。 Test network and market public key of this page. */
  network: Network;
  marketAddress: string;
  /** 数据可用性与缺数原因。 Availability of data and reason if unavailable. */
  availability: LendingLiquidationAvailability;
  /** 市场观测的 slot 与 ISO UTC 时间，未采集时为空。 Market observation slot and ISO UTC time, or null if unobserved. */
  marketSlot: string | null;
  observedAt: string | null;
  /** 预言机公钥、发布 slot、ISO UTC 时间与整单位抵押品价格，列表未就绪时为空。 Oracle key, publish slot, ISO UTC time, and price per whole collateral token, or null until ready. */
  oracleAddress: string | null;
  oracleSlot: string | null;
  oraclePublishedAt: string | null;
  collateralPrice: string | null;
  /** 本页候选及相同评估上下文的下一页游标。 Candidates and continuation cursor for the same evaluation context. */
  items: LendingLiquidationCandidate[];
  nextCursor: string | null;
}

/** 每次发送请求时按当前界面语言协商错误文案。 Negotiate localized errors with the current interface language on each request. */
const api = createApiClient(() => i18n.language);

/** 识别可安全检查字段的 JSON 对象。 Recognize JSON values with inspectable object fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 核对公开 Solana 地址编码形状。 Verify the wire shape of a public Solana address. */
function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/** 在 BigInt 格式化前限制十进制整数及位数。 Limit integer wire format and length before BigInt formatting. */
function isUnsigned(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value);
}

/** 核对适用于精确格式化的非负小数文本。 Validate plain nonnegative decimal text for exact formatting. */
function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value);
}

/** 核对可传给日期格式化器的 ISO UTC 时间。 Validate ISO UTC timestamps before date formatting. */
function isTime(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

/** 仅接受本页评估槽中有效的已入选仓位。 Accept only eligible positions from the page's evaluation slot. */
function isCandidate(value: unknown, marketSlot: string | null): value is LendingLiquidationCandidate {
  return isRecord(value) && isAddress(value.walletAddress) && isUnsigned(value.collateralRaw) &&
    isUnsigned(value.debtRaw) && isDecimal(value.healthFactor) && isUnsigned(value.slot) &&
    value.slot === marketSlot && isTime(value.observedAt) && value.isLiquidatable === true;
}

/** 校验来源、公钥、分页及就绪状态，空列表仍是正常结果。 Validate sources, scope, pagination, and readiness while preserving a legitimate empty page. */
function isPage(value: unknown, request: LendingLiquidationListRequest): value is LendingLiquidationPage {
  if (!isRecord(value) || value.network !== request.network || value.marketAddress !== request.marketAddress ||
      !(value.marketSlot === null || isUnsigned(value.marketSlot)) ||
      !(value.observedAt === null || isTime(value.observedAt)) ||
      !Array.isArray(value.items)) return false;

  if (value.availability === 'READY') {
    /** 后端已发布的风险批次必须同时带有可审计的预言机来源。 A published risk batch must carry its auditable oracle source. */
    const { marketSlot, items } = value;
    return marketSlot !== null && value.observedAt !== null && isAddress(value.oracleAddress) &&
      isUnsigned(value.oracleSlot) && isTime(value.oraclePublishedAt) && isDecimal(value.collateralPrice) &&
      (value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length > 0)) &&
      items.every((item: unknown) => isCandidate(item, marketSlot));
  }

  return (value.availability === 'NO_SNAPSHOT' || value.availability === 'STALE' || value.availability === 'PRICE_UNAVAILABLE') &&
    value.items.length === 0 && value.nextCursor === null && value.oracleAddress === null &&
    value.oracleSlot === null && value.oraclePublishedAt === null && value.collateralPrice === null;
}

/**
 * 公开读取一个已登记市场的候选页，金额和健康度保留服务端精度。
 * Read one public candidate page of a registered market, preserving server precision for amounts and health.
 *
 * @param request 指定市场、网络及可选游标。 Market, network, and optional cursor.
 * @param signal 离开页面或切换范围后取消读取。 Signal to cancel when leaving or changing scope.
 * @returns 候选页及价格上下文。 Candidate page and its price context.
 * @throws ApiError 查询失败或响应不能用于本次列表。 Lookup failed or the response is unusable for this list.
 */
export async function listLendingLiquidations(
  request: LendingLiquidationListRequest,
  signal?: AbortSignal,
): Promise<LendingLiquidationPage> {
  /** 统一接口解包后按实际业务契约核对可空字段。 Check nullable fields against the real business contract after unwrapping the envelope. */
  const data: unknown = await unwrapApiResponse(api.GET('/api/v1/lending-markets/{address}/liquidations', {
    params: { path: { address: request.marketAddress }, query: { network: request.network, cursor: request.cursor } },
    signal,
  }));
  if (!isPage(data, request)) throw new ApiError('The API returned an invalid liquidation page.', 'invalid-response');
  return data;
}

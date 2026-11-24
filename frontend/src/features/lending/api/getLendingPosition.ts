import { i18n } from '../../../app/i18n/i18n';
import { ApiError, createApiClient, unwrapApiResponse } from '../../../shared/api/client';
import type { Network } from '../../../shared/navigation/network';

/** 「我的借款」和「我的出借」的共同查询参数。 Shared lookup parameters for My Borrowing and My Supplying. */
export interface LendingPositionRequest {
  /** 页面当前使用的 Solana 网络。 Solana network selected on the page. */
  network: Network;
  /** 当前市场状态账户的 Base58 公钥。 Base58 public key of the selected market state account. */
  marketAddress: string;
  /** 已连接钱包的 Base58 公钥。 Base58 public key of the connected wallet. */
  walletAddress: string;
}

/** 指定钱包在一个借贷市场的成功查询结果。 Successful wallet position lookup for one lending market. */
export interface LendingPositionResponse {
  /** 仓位所属网络，与请求一致。 Position network, matching the request. */
  network: Network;
  /** 仓位所属市场状态账户的 Base58 公钥。 Base58 public key of the market state account that owns the position. */
  marketAddress: string;
  /** 仓位持有人的 Base58 钱包公钥。 Base58 wallet public key of the position owner. */
  walletAddress: string;
  /** 最新钱包观测，后端尚未采集该钱包时为 null。 Latest wallet observation, or null when the wallet is unobserved. */
  snapshot: LendingPositionSnapshot | null;
}

/** 一个钱包在同一观测 slot 下的借款、出借和可判定额度。 Wallet borrowing, supplying, and determinable limits at one observed slot. */
export interface LendingPositionSnapshot {
  /** 钱包仓位观测 slot，使用无符号十进制整数字符串。 Wallet observation slot as an unsigned decimal integer string. */
  slot: string;
  /** 后端采集时间，使用 ISO 8601 UTC 文本。 Backend observation time as ISO 8601 UTC text. */
  observedAt: string;
  /** 观测所用价格的发布 slot，价格不可用时为 null。 Publish slot of the observed price, or null when unavailable. */
  oracleSlot: string | null;
  /** 后端按观测时间判定的新鲜度。 Freshness determined by the backend from the observation time. */
  freshness: 'FRESH' | 'STALE';
  /** 已锁定抵押品，以抵押 Mint 最小单位计。 Collateral held in custody, in collateral mint base units. */
  collateralRaw: string;
  /** 观测时未偿债务含已计利息，以借款 Mint 最小单位计。 Observed outstanding debt including accrued interest, in debt mint base units. */
  debtRaw: string;
  /** 观测时无量纲健康度的小数字符串，无债或无有效价格时为 null。 Observed dimensionless health factor as a decimal string, or null with no debt or usable price. */
  healthFactor: string | null;
  /** 观测时的清算标记，正债务缺价时为 null，无债务时为 false。 Observed liquidation flag, null with positive debt but no price, or false without debt. */
  isLiquidatable: boolean | null;
  /** 钱包持有的出借份额，以程序份额最小单位计。 Wallet supply shares in program share base units. */
  supplySharesRaw: string;
  /** 钱包出借仓位的价值，以借款 Mint 最小单位计。 Value of the wallet's supply position, in debt mint base units. */
  suppliedValueRaw: string;
  /** 预计最多可新增债务，以借款 Mint 最小单位计，无法确定时为 null。 Estimated additional borrowing limit in debt mint base units, or null when unknown. */
  maxBorrowRaw: string | null;
  /** 预计最多可取回抵押品，以抵押 Mint 最小单位计，无法确定时为 null。 Estimated collateral withdrawal limit in collateral mint base units, or null when unknown. */
  maxCollateralWithdrawRaw: string | null;
  /** 预计最多可提取到账额，以借款 Mint 最小单位计，无法确定时为 null。 Estimated supply payout limit in debt mint base units, or null when unknown. */
  maxSupplyWithdrawRaw: string | null;
  /** 与可提取到账额匹配的份额，以程序份额最小单位计，无法确定时为 null。 Shares associated with the supply payout in program share base units, or null when unknown. */
  maxSupplyWithdrawSharesRaw: string | null;
  /** 同 slot 的市场风险参数，没有匹配观测时为 null。 Same-slot market risk parameters, or null without a matching observation. */
  marketRisk: LendingPositionMarketRisk | null;
}

/** 「额度与清算条件」展示的风险参数。 Risk parameters shown in Borrowing Limits and Liquidation Conditions. */
export interface LendingPositionMarketRisk {
  /** 借款 LTV 上限，100 基点等于 1%。 Borrowing LTV cap in basis points, where 100 basis points equal 1%. */
  borrowLtvBps: number;
  /** 清算阈值，100 基点等于 1%。 Liquidation threshold in basis points, where 100 basis points equal 1%. */
  liquidationThresholdBps: number;
  /** 每 1 整单位抵押品对应的借款资产价格，无法提供时为 null。 Debt asset price per whole collateral token, or null when unavailable. */
  collateralPrice: string | null;
  /** 债务价值与抵押品价值的比率，例如 "0.4" 表示 40%，无法计算时为 null。 Debt-to-collateral value ratio, where "0.4" means 40%, or null when unknown. */
  currentLtv: string | null;
  /** 健康度为 1 的临界价格，以借款资产每整单位抵押品计，无法计算时为 null。 Price at a health factor of 1 in debt assets per whole collateral token, or null when unknown. */
  liquidationPrice: string | null;
}

/** 请求时读取当前界面语言，用于后端错误提示。 Read the current UI language at request time for backend errors. */
const api = createApiClient(() => i18n.language);

/**
 * 钱包连接且已选定市场后，查询供「我的借款」和「我的出借」展示的数据。
 * Fetches the data shown by My Borrowing and My Supplying once a wallet is connected and a market is selected.
 *
 * @param request 当前网络、所选市场公钥和钱包公钥。 Current network, selected market public key, and wallet public key.
 * @param signal 切换网络、市场或钱包账户时用于取消旧查询。 Signal to cancel lookups after a network, market, or wallet account change.
 * @returns 包含真实零值和可空字段的钱包仓位。 Wallet position with actual zero values and nullable fields preserved.
 * @throws ApiError 后端请求失败，或响应与当前查询的仓位不匹配。 Backend failure or a response that is unsuitable for the requested position.
 */
export async function getLendingPosition(
  request: LendingPositionRequest,
  signal?: AbortSignal,
): Promise<LendingPositionResponse> {
  /** 公共客户端拆开后的业务数据。 Business payload unwrapped by the shared client. */
  const data = await unwrapApiResponse(
    api.GET('/api/v1/lending-markets/{address}/positions/{wallet}', {
      params: {
        path: { address: request.marketAddress, wallet: request.walletAddress },
        query: { network: request.network },
      },
      signal,
    }),
  );

  /** OpenAPI 复用了 Snapshot 名称，仓位按实际返回的字段检查。 OpenAPI reuses the Snapshot name, so validate the wallet position against the actual fields. */
  const snapshot: unknown = data.snapshot;

  // 核对三重查询范围，避免在当前账户下显示其他仓位的数据。
  // Verify all three lookup identifiers so data cannot appear under the wrong position.
  if (data.network !== request.network || data.marketAddress !== request.marketAddress ||
    data.walletAddress !== request.walletAddress || (snapshot !== null && !isPositionSnapshot(snapshot))) {
    throw new ApiError('The API returned an invalid lending position.', 'invalid-response');
  }

  return {
    network: data.network,
    marketAddress: data.marketAddress,
    walletAddress: data.walletAddress,
    snapshot,
  };
}

/**
 * 检查钱包观测的金额、风险字段及时间能否安全用于展示。
 * Checks wallet amounts, risk fields, and time for safe display.
 *
 * @param value 后端返回的原始快照。 Raw snapshot from the backend.
 * @returns 字段满足仓位接口约定时为 true。 True when the fields match the position contract.
 */
function isPositionSnapshot(value: unknown): value is LendingPositionSnapshot {
  return isRecord(value) &&
    isRawInteger(value.slot) && (value.oracleSlot === null || isRawInteger(value.oracleSlot)) &&
    typeof value.observedAt === 'string' && value.observedAt.endsWith('Z') && Number.isFinite(Date.parse(value.observedAt)) &&
    (value.freshness === 'FRESH' || value.freshness === 'STALE') &&
    isRawInteger(value.collateralRaw) && isRawInteger(value.debtRaw) &&
    (value.healthFactor === null || isDecimal(value.healthFactor)) &&
    (value.isLiquidatable === null || typeof value.isLiquidatable === 'boolean') &&
    isRawInteger(value.supplySharesRaw) && isRawInteger(value.suppliedValueRaw) &&
    (value.maxBorrowRaw === null || isRawInteger(value.maxBorrowRaw)) &&
    (value.maxCollateralWithdrawRaw === null || isRawInteger(value.maxCollateralWithdrawRaw)) &&
    (value.maxSupplyWithdrawRaw === null || isRawInteger(value.maxSupplyWithdrawRaw)) &&
    (value.maxSupplyWithdrawSharesRaw === null || isRawInteger(value.maxSupplyWithdrawSharesRaw)) &&
    (value.marketRisk === null || isMarketRisk(value.marketRisk));
}

/**
 * 检查同 slot 的市场风险参数，保留缺失价格和比率的 null。
 * Checks same-slot risk parameters and preserves nulls for absent prices and ratios.
 *
 * @param value 后端返回的风险对象。 Risk object returned by the backend.
 * @returns 风险参数具有有效传输格式时为 true。 True when risk fields have valid wire formats.
 */
function isMarketRisk(value: unknown): value is LendingPositionMarketRisk {
  return isRecord(value) && isBasisPoints(value.borrowLtvBps) && isBasisPoints(value.liquidationThresholdBps) &&
    (value.collateralPrice === null || isDecimal(value.collateralPrice)) &&
    (value.currentLtv === null || isDecimal(value.currentLtv)) &&
    (value.liquidationPrice === null || isDecimal(value.liquidationPrice));
}

/**
 * 确认 JSON 值可按对象字段读取。
 * Checks that a JSON value can be read as object fields.
 *
 * @param value 待检查的响应数据。 Response data to inspect.
 * @returns 非空且非数组的对象为 true。 True for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 检查链上数量、slot 和已计息债务使用的非负整数字符串。
 * Checks nonnegative integer strings for on-chain amounts, slots, and accrued debt.
 *
 * @param value 待检查的原始数量。 Raw quantity to inspect.
 * @returns 可以按十进制整数使用时为 true。 True when the value can be used as a decimal integer.
 */
function isRawInteger(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

/**
 * 检查价格、健康度和比率使用的非负十进制文本。
 * Checks nonnegative decimal text for prices, health factors, and ratios.
 *
 * @param value 待检查的小数字符串。 Decimal string to inspect.
 * @returns 使用普通十进制格式时为 true。 True for plain decimal notation.
 */
function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value);
}

/**
 * 检查风险百分比的基点整数范围。
 * Checks the whole basis point range of a risk percentage.
 *
 * @param value 接口返回的基点数。 Basis points returned by the endpoint.
 * @returns 0 到 10,000 基点的整数为 true。 True for whole basis points from 0 through 10,000.
 */
function isBasisPoints(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

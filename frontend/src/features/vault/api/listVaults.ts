import { i18n } from '../../../app/i18n/i18n';
import { ApiError, createApiClient, unwrapApiResponse } from '../../../shared/api/client';

/**
 * GET /api/v1/vaults 的查询参数，由策略金库页面传入当前网络。
 * Query parameters for GET /api/v1/vaults. The vault page supplies the selected network.
 */
export interface VaultListRequest {
  /** 查询的 Solana 网络。 Solana network to query. */
  network: 'localnet' | 'devnet';
}

/** 成功响应中 data 的内容。 Payload in data on success. */
export interface VaultListResponse {
  /** 按金库地址排列，当前网络没有金库时为空数组。 Ordered by vault address, or an empty array when none are registered on this network. */
  items: VaultListItem[];
}

/** 一个已登记的金库及其最新快照。 A registered vault and its latest snapshot. */
export interface VaultListItem {
  /** 金库部署的 Solana 网络。 Solana network hosting this vault. */
  network: 'localnet' | 'devnet';

  /** 金库状态账户的 Base58 公钥。 Base58 public key of the vault state account. */
  address: string;

  /** 管理金库状态账户的链上程序公钥。 Public key of the on-chain program that owns the vault state account. */
  programId: string;

  /** 存入、赎回及估值使用的结算资产。 Settlement asset used for deposits, redemptions, and valuation. */
  quoteAsset: VaultAsset;

  /** 代表金库权益的份额资产。 Share asset representing ownership in the vault. */
  shareAsset: VaultAsset;

  /** 策略持仓使用的资产，尚未配置时为 null。 Strategy asset, or null when unconfigured. */
  strategyAsset: VaultAsset | null;

  /** 借贷市场状态账户的公钥，尚未配置时为 null。 Public key of the lending market state account, or null when unconfigured. */
  lendingMarketAddress: string | null;

  /** 最新观测快照，尚未同步时为 null。 Latest observed snapshot, or null when none has been indexed. */
  latestSnapshot: VaultLatestSnapshot | null;
}

/** 资产标识与显示精度。 Asset identifier and display precision. */
export interface VaultAsset {
  /** 资产的链上 Mint 公钥。 On-chain public key of the asset mint. */
  mint: string;

  /** 资产简称，尚未登记简称时为 null。 Asset ticker, or null when unregistered. */
  symbol: string | null;

  /** Mint 的小数位数，用于把最小单位换成展示金额。 Mint decimal precision for converting base units to display amounts. */
  decimals: number;
}

/** 金库最新快照。金额、份额和 slot 用十进制整数字符串传输。 Latest vault snapshot. Amounts, shares, and slots are decimal integer strings. */
export interface VaultLatestSnapshot {
  /** 采集账户时的观测 slot。 Slot at which the accounts were observed. */
  slot: string;

  /** 快照采集时间，使用 ISO 8601 UTC 格式。 Snapshot observation time in ISO 8601 UTC. */
  observedAt: string;

  /** 预言机价格的发布 slot，没有有效价格时为 null。 Oracle price publish slot, or null when no valid price is available. */
  oracleSlot: string | null;

  /** 金库闲置资金，以结算资产最小单位计。 Idle vault cash in settlement asset base units. */
  cashRaw: string;

  /** 策略资产持仓，以策略资产最小单位计。 Strategy holdings in strategy asset base units. */
  strategyAmountRaw: string;

  /** 策略资产估值，以结算资产最小单位计，缺少有效估值时为 null。 Strategy asset value in settlement asset base units, or null when unavailable. */
  strategyValueRaw: string | null;

  /** 出借仓位的账面价值，以结算资产最小单位计。 Lending position book value in settlement asset base units. */
  lendValueRaw: string;

  /** 可从借贷池立即提取的金额，以结算资产最小单位计。 Immediately withdrawable lending pool amount in settlement asset base units. */
  lendingWithdrawableRaw: string;

  /** 金库总净值，以结算资产最小单位计，无法估值时为 null。 Total vault NAV in settlement asset base units, or null when unavailable. */
  navRaw: string | null;

  /** 已发行份额总量，以份额资产最小单位计。 Total issued shares in share asset base units. */
  totalSharesRaw: string;

  /** 后端按采集时间与配置阈值判断的快照状态。 Snapshot freshness determined by the backend from its observation time and configured threshold. */
  freshness: 'FRESH' | 'STALE';
}

/** 发请求时读取当前界面语言，让后端返回对应语言的错误提示。 Read the UI language at request time so backend errors use that language. */
const api = createApiClient(() => i18n.language);

/**
 * 查询当前网络的金库概况，为策略金库页提供金库列表和最新快照。
 * Fetch the vault list and latest snapshots for the strategy vault page on the selected network.
 *
 * @param params 金库列表查询参数，由调用方提供当前网络。 Vault list parameters containing the caller's selected network.
 * @param signal 用于取消过期查询的可选信号。 Optional signal for canceling an outdated query.
 * @returns 后端响应 data 中的金库列表，当前网络没有金库时 items 为空数组。
 *          Vault list payload from data, with empty items if no vaults are registered on the network.
 * @throws ApiError 后端请求失败或返回的数据结构无效时抛出。 Thrown for an API failure or an invalid response payload.
 */
export async function listVaults(
  params: VaultListRequest,
  signal?: AbortSignal,
): Promise<VaultListResponse> {
  /** 已拆开后端统一响应的 data，保留原始金额和空值。 Unwrapped data with the amounts and nulls as received from the API. */
  const data = await unwrapApiResponse(
    api.GET('/api/v1/vaults', {
      params: { query: { network: params.network } },
      signal,
    }),
  );

  // 缺失列表属于响应异常，空数组是当前网络没有登记金库。
  // A missing list is an invalid response, while an empty array means the network has no registered vaults.
  if (!Array.isArray(data.items)) {
    throw new ApiError('The vault list response is missing the items array.', 'invalid-response');
  }

  // 字段及其空值以本文件核对的后端契约为准，保留返回条目原值。
  // Use the verified backend contract in this file for fields and nullability, preserving every returned item as received.
  return { items: data.items as VaultListItem[] };
}

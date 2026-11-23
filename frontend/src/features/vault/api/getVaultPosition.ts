import { i18n } from '../../../app/i18n/i18n';
import { ApiError, createApiClient, unwrapApiResponse } from '../../../shared/api/client';

/** 「我的金库份额」的查询条件。 Lookup parameters for My Vault Shares. */
export interface VaultPositionRequest {
  /** 页面当前选中的 Solana 网络。 Solana network selected on the page. */
  network: 'localnet' | 'devnet';

  /** 当前金库状态账户的 Base58 公钥。 Base58 public key of the selected vault state account. */
  address: string;

  /** 已连接钱包的 Base58 公钥。 Base58 public key of the connected wallet. */
  wallet: string;
}

/** 成功响应中 data 的内容。 Payload in data on success. */
export interface VaultPositionResponse {
  /** 持仓所属网络，与请求一致。 Network that owns the position, matching the request. */
  network: 'localnet' | 'devnet';

  /** 持仓所属金库状态账户的公钥。 Public key of the vault state account that owns the position. */
  vaultAddress: string;

  /** 份额持有人的钱包公钥。 Wallet public key of the share holder. */
  walletAddress: string;

  /** 最新钱包快照，后端尚未观测到仓位时为 null。 Latest wallet snapshot, or null if the backend has not observed the position. */
  snapshot: VaultPositionSnapshot | null;
}

/** 钱包在指定观测 slot 的份额余额和赎回估算。 Wallet shares and estimated redemption at one observed slot. */
export interface VaultPositionSnapshot {
  /** 观测 slot，使用十进制整数字符串。 Observed slot as a decimal integer string. */
  slot: string;

  /** 快照采集时间，使用 ISO 8601 UTC 文本。 Snapshot observation time as ISO 8601 UTC text. */
  observedAt: string;

  /** 后端按采集时间和配置阈值判断的新鲜度。 Freshness determined by the backend from observation time and its configured threshold. */
  freshness: 'FRESH' | 'STALE';

  /** 持有份额，以份额 Mint 最小单位计，已观测为零时是 "0"。 Shares held in share mint base units, or "0" when observed to be empty. */
  sharesRaw: string;

  /** 全部份额的估值，以计价 Mint 最小单位计，无法估值时为 null。 Value in quote mint base units, or null if unavailable. */
  positionValueRaw: string | null;

  /** 可赎回上限，以份额 Mint 最小单位计，无法计算时为 null。 Redemption limit in share mint base units, or null if unavailable. */
  maxRedeemSharesRaw: string | null;

  /** 按上限赎回的预计到账，以计价 Mint 最小单位计，无法计算时为 null。 Estimated payout at the limit in quote mint base units, or null if unavailable. */
  redeemableRaw: string | null;
}

/** 请求时读取当前界面语言，用于后端错误提示。 Read the current UI language at request time for backend errors. */
const api = createApiClient(() => i18n.language);

/**
 * 读取指定钱包在单个金库的最新持仓，供「我的金库份额」展示。
 * Fetch the latest wallet position in one vault for My Vault Shares.
 *
 * @param params 当前网络、所选金库地址及已连接钱包公钥。 Selected network, vault address, and connected wallet public key.
 * @param signal 切换账户、金库或网络时用于取消旧查询的信号。 Signal for canceling prior lookups after an account, vault, or network change.
 * @returns 钱包持仓及其地址信息，后端尚未采集到钱包时 snapshot 为 null。 Position and address scope, with a null snapshot if unobserved.
 * @throws ApiError HTTP 请求失败，或返回的数据无法安全用于该持仓。 HTTP failure or a response that cannot safely be used for the position.
 */
export async function getVaultPosition(
  params: VaultPositionRequest,
  signal?: AbortSignal,
): Promise<VaultPositionResponse> {
  /** 已拆开后端统一响应的业务数据。 Business data from the unwrapped backend response. */
  const data = await unwrapApiResponse(
    api.GET('/api/v1/vaults/{address}/positions/{wallet}', {
      params: {
        path: { address: params.address, wallet: params.wallet },
        query: { network: params.network },
      },
      signal,
    }),
  );

  /** 快照按实际 JSON 字段检查，因为生成的 OpenAPI 类型复用了 Snapshot 名称。 Check the JSON fields because the generated OpenAPI type reuses the Snapshot name. */
  const snapshot: unknown = data.snapshot;

  // 校验响应的网络和地址，避免在当前钱包或金库下展示其他持仓。
  // Verify the network and addresses to keep a different position from appearing under the current wallet or vault.
  if (
    data.network !== params.network || data.vaultAddress !== params.address ||
    data.walletAddress !== params.wallet || (snapshot !== null && !isVaultPositionSnapshot(snapshot))
  ) {
    throw new ApiError('The API returned an invalid vault position.', 'invalid-response');
  }

  return {
    network: data.network,
    vaultAddress: data.vaultAddress,
    walletAddress: data.walletAddress,
    snapshot,
  };
}

/**
 * 检查可用于显示的持仓快照，保留真实的零和空估值。
 * Checks a position snapshot for display, preserving actual zeros and unavailable valuations.
 *
 * @param value 来自后端 JSON 的快照字段。 Snapshot field from the backend JSON payload.
 * @returns 快照包含所需字段及有效的金额与时间值时为 true。 True when required fields and valid amount and time values are present.
 */
function isVaultPositionSnapshot(value: unknown): value is VaultPositionSnapshot {
  return typeof value === 'object' && value !== null &&
    'slot' in value && isRawInteger(value.slot) &&
    'observedAt' in value && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt)) &&
    'freshness' in value && (value.freshness === 'FRESH' || value.freshness === 'STALE') &&
    'sharesRaw' in value && isRawInteger(value.sharesRaw) &&
    'positionValueRaw' in value && (value.positionValueRaw === null || isRawInteger(value.positionValueRaw)) &&
    'maxRedeemSharesRaw' in value && (value.maxRedeemSharesRaw === null || isRawInteger(value.maxRedeemSharesRaw)) &&
    'redeemableRaw' in value && (value.redeemableRaw === null || isRawInteger(value.redeemableRaw));
}

/**
 * 检查 slot 和代币最小单位共用的无符号十进制整数格式。
 * Checks the unsigned decimal integer format shared by slots and token base units.
 *
 * @param value 需要检查的 JSON 字段。 JSON field to check.
 * @returns 字段是由十进制数字组成的非空字符串时为 true。 True for a nonempty string of decimal digits.
 */
function isRawInteger(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

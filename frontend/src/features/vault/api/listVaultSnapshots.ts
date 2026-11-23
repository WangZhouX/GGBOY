import { i18n } from '../../../app/i18n/i18n';
import { ApiError, createApiClient, unwrapApiResponse } from '../../../shared/api/client';

/** 「每份净值走势」的历史快照查询条件。 History lookup parameters for the NAV per Share chart. */
export interface VaultHistoryRequest {
  /** 页面当前选择的 Solana 网络。 Solana network selected on the page. */
  network: 'localnet' | 'devnet';

  /** 选中金库状态账户的 Base58 公钥。 Base58 public key of the selected vault state account. */
  address: string;

  /** 每页条数，允许 1 至 100，省略时后端默认 20。 Page size from 1 to 100, defaulting to 20 on the server when omitted. */
  limit?: number;

  /** 同一网络与金库上一页的 nextCursor，首次请求省略。 Previous page's nextCursor for the same network and vault, omitted on the first request. */
  cursor?: string;
}

/** 成功响应中 data 的内容。 Payload in data on success. */
export interface VaultHistoryResponse {
  /** 按观测 slot 数值倒序排列的当前页，允许为空。 Current page, ordered by descending numeric observation slot and possibly empty. */
  items: VaultHistorySnapshot[];

  /** 用于查询更早快照的游标，末页为 null。 Cursor for older snapshots, or null on the final page. */
  nextCursor: string | null;
}

/** 金库在一个观测 slot 的历史快照。 Historical vault snapshot at an observed slot. */
export interface VaultHistorySnapshot {
  /** 采集金库状态时的 slot，使用十进制整数字符串。 Vault state observation slot as a decimal integer string. */
  slot: string;

  /** 快照采集时间，使用 ISO 8601 UTC 文本。 Snapshot observation time as ISO 8601 UTC text. */
  observedAt: string;

  /** 有效预言机价格的发布 slot，无有效价格时为 null。 Valid oracle price publish slot, or null when unavailable. */
  oracleSlot: string | null;

  /** 金库现金，以计价 Mint 最小单位计。 Vault cash in quote mint base units. */
  cashRaw: string;

  /** 策略资产数量，以策略 Mint 最小单位计。 Strategy holdings in strategy mint base units. */
  strategyAmountRaw: string;

  /** 策略资产估值，以计价 Mint 最小单位计，无法估值时为 null。 Strategy valuation in quote mint base units, or null when unavailable. */
  strategyValueRaw: string | null;

  /** 出借仓位的账面价值，以计价 Mint 最小单位计。 Lending position book value in quote mint base units. */
  lendValueRaw: string;

  /** 观测时可从借贷池提取的金额，以计价 Mint 最小单位计。 Amount withdrawable from the lending pool at observation, in quote mint base units. */
  lendingWithdrawableRaw: string;

  /** 金库总净值，以计价 Mint 最小单位计，无法估值时为 null。 Total vault NAV in quote mint base units, or null when unavailable. */
  navRaw: string | null;

  /** 观测时的流通份额，以份额 Mint 最小单位计。 Outstanding shares at observation, in share mint base units. */
  totalSharesRaw: string;
}

/** 请求时读取当前界面语言，用于后端错误提示。 Read the current UI language at request time for backend errors. */
const api = createApiClient(() => i18n.language);

/**
 * 查询选中金库的一页历史快照，供策略金库页绘制每份净值走势。
 * Fetch one page of historical snapshots for the selected vault's NAV per Share chart.
 *
 * @param params 网络、金库地址和可选的分页参数。 Network, vault address, and optional pagination parameters.
 * @param signal 页面切换查询时用于取消旧请求的信号。 Signal for canceling the prior request when the page changes the query.
 * @returns 保留服务端顺序的一页快照和下一页游标。 Snapshot page in server order and the continuation cursor.
 * @throws ApiError HTTP 请求失败，或响应中包含无效数据。 HTTP failure or invalid response data.
 */
export async function listVaultSnapshots(
  params: VaultHistoryRequest,
  signal?: AbortSignal,
): Promise<VaultHistoryResponse> {
  /** 拆开统一响应后得到的分页结果。 History page from the unwrapped response envelope. */
  const data = await unwrapApiResponse(
    api.GET('/api/v1/vaults/{address}/snapshots', {
      params: {
        path: { address: params.address },
        query: { network: params.network, limit: params.limit, cursor: params.cursor },
      },
      signal,
    }),
  );
  /** 页记录和游标按实际 JSON 校验，包含生成类型未标明的 null。 Check page items and cursor against the actual JSON, including nulls unmarked by the generated types. */
  const { items, nextCursor }: { items?: unknown; nextCursor?: unknown } = data;

  // 校验金额和时间后原样返回，画图时仍可区分真实零值和估值缺口。
  // Return validated amounts and times unchanged so the chart can distinguish zero from a valuation gap.
  if (
    !Array.isArray(items) || !items.every(isVaultHistorySnapshot) ||
    (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.trim() === '' || items.length === 0))
  ) {
    throw new ApiError('The API returned an invalid vault history page.', 'invalid-response');
  }

  return { items, nextCursor };
}

/**
 * 检查所有历史快照字段及其空值约定。
 * Check every snapshot field and its nullability.
 *
 * @param value 来自后端 JSON 的一条历史记录。 A history record from the backend JSON payload.
 * @returns 快照包含有效采集时间、整数字符串和允许的空值时为 true。 True for valid observation time, integer strings, and allowed nulls.
 */
function isVaultHistorySnapshot(value: unknown): value is VaultHistorySnapshot {
  return typeof value === 'object' && value !== null &&
    'slot' in value && isRawInteger(value.slot) &&
    'observedAt' in value && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt)) &&
    'oracleSlot' in value && (value.oracleSlot === null || isRawInteger(value.oracleSlot)) &&
    'cashRaw' in value && isRawInteger(value.cashRaw) &&
    'strategyAmountRaw' in value && isRawInteger(value.strategyAmountRaw) &&
    'strategyValueRaw' in value && (value.strategyValueRaw === null || isRawInteger(value.strategyValueRaw)) &&
    'lendValueRaw' in value && isRawInteger(value.lendValueRaw) &&
    'lendingWithdrawableRaw' in value && isRawInteger(value.lendingWithdrawableRaw) &&
    'navRaw' in value && (value.navRaw === null || isRawInteger(value.navRaw)) &&
    'totalSharesRaw' in value && isRawInteger(value.totalSharesRaw);
}

/**
 * 检查 slot 和金额共用的无符号十进制整数格式。
 * Check the unsigned decimal integer format shared by slots and amounts.
 *
 * @param value 需要检查的 JSON 字段。 JSON field to check.
 * @returns 字段是由十进制数字组成的非空字符串时为 true。 True for a nonempty string of decimal digits.
 */
function isRawInteger(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

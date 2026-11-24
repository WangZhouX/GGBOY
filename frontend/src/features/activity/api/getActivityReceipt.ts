import { i18n } from '../../../app/i18n/i18n';
import { ApiError, createApiClient, unwrapApiResponse } from '../../../shared/api/client';
import type { Network } from '../../../shared/navigation/network';
import { isActivityItem } from './activityResponse';
import type { ActivityItem } from './listActivities';

/** 唯一定位一条交易活动回执的查询条件。 Lookup parameters that identify one activity receipt. */
export interface ActivityReceiptRequest {
  /** 交易所属的 Solana 网络。 Solana network containing the transaction. */
  network: Network;
  /** Base58 编码的 64 字节交易主签名。 Base58-encoded 64-byte primary transaction signature. */
  signature: string;
  /** 区分同一交易中不同业务事件的零基事件序号。 Zero-based index distinguishing events within the same transaction. */
  eventIndex: number;
}

/** 回执成功响应的数据与一条列表记录使用同一业务事件结构。 A successful receipt shares its event shape with a list record. */
export type ActivityReceiptResponse = ActivityItem;

/** 每次请求时从当前界面读语言。 Get the current UI language for each request. */
const api = createApiClient(() => i18n.language);

/**
 * 按网络、签名和序号请求已索引的单条回执。
 * Fetch one indexed receipt by network, signature, and event index.
 *
 * @param request 回执所在的网络和唯一事件标识。 Network and unique identifiers for the receipt.
 * @param signal 路由切换时取消旧回执读取。 Cancel a stale receipt lookup when the route changes.
 * @returns 包含完整参与方和资产变动的已校验回执。 Validated receipt with all participants and asset movements.
 * @throws ApiError 回执未索引、请求失败或响应标识不匹配。 Unindexed receipt, a request failure, or mismatched response identifiers.
 */
export async function getActivityReceipt(
  request: ActivityReceiptRequest,
  signal?: AbortSignal,
): Promise<ActivityReceiptResponse> {
  /** 服务端返回的事件按实际字段和三个定位参数校验。 Check the response against the actual event shape and all three lookup identifiers. */
  const receipt: unknown = await unwrapApiResponse(
    api.GET('/api/v1/activities/{signature}/events/{eventIndex}', {
      params: {
        path: { signature: request.signature, eventIndex: request.eventIndex },
        query: { network: request.network },
      },
      signal,
    }),
  );
  if (!isActivityItem(receipt) || receipt.network !== request.network ||
    receipt.signature !== request.signature || receipt.eventIndex !== request.eventIndex) {
    throw new ApiError('The API returned an invalid activity receipt.', 'invalid-response');
  }
  return receipt;
}

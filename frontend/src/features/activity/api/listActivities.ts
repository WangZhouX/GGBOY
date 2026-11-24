import { i18n } from '../../../app/i18n/i18n';
import { ApiError, createApiClient, unwrapApiResponse } from '../../../shared/api/client';
import type { Network } from '../../../shared/navigation/network';
import { isActivityItem } from './activityResponse';

/** 后端活动分类，省略分类时返回全部。 Activity categories, with omission selecting all categories. */
export type ActivityCategory = 'vault' | 'lending' | 'strategy';

/** 交易活动列表的一页查询参数。 Parameters for one page of activity records. */
export interface ListActivitiesRequest {
  /** 当前活动所属的 Solana 网络。 Solana network containing the activity. */
  network: Network;
  /** 可选业务分类。 Optional business category. */
  category?: ActivityCategory;
  /** 可选参与钱包的完整 Base58 公钥。 Optional complete Base58 key for a participating wallet. */
  wallet?: string;
  /** 可选金库或借贷市场状态账户的完整 Base58 公钥。 Optional complete Base58 key of a vault or lending market state account. */
  subjectAddress?: string;
  /** 可选精确匹配的 Base58 主签名。 Optional exact Base58 primary transaction signature. */
  signature?: string;
  /** 可选事件类型集合，发送时按重复的 type 参数匹配任一项。 Optional event codes, sent as repeated type parameters for OR matching. */
  types?: readonly string[];
  /** 单页条数，范围 1 至 100，缺省由后端决定。 Page size from 1 to 100, with the default supplied by the backend. */
  limit?: number;
  /** 同一查询上一页返回的原样游标，首屏省略。 Unmodified cursor from the prior page of the same query, omitted initially. */
  cursor?: string;
}

/** 已索引业务事件的参与方。 Participant in an indexed business event. */
export interface ActivityParticipant {
  /** 参与的钱包或 PDA 的 Base58 公钥。 Base58 public key of the participating wallet or PDA. */
  walletAddress: string;
  /** 后端返回的业务角色代码，同一钱包可有多个角色。 Business role code from the backend, with multiple roles possible per wallet. */
  role: string;
}

/** 事件中一项实际的代币变动。 One actual token movement within an event. */
export interface ActivityAsset {
  /** 事件中从零开始的资产项位置。 Zero-based position of this asset leg within the event. */
  legIndex: number;
  /** 发生变动的代币 Mint 的 Base58 公钥。 Base58 public key of the token mint that changed. */
  mint: string;
  /** 按同一网络及 Mint 匹配的代币简称，目录缺失时为空。 Token ticker from the matching network and mint, absent when unregistered. */
  symbol?: string | null;
  /** 交易发生时的代币小数位数，范围 0 至 255。 Token decimals at transaction time, from 0 to 255. */
  decimals: number;
  /** 代币最小单位的 u64 十进制整数字符串。 Decimal u64 string in token base units. */
  amountRaw: string;
  /** 描述事件中代币流向或变动的稳定代码。 Stable code for the token movement or direction in this event. */
  legType: string;
}

/** 一条已索引的链上业务事件，列表和回执共用。 One indexed on-chain business event shared by the list and receipt. */
export interface ActivityItem {
  /** 交易所在的 Solana 网络。 Solana network containing the transaction. */
  network: Network;
  /** 交易主签名，Base58 编码。 Base58-encoded primary transaction signature. */
  signature: string;
  /** 交易中从零开始的事件序号。 Zero-based index of the event within the transaction. */
  eventIndex: number;
  /** 确认的链上 slot，以十进制整数字符串表示。 Confirmed on-chain slot as a decimal integer string. */
  slot: string;
  /** 后端提供的区块时间，未知时为空。 Block time supplied by the backend, or null when unknown. */
  blockTime: string | null;
  /** 发出事件的链上程序公钥。 Public key of the on-chain program that emitted the event. */
  programId: string;
  /** 事件所属模块代码。 Code of the business module that owns the event. */
  module: string;
  /** 业务事件类型代码。 Business event type code. */
  type: string;
  /** 金库或借贷市场状态账户的 Base58 公钥。 Base58 public key of the vault or lending market state account. */
  subjectAddress: string;
  /** 该事件的全部参与方和角色。 All participants and roles for the event. */
  participants: ActivityParticipant[];
  /** 按 legIndex ASC 排序的代币变动，缺少记录时为空列表。 Token movements ordered by ascending legIndex, or an empty array. */
  assets: ActivityAsset[];
}

/** 列表成功响应中 data 的内容。 List payload inside a successful envelope. */
export interface ActivitiesPage {
  /** 服务端排序的一页业务事件，允许为空。 One page of events in server order, possibly empty. */
  items: ActivityItem[];
  /** 下一页游标，末页为 null。 Continuation cursor, or null for the final page. */
  nextCursor: string | null;
}

/** 每次请求前读取界面语言以获得对应的后端错误信息。 Read the UI language for each request to localize backend errors. */
const api = createApiClient(() => i18n.language);

/**
 * 查询一页已索引交易活动，供记录页或嵌入各业务区块。
 * Fetch a page of indexed activity for the records page or an embedded business section.
 *
 * @param request 网络、精确筛选条件及可选分页参数。 Network, exact filters, and optional pagination settings.
 * @param signal 取消网络、查询或路由切换后已不再需要的请求。 Cancel a request after its network, query, or route changes.
 * @returns 已校验当前网络的事件页，保持后端返回顺序。 Validated network-scoped event page in server order.
 * @throws ApiError 后端拒绝查询，或响应结构违反接口契约。 Backend rejection or an invalid response shape.
 */
export async function listActivities(request: ListActivitiesRequest, signal?: AbortSignal): Promise<ActivitiesPage> {
  /** OpenAPI 查询，数组由客户端序列化成重复的 type 参数。 OpenAPI query with types serialized by the client as repeated parameters. */
  const query = {
    network: request.network,
    category: request.category,
    wallet: request.wallet,
    subjectAddress: request.subjectAddress,
    signature: request.signature,
    type: request.types?.length ? [...request.types] : undefined,
    limit: request.limit,
    cursor: request.cursor,
  };
  /** OpenAPI 生成类型没有标记末页的 null，按实际响应校验。 The generated type omits the nullable final cursor, so validate the actual response. */
  const { items, nextCursor }: { items?: unknown; nextCursor?: unknown } = await unwrapApiResponse(
    api.GET('/api/v1/activities', { params: { query }, signal }),
  );

  if (!Array.isArray(items) || !items.every((item: unknown) => isActivityItem(item) && item.network === request.network) ||
    (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.trim() === '' || items.length === 0))) {
    throw new ApiError('The API returned an invalid activity page.', 'invalid-response');
  }
  return { items, nextCursor };
}

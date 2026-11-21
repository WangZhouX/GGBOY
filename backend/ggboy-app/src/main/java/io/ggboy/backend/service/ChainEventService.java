package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.api.ActivityCursor;
import io.ggboy.backend.api.ActivityQuery;
import io.ggboy.backend.api.ActivityResponse;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.common.api.CursorPage;
import io.ggboy.common.api.SolanaNetwork;

import java.util.Optional;

/**
 * 提供交易事件的基础持久化操作，以及活动列表和单条回执的跨表查询。
 * Provides basic event persistence and multi-table reads for activity history and receipts.
 */
public interface ChainEventService extends IService<ChainEventDO> {

    /**
     * 按交易 slot、交易签名和事件序号倒序分页，每个业务事件占一条记录。
     * Pages by slot, transaction signature, and event index in descending order, with one item per business event.
     *
     * @param query 已校验的网络、筛选条件及每页条数。 Validated network, filters, and page size.
     * @param cursor 已校验的排他续页边界，首屏为空。 Validated exclusive continuation boundary, or null for the first page.
     * @return 携带完整参与方、资产明细和下一页游标的活动分页。 Activity page with full participants, asset legs, and a continuation cursor.
     */
    CursorPage<ActivityResponse> listActivities(ActivityQuery query, ActivityCursor cursor);

    /**
     * 在交易活动或最近金库交易打开「查看回执」时，读取一个已索引事件的完整详情。
     * Loads one complete indexed event when its receipt is opened in Activity or Recent Vault Transactions.
     *
     * @param network 已校验的 Solana 网络。 Validated Solana network.
     * @param signature 已校验的 64 字节交易主签名的 Base58 文本。 Validated Base58 primary transaction signature encoding 64 bytes.
     * @param eventIndex 交易内从零开始的非负事件序号。 Nonnegative, zero-based event index within the transaction.
     * @return 回执包含交易时间、完整参与方和资产变动，无匹配的索引事件时为空。
     *        Receipt with transaction time, full participants and asset movements, or empty if no indexed event matches.
     */
    Optional<ActivityResponse> getActivityReceipt(SolanaNetwork network, String signature, int eventIndex);
}

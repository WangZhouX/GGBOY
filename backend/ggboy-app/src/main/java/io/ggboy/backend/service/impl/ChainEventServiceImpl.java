package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.api.ActivityCursor;
import io.ggboy.backend.api.ActivityQuery;
import io.ggboy.backend.api.ActivityResponse;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.entity.ChainEventKey;
import io.ggboy.backend.entity.ChainTransactionDO;
import io.ggboy.backend.mapper.ChainEventAssetMapper;
import io.ggboy.backend.mapper.ChainEventMapper;
import io.ggboy.backend.mapper.ChainEventParticipantMapper;
import io.ggboy.backend.mapper.ChainTransactionMapper;
import io.ggboy.backend.service.ChainEventService;
import io.ggboy.common.api.CursorPage;
import io.ggboy.common.api.SolanaNetwork;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 组织活动分页与单条回执查询，并共享参与方和资产变动的响应组装。
 * Coordinates activity pagination and receipt lookup with shared assembly of participants and asset movements.
 */
@Service
public class ChainEventServiceImpl extends ServiceImpl<ChainEventMapper, ChainEventDO>
        implements ChainEventService {

    /** 每次数据库查询最多读取的父交易条数。 Maximum parent transactions read per database batch. */
    private static final int TRANSACTION_BATCH_SIZE = 100;

    /** 按 slot 和签名读取父交易批次。 Reads batches of parent transactions by slot and signature. */
    private final ChainTransactionMapper transactionMapper;

    /** 匹配参与钱包，或批量读取完整参与方。 Matches wallets or batch-loads complete participants. */
    private final ChainEventParticipantMapper participantMapper;

    /** 按选定事件读取完整的资产变动。 Loads all asset movements for the selected events. */
    private final ChainEventAssetMapper assetMapper;

    /**
     * 注入活动列表与回执查询的依赖。业务事件查询使用继承的基础 Mapper。
     * Injects activity list and receipt dependencies. Event reads use the inherited base mapper.
     *
     * @param transactionMapper 父交易查询。 Parent transaction queries.
     * @param participantMapper 事件参与方查询。 Event participant queries.
     * @param assetMapper 事件资产变动查询。 Event asset movement queries.
     */
    public ChainEventServiceImpl(
            ChainTransactionMapper transactionMapper,
            ChainEventParticipantMapper participantMapper,
            ChainEventAssetMapper assetMapper
    ) {
        this.transactionMapper = transactionMapper;
        this.participantMapper = participantMapper;
        this.assetMapper = assetMapper;
    }

    /**
     * 在同一个数据库读视图中确定分页事件并补齐其明细。
     * Selects page events and hydrates their details in one consistent database view.
     *
     * @param query 已校验的网络、筛选条件与每页条数。 Validated network, filters, and page size.
     * @param cursor 已校验的排他续页边界，可为空。 Validated exclusive continuation boundary, or null.
     * @return 按事件稳定倒序的分页结果。 Activity page in stable descending event order.
     */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public CursorPage<ActivityResponse> listActivities(ActivityQuery query, ActivityCursor cursor) {
        // 多取一个匹配事件判断是否还有下一页，返回数量仍以请求的 limit 为准。
        // Read one extra matching event to detect a following page, while honoring the requested return limit.
        List<ActivityCandidate> matches = selectPageCandidates(query, cursor);
        if (matches.isEmpty()) {
            return new CursorPage<>(List.of(), null);
        }

        // 游标锚定本页最后一个实际返回的事件，保留额外事件给下一页。
        // Anchor the cursor to the last event actually returned, leaving the extra event for the next page.
        boolean hasMore = matches.size() > query.limit();
        List<ActivityCandidate> page = hasMore ? matches.subList(0, query.limit()) : matches;
        String nextCursor = hasMore ? ActivityCursor.encode(query, page.getLast().toCursor()) : null;
        return new CursorPage<>(loadActivityRows(query.network().wireValue(), page), nextCursor);
    }

    /**
     * 在同一只读事务中查询已索引回执，复用活动列表的参与方和资产变动组装。
     * Loads an indexed receipt in one read-only transaction and reuses activity list detail assembly.
     *
     * @param network 已校验的网络，用于隔离相同签名在不同网络的事件。 Validated network isolating the same signature across networks.
     * @param signature 已校验的 Base58 交易主签名。 Validated Base58 primary transaction signature.
     * @param eventIndex 该交易内从零开始的事件序号。 Zero-based event index within the transaction.
     * @return 对应事件的完整回执，未索引该事件时为空。 Complete receipt, or empty if the exact event is unindexed.
     * @throws IllegalStateException 已索引事件未找到外键关联的父交易。 An indexed event has no parent transaction despite its foreign key.
     */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Optional<ActivityResponse> getActivityReceipt(SolanaNetwork network, String signature, int eventIndex) {
        // 使用网络和完整事件键精确匹配，同一交易的其他事件不构成本次回执。
        // Match the network and complete event key so sibling events do not resolve this receipt.
        String networkValue = network.wireValue();
        ChainEventDO event = getBaseMapper().selectByEventKey(networkValue, new ChainEventKey(signature, eventIndex));
        if (event == null) {
            return Optional.empty();
        }

        // 在同一读视图中取得父交易的 slot 和区块时间，保持外键关系和精度。
        // Read the parent slot and block time in the same snapshot to preserve the foreign-key relationship and precision.
        ChainTransactionDO transaction = transactionMapper.selectByNetworkAndSignature(networkValue, signature);
        if (transaction == null) {
            throw new IllegalStateException("Indexed activity has no parent transaction");
        }

        // 按列表相同规则加载该事件的全部角色及资产项，保留无明细时的空列表。
        // Load every role and asset leg using the list's rules, retaining empty arrays when details are absent.
        return Optional.of(loadActivityRows(networkValue, List.of(new ActivityCandidate(transaction, event))).getFirst());
    }

    /**
     * 按数据库中的父交易顺序分批读取，收集至多 limit 加一条匹配事件。
     * Scans parent transactions in database order and collects at most limit plus one matching events.
     *
     * @param query 适用于所有批次的网络、筛选条件与每页条数。 Network, filters, and page size for every batch.
     * @param cursor 已校验的排他事件边界，首屏为空。 Validated exclusive event boundary, or null for the first page.
     * @return 按 slot、签名、事件序号倒序排列的候选事件。 Candidates ordered by descending slot, signature, and event index.
     */
    private List<ActivityCandidate> selectPageCandidates(ActivityQuery query, ActivityCursor cursor) {
        // 每次查询限定同一网络。返回缓冲区最多保留一页和一个用于探测后续页的事件。
        // Scope every read to one network. Retain only one response page plus a lookahead event.
        String network = query.network().wireValue();
        int fetchCount = query.limit() + 1;
        List<ActivityCandidate> matches = new ArrayList<>(fetchCount);

        // 续页首次扫描包含游标同一笔交易，因为该交易可能还有更早的事件。
        // Include the cursor's transaction in the first scan because it may contain older events.
        BigInteger boundarySlot = cursor == null ? null : cursor.slot();
        String boundarySignature = cursor == null ? null : cursor.signature();
        boolean includeBoundary = cursor != null;
        while (matches.size() < fetchCount) {
            // 交易排序及签名比较由 PostgreSQL 统一处理，避免 Java 比较和数据库排序不一致。
            // Let PostgreSQL order and compare signatures consistently across every batch.
            List<ChainTransactionDO> transactions = transactionMapper.selectActivityBatch(
                    network, query.signature(), boundarySlot, boundarySignature, includeBoundary, TRANSACTION_BATCH_SIZE);
            if (transactions.isEmpty()) {
                break;
            }
            appendMatchingEvents(query, cursor, transactions, matches, fetchCount);
            if (transactions.size() < TRANSACTION_BATCH_SIZE) {
                break;
            }

            // 下一批从当前批次末条交易严格向后查，避免重复扫描父交易。
            // Resume strictly after this batch's last transaction to avoid rescanning it.
            ChainTransactionDO lastTransaction = transactions.getLast();
            boundarySlot = lastTransaction.slot();
            boundarySignature = lastTransaction.signature();
            includeBoundary = false;
        }
        return matches;
    }

    /**
     * 将一批父交易中的匹配事件按父交易顺序和事件序号顺序追加到分页候选。
     * Appends matching events in parent-transaction order and descending event-index order.
     *
     * @param query 已校验的查询网络及筛选条件。 Validated query network and filters.
     * @param cursor 用于排除边界交易中已返回事件的游标。 Cursor used to exclude returned events in the boundary transaction.
     * @param transactions 数据库返回的一批父交易，按 slot、签名倒序。 Database-ordered parent transactions, descending by slot and signature.
     * @param matches 接收本批匹配事件的缓冲区。 Destination buffer for events matched in this batch.
     * @param fetchCount 缓冲区最多保留的事件数，含用于判断下一页的一条。 Maximum buffered events including the lookahead.
     */
    private void appendMatchingEvents(
            ActivityQuery query,
            ActivityCursor cursor,
            List<ChainTransactionDO> transactions,
            List<ActivityCandidate> matches,
            int fetchCount
    ) {
        // 事件先应用主体和类型条件，按签名分组后保留 Mapper 的事件序号倒序。
        // Apply subject and type filters, then preserve the mapper's descending event order within each signature.
        String network = query.network().wireValue();
        List<String> signatures = transactions.stream().map(ChainTransactionDO::signature).toList();
        Map<String, List<ChainEventDO>> eventsBySignature = getBaseMapper()
                .selectActivityCandidates(network, signatures, query.subjectAddress(), query.types())
                .stream()
                .collect(Collectors.groupingBy(ChainEventDO::signature));
        if (eventsBySignature.isEmpty()) {
            return;
        }

        // 筛选钱包只生成事件键集合。同一钱包有多个角色时，事件仍只匹配一次。
        // Use a set of event keys for wallet matching so multiple roles never duplicate the same event.
        boolean filterWallet = query.wallet() != null;
        Set<ChainEventKey> walletEventKeys = filterWallet
                ? participantMapper.selectForWallet(network, eventsBySignature.keySet(), query.wallet())
                        .stream()
                        .map(row -> new ChainEventKey(row.signature(), row.eventIndex()))
                        .collect(Collectors.toSet())
                : Set.of();

        // 依交易定位候选事件，再在该交易内区分多个事件。先匹配筛选条件，再消耗分页名额。
        // Walk parents and their events in order, spending a page slot only after the filters match.
        for (ChainTransactionDO transaction : transactions) {
            for (ChainEventDO event : eventsBySignature.getOrDefault(transaction.signature(), List.of())) {
                if (!isAfterCursor(event, cursor)
                        || (filterWallet && !walletEventKeys.contains(new ChainEventKey(event.signature(), event.eventIndex())))) {
                    continue;
                }
                matches.add(new ActivityCandidate(transaction, event));
                if (matches.size() == fetchCount) {
                    return;
                }
            }
        }
    }

    /**
     * 判断事件是否在续页边界之后。父交易顺序由 Mapper 保证。
     * Checks whether an event belongs after the continuation boundary in mapper-ordered transactions.
     *
     * @param event 当前交易中的候选事件。 Candidate event in the current transaction.
     * @param cursor 排他事件边界，首屏为空。 Exclusive event boundary, or null for the first page.
     * @return 首屏、较早交易或边界交易中较早的事件返回 true。 True on the first page, for an older transaction, or for an older event in the boundary transaction.
     */
    private static boolean isAfterCursor(ChainEventDO event, ActivityCursor cursor) {
        return cursor == null || !event.signature().equals(cursor.signature()) || event.eventIndex() < cursor.eventIndex();
    }

    /**
     * 读取选定事件的完整参与方和资产变动，并按传入顺序组装活动列表或单条回执。
     * Loads full participants and asset movements for the selected events and preserves their order for lists or receipts.
     *
     * @param network 所有选定事件所在的网络。 Network of all selected events.
     * @param candidates 顺序已确定的列表事件或单条回执事件。 Ordered list events or the single receipt event.
     * @return 已补齐参与方和资产变动的数据项。 Response items hydrated with participants and asset movements.
     */
    private List<ActivityResponse> loadActivityRows(String network, List<ActivityCandidate> candidates) {
        // 用事件复合键区分同一笔签名下的多个事件，保留钱包筛选之外的参与方。
        // Distinguish events sharing a signature by composite key, retaining participants beyond the wallet filter.
        List<ChainEventKey> eventKeys = candidates.stream().map(ActivityCandidate::eventKey).toList();
        Map<ChainEventKey, List<ActivityResponse.Participant>> participantsByKey = participantMapper
                .selectByEventKeys(network, eventKeys)
                .stream()
                .collect(Collectors.groupingBy(
                        row -> new ChainEventKey(row.signature(), row.eventIndex()),
                        Collectors.mapping(
                                row -> new ActivityResponse.Participant(row.walletAddress(), row.role()), Collectors.toList())));
        Map<ChainEventKey, List<ActivityResponse.Asset>> assetsByKey = assetMapper
                .selectByEventKeys(network, eventKeys)
                .stream()
                .collect(Collectors.groupingBy(
                        row -> new ChainEventKey(row.signature(), row.eventIndex()),
                        Collectors.mapping(ChainEventServiceImpl::toActivityAsset, Collectors.toList())));

        // 按查询顺序构建 DTO，缺少明细时返回可直接迭代的空列表。
        // Build DTOs in query order and use empty lists for absent details.
        return candidates.stream()
                .map(candidate -> candidate.toResponse(
                        participantsByKey.getOrDefault(candidate.eventKey(), List.of()),
                        assetsByKey.getOrDefault(candidate.eventKey(), List.of())))
                .toList();
    }

    /**
     * 保留交易时记录的 Mint、原始最小单位金额和小数位。
     * Preserves the mint, base-unit amount and decimals recorded with the event.
     *
     * @param row 事件的一条资产变动记录。 One asset movement recorded for an event.
     * @return 携带完整十进制金额的资产变动。 Asset movement with its full-precision decimal amount.
     */
    private static ActivityResponse.Asset toActivityAsset(ChainEventAssetDO row) {
        return new ActivityResponse.Asset(
                row.legIndex(), row.mintAddress(), row.decimals(), row.amountRaw().toString(), row.legType());
    }

    /**
     * 待组装为活动列表项或回执的业务事件及其父交易。
     * A business event and its parent transaction selected for a list item or receipt.
     *
     * @param transaction 提供 slot 和区块时间的父交易。 Parent transaction carrying slot and block time.
     * @param event 携带事件序号与业务信息的事件。 Event carrying its index and business fields.
     */
    private record ActivityCandidate(ChainTransactionDO transaction, ChainEventDO event) {

        /**
         * 生成本网络内稳定的事件复合键。
         * Builds the stable event key within this network.
         *
         * @return 交易签名及该交易内的事件序号。 Transaction signature and event index within the transaction.
         */
        ChainEventKey eventKey() {
            return new ChainEventKey(event.signature(), event.eventIndex());
        }

        /**
         * 使用当前事件的位置生成下一页边界。
         * Creates the continuation boundary from this event's ordering position.
         *
         * @return 原样保留精确 slot、交易签名和事件序号的游标。 Cursor with exact slot, signature, and event index.
         */
        ActivityCursor toCursor() {
            return new ActivityCursor(transaction.slot(), event.signature(), event.eventIndex());
        }

        /**
         * 输出一条完整活动，保留未知区块时间并统一使用 UTC。
         * Creates one complete activity, preserving unknown block time and using UTC when present.
         *
         * @param participants 该事件的完整参与方列表。 Full participant list for the event.
         * @param assets 该事件的完整资产变动列表。 Full asset movements for the event.
         * @return 供活动列表和回执页面展示的完整事件。 Complete event displayed by activity lists and receipt pages.
         */
        ActivityResponse toResponse(List<ActivityResponse.Participant> participants, List<ActivityResponse.Asset> assets) {
            // 仅转换已知的区块时间，RPC 未返回时继续保留 null。
            // Convert known block time only. Preserve null when the RPC supplies no time.
            String blockTime = transaction.blockTime() == null ? null : transaction.blockTime().toInstant().toString();
            return new ActivityResponse(
                    event.network(),
                    event.signature(),
                    event.eventIndex(),
                    transaction.slot().toString(),
                    blockTime,
                    event.programId(),
                    event.module(),
                    event.eventType(),
                    event.subjectAddress(),
                    participants,
                    assets);
        }
    }
}

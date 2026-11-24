package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.ChainTransactionDO;
import io.ggboy.backend.entity.IndexerCheckpointDO;
import io.ggboy.backend.indexer.VaultActivityData.Signature;
import io.ggboy.backend.mapper.ChainTransactionMapper;
import io.ggboy.backend.mapper.IndexerCheckpointMapper;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.Optional;

/**
 * 为链上活动索引读写连续检查点并建立交易父记录。
 * Reads and writes contiguous activity checkpoints and creates parent transaction rows.
 */
@Component
class ActivityIndexStore {

    /** Solana Devnet 活动和检查点的网络标识。 Network identifier for Devnet activities and checkpoints. */
    static final String NETWORK = "devnet";

    /** 按网络与程序读取并推进已处理签名。 Reads and advances processed signatures by network and program. */
    private final IndexerCheckpointMapper checkpoints;
    /** 写入具有可展示事件的父交易。 Writes parent transactions that contain displayable events. */
    private final ChainTransactionMapper transactions;

    /**
     * 注入共用的检查点与父交易写入 Mapper。
     * Injects shared mappers for checkpoints and parent transactions.
     *
     * @param checkpoints 持久化的程序续扫边界。 Persisted program scanning frontiers.
     * @param transactions 已索引事件的父交易。 Parent transactions for indexed events.
     */
    ActivityIndexStore(IndexerCheckpointMapper checkpoints, ChainTransactionMapper transactions) {
        this.checkpoints = checkpoints;
        this.transactions = transactions;
    }

    /**
     * 查询最近成功提交的连续边界。
     * Finds the most recent successfully committed contiguous frontier.
     *
     * @param programId 当前索引的链上程序公钥。 Public key of the program being indexed.
     * @return 最近处理的交易签名和 slot，尚未同步时为空。 Most recently processed signature and slot, or empty before indexing.
     */
    Optional<Signature> checkpoint(String programId) {
        return Optional.ofNullable(checkpoints.selectByKey(NETWORK, programId))
                .filter(row -> row.lastSignature() != null)
                .map(row -> new Signature(row.lastSignature(), row.lastSlot(), false));
    }

    /**
     * 在外层活动事务中比较旧边界并推进，防止并发索引重复处理。
     * Compares and advances the frontier inside the caller's activity transaction to prevent duplicate processing.
     *
     * @param programId 当前索引的链上程序公钥。 Public key of the indexed program.
     * @param expected 本轮起点，首次同步为空。 Frontier observed this pass, or null on the initial pass.
     * @param current 本次处理的已最终确认交易。 Finalized transaction being processed.
     * @param indexedAt 索引时的 UTC 时间。 UTC indexing timestamp.
     * @return 本事务取得边界写入资格时为真。 True when this transaction wins the right to write at the frontier.
     */
    boolean advanceCheckpoint(String programId, Signature expected, Signature current, OffsetDateTime indexedAt) {
        /** 新边界和用于并发比较的预期签名与 slot。 New frontier with the expected signature and slot for compare-and-set. */
        var next = new IndexerCheckpointDO(NETWORK, programId, current.value(), current.slot(), indexedAt);
        var expectedSignature = expected == null ? null : expected.value();
        var expectedSlot = expected == null ? null : expected.slot();
        if (checkpoints.advance(next, expectedSignature, expectedSlot) == 1) {
            return true;
        }
        if (expected != null || checkpoints.selectByKey(NETWORK, programId) != null) {
            return false;
        }

        // 并发首次插入由复合主键防重，失败写入随活动事务回滚。
        // The composite key rejects competing initial inserts and the losing activity transaction rolls back.
        checkpoints.insert(next);
        return true;
    }

    /**
     * 写入父交易，或核对其他事件已经写入的同签名交易。
     * Writes the parent transaction, or verifies one for the same signature inserted by another event.
     *
     * @param signature 已最终确认交易的主签名和 slot。 Finalized transaction's primary signature and slot.
     * @param blockTime 链上区块时间，RPC 未提供时为空。 On-chain block time, null if unavailable from RPC.
     * @param indexedAt 索引时的 UTC 时间。 UTC indexing timestamp.
     */
    void ensureParent(Signature signature, OffsetDateTime blockTime, OffsetDateTime indexedAt) {
        /** 可能由该交易中的其他业务模块建立的父记录。 Parent row possibly established by another module in this transaction. */
        ChainTransactionDO existing = transactions.selectByNetworkAndSignature(NETWORK, signature.value());
        if (existing == null) {
            transactions.insert(new ChainTransactionDO(NETWORK, signature.value(), signature.slot(), blockTime, indexedAt));
        } else if (!existing.slot().equals(signature.slot())) {
            throw new IllegalStateException("Indexed Devnet transaction has a different slot: " + signature.value());
        }
    }
}

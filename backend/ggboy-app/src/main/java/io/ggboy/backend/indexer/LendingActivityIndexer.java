package io.ggboy.backend.indexer;

import io.ggboy.backend.indexer.LendingActivityDecoder.Event;
import io.ggboy.backend.indexer.VaultActivityData.Signature;
import io.ggboy.backend.indexer.VaultActivityRpc.LendingTransaction;
import io.ggboy.common.utils.SolanaAddressUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 从已登记 Devnet 借贷程序的最终确认交易历史补扫借款、出借存取和清算活动。
 * Backfills borrowing, supply, withdrawal and liquidation activities from finalized transaction history of the registered Devnet lending program.
 */
@Component
@ConditionalOnProperty(prefix = "ggboy.devnet-lending-indexer", name = "enabled", matchIfMissing = true)
class LendingActivityIndexer {

    /** 记录同步结果和下轮可重试的问题。 Records completed progress and problems retried next pass. */
    private static final Logger LOG = LoggerFactory.getLogger(LendingActivityIndexer.class);
    /** 公共 Devnet RPC 每轮仅拉取少量交易回执，避免批量回执触发限流。 Limit detailed reads per pass to avoid throttling public Devnet RPC. */
    private static final int MAX_TRANSACTIONS_PER_PASS = 8;

    /** 与金库索引共用最终确认、只读 Devnet 客户端。 Finalized read-only Devnet client shared with vault indexing. */
    private final VaultActivityRpc rpc;
    /** 管理已登记市场、活动写入和连续检查点。 Manages registered markets, activity writes and contiguous checkpoints. */
    private final LendingActivityStore store;
    /** 用于签名发现及日志来源校验的 Devnet 程序公钥。 Devnet program public key for signature discovery and log provenance. */
    private final String programId;

    /**
     * 装配 Devnet 借贷活动补扫任务。
     * Wires the Devnet lending activity backfill task.
     *
     * @param rpc 只读取最终确认数据的 Devnet RPC。 Finalized read-only Devnet RPC client.
     * @param store 借贷活动与检查点的事务存储。 Transactional persistence for lending activities and checkpoints.
     * @param programId 配置的 Devnet 借贷程序公开地址。 Configured public key of the Devnet lending program.
     */
    LendingActivityIndexer(VaultActivityRpc rpc, LendingActivityStore store,
                           @Value("${ggboy.devnet-lending-indexer.program-id}") String programId) {
        SolanaAddressUtil.requirePublicKey(programId, "Devnet lending program id");
        this.rpc = rpc;
        this.store = store;
        this.programId = programId;
    }

    /**
     * 本轮索引最终确认事件，遇到不连续历史、RPC 限流或事务失败时保留最近已提交的检查点。
     * Indexes finalized lending events, keeping the last committed frontier after an RPC gap, throttling or failed transaction.
     */
    @Scheduled(fixedDelayString = "${ggboy.devnet-lending-indexer.poll-interval:20s}")
    void sync() {
        try {
            // 数据库没有登记当前程序的市场时，无需请求 RPC。
            // Avoid RPC traffic if the database has no market registered for this program.
            if (!store.hasRegisteredMarket(programId)) {
                return;
            }

            /** 从已提交的边界开始定位待处理历史，首次补扫没有边界。 Find history after the committed frontier, or the beginning on first backfill. */
            Signature checkpoint = store.checkpoint(programId).orElse(null);
            /** 按从旧到新获取一段连续的最终确认签名。 Next contiguous finalized signatures in oldest-first order. */
            List<Signature> pending = FinalizedSignatureScan.collectPending(
                    checkpoint, before -> rpc.listSignatures(programId, before), MAX_TRANSACTIONS_PER_PASS);
            /** 本轮成功提交的交易数量，包括不产生业务事件的交易。 Transactions committed this pass, including those producing no business events. */
            int processed = 0;
            for (Signature signature : pending) {
                /** 失败交易不含有效事件，直接走检查点推进。 Skip detail reads for failed on-chain transactions, which cannot emit valid events. */
                LendingTransaction detail = signature.failed() ? null : rpc.getLendingTransaction(signature);
                /** 区块时间保持 UTC 表示，缺失时保留为空。 UTC block timestamp, or null if unavailable. */
                OffsetDateTime blockTime = detail == null ? null : detail.transaction().blockTime();
                /** 用签名人集合与程序调用日志核对支持的业务事件。 Verify supported lending events against message signers and program invocation logs. */
                List<Event> events = detail == null ? List.of()
                        : LendingActivityDecoder.decode(programId, detail.transaction().logs(), detail.signers());
                // 每笔签名依次原子提交。遇到其他索引实例推进边界时，在下一轮重新发现待扫描签名。
                // Commit signatures atomically in order. Rediscover them next pass if another indexer moved the frontier.
                if (!store.commit(programId, checkpoint, signature, blockTime, events)) {
                    break;
                }
                checkpoint = signature;
                processed++;
            }
            if (processed > 0) {
                LOG.info("Devnet lending activity checkpoint advanced by {} transaction(s) to slot {}", processed, checkpoint.slot());
            }
        } catch (RuntimeException failure) {
            LOG.warn("Devnet lending activity sync paused; the next pass will retry: {}", failure.getMessage());
        }
    }
}

package io.ggboy.backend.indexer;

import io.ggboy.backend.indexer.VaultActivityData.Event;
import io.ggboy.backend.indexer.VaultActivityData.Signature;
import io.ggboy.backend.indexer.VaultActivityData.Transaction;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 定期补扫已最终确认的 Devnet 金库存赎，从持久化的连续检查点恢复。
 * Periodically backfills finalized Devnet vault activity and resumes from the persisted contiguous checkpoint.
 */
@Component
@ConditionalOnProperty(prefix = "ggboy.devnet-vault-indexer", name = "enabled", matchIfMissing = true)
class VaultActivityIndexer {

    /** 记录每轮同步结果和可重试故障。 Records completed passes and retryable failures. */
    private static final Logger LOG = LoggerFactory.getLogger(VaultActivityIndexer.class);
    /** 每轮最多处理的交易数，限制公共 RPC 请求峰值。 Maximum transactions processed per pass to limit bursts to public RPC. */
    private static final int MAX_TRANSACTIONS_PER_PASS = 20;

    /** 读取最终确认签名和交易日志。 Fetches finalized signatures and transaction logs. */
    private final VaultActivityRpc rpc;
    /** 管理登记校验、活动写入和检查点事务。 Handles registration checks, activity writes and checkpoint transactions. */
    private final VaultActivityStore store;
    /** 当前 Devnet 部署的公开程序 ID。 Public program ID of the configured Devnet deployment. */
    private final String programId;

    /**
     * 装配 Devnet 补扫任务。
     * Wires the Devnet indexer.
     *
     * @param rpc 只读 RPC 客户端。 Read-only RPC client.
     * @param store PostgreSQL 持久化服务。 PostgreSQL persistence service.
     * @param programId 已部署的 Devnet 金库程序公钥。 Public key of the deployed Devnet vault program.
     */
    VaultActivityIndexer(VaultActivityRpc rpc, VaultActivityStore store,
                         @Value("${ggboy.devnet-vault-indexer.program-id}") String programId) {
        this.rpc = rpc;
        this.store = store;
        this.programId = programId;
    }

    /**
     * 在前一轮结束后，按配置的延迟再次补扫。读取或写入失败时，下轮从最近一次成功提交处重试。
     * Schedules the next pass after the configured delay. Retries failures from the last committed checkpoint.
     */
    @Scheduled(fixedDelayString = "${ggboy.devnet-vault-indexer.poll-interval:20s}")
    void sync() {
        try {
            // 尚未登记该部署的数据库不会发出 RPC 请求。
            // A database without a registration for this deployment does not make RPC requests.
            if (!store.hasRegisteredVault(programId)) {
                return;
            }

            /** 本轮的预期检查点，首次启动为空。 Expected checkpoint for this pass, null on the first run. */
            Signature checkpoint = store.checkpoint(programId).orElse(null);
            /** 已验证与检查点连续的待处理签名，按旧到新排列。 Verified contiguous pending signatures in oldest-first order. */
            List<Signature> pending = FinalizedSignatureScan.collectPending(
                    checkpoint, before -> rpc.listSignatures(programId, before), MAX_TRANSACTIONS_PER_PASS);
            /** 本轮已完成的交易签名数，含被跳过的失败交易。 Signatures processed on this pass, including skipped failures. */
            int processed = 0;
            for (Signature signature : pending) {
                /** 已知失败交易只推进检查点，无法生成活动。 A known failed transaction advances the checkpoint without emitting activity. */
                Transaction transaction = signature.failed() ? null : rpc.getTransaction(signature);
                /** 链上 UTC 区块时间，未知时为空。 On-chain UTC block time, null if unknown. */
                OffsetDateTime blockTime = transaction == null ? null : transaction.blockTime();
                /** 从真正执行成功的金库调用解析的事件。 Events decoded from successful vault invocations. */
                List<Event> events = transaction == null ? List.of() : VaultActivityDecoder.decode(programId, transaction.logs());

                // 一次原子提交一个签名。竞争实例已推进检查点时，下轮重新查找待处理签名。
                // Commit one signature atomically. Rediscover pending signatures next pass if another instance advanced first.
                if (!store.commit(programId, checkpoint, signature, blockTime, events)) {
                    break;
                }
                checkpoint = signature;
                processed++;
            }
            if (processed > 0) {
                LOG.info("Devnet vault activity checkpoint advanced by {} transaction(s) to slot {}", processed, checkpoint.slot());
            }
        } catch (RuntimeException failure) {
            LOG.warn("Devnet vault activity sync paused; the next pass will retry: {}", failure.getMessage());
        }
    }
}

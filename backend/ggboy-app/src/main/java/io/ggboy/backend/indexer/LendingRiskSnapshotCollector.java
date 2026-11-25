package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import io.ggboy.backend.mapper.LendingMarketMapper;
import io.ggboy.backend.mapper.LendingMarketSnapshotMapper;
import io.ggboy.common.api.SolanaNetwork;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 定期采集已登记 Devnet 借贷市场的风险状态和仓位。
 * Periodically captures risk and positions for the registered Devnet lending market.
 */
@Component
@ConditionalOnProperty(prefix = "ggboy.devnet-lending-snapshot", name = "enabled", matchIfMissing = true)
class LendingRiskSnapshotCollector {

    /** 节点或观测失败时记录重试，下一轮继续。 Logs capture failures for the next pass to retry. */
    private static final Logger LOG = LoggerFactory.getLogger(LendingRiskSnapshotCollector.class);
    /** 首版只同步 Devnet，不改动 Localnet 实验数据。 Initial collector network, leaving Localnet experiments independent. */
    private static final String NETWORK = SolanaNetwork.DEVNET.wireValue();

    /** 已登记的市场及已发布的最新观测。 Registered markets and latest committed observations. */
    private final LendingMarketMapper markets;
    private final LendingMarketSnapshotMapper snapshots;
    /** 分开只读观察和写入事务，RPC 等待不占数据库连接。 Separate read-only observation from publication so RPC does not hold a database connection. */
    private final LendingRiskSnapshotRpc reader;
    private final LendingRiskSnapshotStore publisher;
    /** 当前 Devnet 演示部署的借贷程序。 Configured Devnet lending program for the current demo deployment. */
    private final String programId;

    /**
     * 装配市场目录、只读 RPC 和快照持久化。
     * Wires market registrations, read-only RPC and snapshot persistence.
     *
     * @param markets 借贷市场及 Mint 绑定。 Lending market and mint bindings.
     * @param snapshots 市场历史和最新 slot。 Market history and its latest slot.
     * @param reader 账户观测读取器。 Account observation reader.
     * @param publisher 原子批次写入器。 Atomic batch publisher.
     * @param programId 已部署 Devnet 借贷程序公钥。 Deployed Devnet lending program public key.
     */
    LendingRiskSnapshotCollector(LendingMarketMapper markets, LendingMarketSnapshotMapper snapshots,
                                 LendingRiskSnapshotRpc reader, LendingRiskSnapshotStore publisher,
                                 @Value("${ggboy.devnet-lending-indexer.program-id}") String programId) {
        this.markets = markets;
        this.snapshots = snapshots;
        this.reader = reader;
        this.publisher = publisher;
        this.programId = programId;
    }

    /**
     * 定时读取同一 slot 的市场批次，失败保留最近一次已提交数据。
     * Captures same-slot market batches on a schedule, retaining the last committed data on failure.
     */
    @Scheduled(fixedDelayString = "${ggboy.devnet-lending-snapshot.poll-interval:20s}")
    void collect() {
        for (LendingMarketDO market : markets.selectByNetwork(NETWORK)) {
            if (!programId.equals(market.programId())) {
                continue;
            }
            try {
                /** 上一已发布 slot 为本次读链下限。 The preceding published slot is the minimum context for this capture. */
                LendingMarketSnapshotDO latest = snapshots.selectLatestByNetworkAndAddress(NETWORK, market.marketAddress());
                LendingRiskBatch batch = reader.observe(market, latest == null ? null : latest.slot());
                publisher.publish(market, batch);
            } catch (RuntimeException failure) {
                // 异常日志不打印底层响应、URL 或数据库配置。
                // Do not log raw RPC responses, endpoint URLs or database configuration in the scheduler.
                LOG.warn("Devnet lending risk observation for {} will retry ({})",
                        market.marketAddress(), failure.getClass().getSimpleName());
            }
        }
    }
}

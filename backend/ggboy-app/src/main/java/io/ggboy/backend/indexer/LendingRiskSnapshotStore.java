package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;
import io.ggboy.backend.mapper.LendingMarketMapper;
import io.ggboy.backend.mapper.LendingMarketSnapshotMapper;
import io.ggboy.backend.mapper.LendingPositionSnapshotMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 在同一数据库事务发布借贷市场及完整钱包快照。
 * Publishes the lending market and all wallet snapshots in one database transaction.
 */
@Service
public class LendingRiskSnapshotStore {

    /** 读取市场登记并初始化规范的预言机配置。 Reads the market registry and installs its canonical oracle configuration. */
    private final LendingMarketMapper markets;
    /** 读写市场快照和本次风险版本。 Reads and writes market observations and the evaluated risk version. */
    private final LendingMarketSnapshotMapper snapshots;
    /** 写入完整的同槽钱包快照。 Persists the complete same-slot wallet sample. */
    private final LendingPositionSnapshotMapper positions;

    /**
     * 注入复用既有风险查询表的 Mapper。
     * Injects the mappers for the existing risk query tables.
     *
     * @param markets 市场和预言机登记。 Market and oracle registrations.
     * @param snapshots 市场快照。 Market snapshots.
     * @param positions 钱包仓位快照。 Wallet position snapshots.
     */
    LendingRiskSnapshotStore(LendingMarketMapper markets, LendingMarketSnapshotMapper snapshots,
                             LendingPositionSnapshotMapper positions) {
        this.markets = markets;
        this.snapshots = snapshots;
        this.positions = positions;
    }

    /**
     * 检查市场未更改及 slot 单调递增后发布完整批次。任一行插入失败则回滚。
     * Publishes a complete batch after confirming the registration is unchanged and the slot advanced. Rolls back if any insert fails.
     *
     * @param observedRegistration RPC 读取期间使用的市场登记。 Registry version used while reading RPC data.
     * @param batch 已核对同槽账户及价格证明的快照。 Verified same-slot account and price evidence.
     */
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void publish(LendingMarketDO observedRegistration, LendingRiskBatch batch) {
        /** 可串行化事务将登记、最新槽判断和新批次写入置于同一数据库视图。 A serializable transaction covers registration, the latest slot predicate and batch inserts. */
        String network = observedRegistration.network();
        String address = observedRegistration.marketAddress();
        LendingMarketDO current = markets.selectByNetworkAndAddress(network, address);
        if (!observedRegistration.equals(current)) {
            // 配置在 RPC 与发布之间变化时，下轮使用新的配置重做观测。
            // Re-observe on the next pass if the configuration changed between RPC and publication.
            return;
        }
        // 并发发布冲突时 PostgreSQL 中止一个事务，下轮重新读取最新快照再判断。
        // PostgreSQL aborts one conflicting publication. The next pass rechecks the newest snapshot.
        LendingMarketSnapshotDO latest = snapshots.selectLatestByNetworkAndAddress(network, address);
        if (latest != null && batch.market().slot().compareTo(latest.slot()) <= 0) {
            return;
        }

        if (current.oracleAddress() == null && current.oracleMaxAgeSeconds() == null) {
            // 早期部署登记没有预言机字段。验证后的链上布局固定使用规范 PDA，仅填两项缺失配置。
            // Early registrations have no oracle fields. The verified chain layout uses the canonical PDA. Fill only the missing pair.
            if (markets.configureOracle(network, address, batch.canonicalOracle(), LendingRiskBatch.ORACLE_MAX_AGE_SECONDS) != 1) {
                throw new IllegalStateException("Could not bind the canonical lending price feed");
            }
        }

        if (snapshots.insert(batch.market()) != 1) {
            throw new IllegalStateException("Could not insert the lending market observation");
        }
        // 市场完整标记、同版本报价和全部钱包记录只在事务提交后同时可见。
        // The completion flag, matching quote version and all wallets become visible only together at commit.
        for (LendingPositionSnapshotDO position : batch.positions()) {
            if (positions.insert(position) != 1) {
                throw new IllegalStateException("Could not insert a lending position observation");
            }
        }
    }
}

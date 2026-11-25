package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.backend.entity.VaultSnapshotDO;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.mapper.VaultMapper;
import io.ggboy.backend.mapper.VaultSnapshotMapper;
import io.ggboy.common.api.SolanaNetwork;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;

/**
 * 从 Devnet 定期观测已登记金库，供每份净值历史使用。
 * Samples registered Devnet vaults periodically for per-share NAV history.
 */
@Component
@ConditionalOnProperty(prefix = "ggboy.devnet-vault-snapshot", name = "enabled", matchIfMissing = true)
class VaultSnapshotCollector {

    /** 记录查询或采集失败，等待下一轮重试。 Reports lookup or capture failures for the next pass to retry. */
    private static final Logger LOG = LoggerFactory.getLogger(VaultSnapshotCollector.class);
    /** 首版采集范围为 Devnet。 Devnet is the first sampling network. */
    private static final String NETWORK = SolanaNetwork.DEVNET.wireValue();

    /** 定位已登记的金库和链上程序。 Locates registered vaults and their on-chain programs. */
    private final VaultMapper vaults;
    /** 核对图表所用的 Mint 精度与链上精度一致。 Checks that the chart's registry precision matches the chain. */
    private final AssetMintMapper mints;
    /** 读取最近采集的 slot 并追加历史。 Looks up the latest sampled slot and appends history. */
    private final VaultSnapshotMapper snapshots;
    /** 读取经过核验的同一 slot 的金库与 Mint 账户。 Reads validated vault and mint accounts from one slot. */
    private final VaultSnapshotRpc rpc;
    /** 与活动索引共用的金库程序公钥。 Vault program public key shared with the activity indexer. */
    private final String programId;

    /**
     * 装配已登记的 Devnet 金库采集任务。
     * Wires the collector for registered Devnet vaults.
     *
     * @param vaults 金库登记表。 Vault registry.
     * @param mints 计价资产和份额 Mint 登记表。 Quote and share mint registry.
     * @param snapshots 金库观测记录。 Vault observation records.
     * @param rpc 只读的账户观测客户端。 Read-only account observation client.
     * @param programId 已部署 Devnet 金库程序的公钥。 Public key of the deployed Devnet vault program.
     */
    VaultSnapshotCollector(VaultMapper vaults, AssetMintMapper mints, VaultSnapshotMapper snapshots, VaultSnapshotRpc rpc,
                           @Value("${ggboy.devnet-vault-indexer.program-id}") String programId) {
        this.vaults = vaults;
        this.mints = mints;
        this.snapshots = snapshots;
        this.rpc = rpc;
        this.programId = programId;
    }

    /**
     * 按轮次采集已登记金库。一座金库读写失败后仍可采集其他已配置金库。
     * Collects registered vaults on each pass, isolating lookup and write failures by vault.
     */
    @Scheduled(fixedDelayString = "${ggboy.devnet-vault-snapshot.poll-interval:30s}")
    void collect() {
        /** Devnet 中已登记的金库，尚未登记时列表可为空。 Registered Devnet vaults, possibly empty. */
        List<VaultDO> registeredVaults = vaults.selectByNetwork(NETWORK);

        for (VaultDO vault : registeredVaults) {
            // 同一个金库程序支持现金和启用策略的部署。
            // The same vault program supports cash-only and strategy-enabled vaults.
            if (!programId.equals(vault.programId())) {
                continue;
            }
            try {
                validateMintRegistry(vault);
                capture(vault);
            } catch (RuntimeException failure) {
                LOG.warn("Devnet vault snapshot for {} will retry on the next pass: {}", vault.vaultAddress(), failure.getMessage());
            }
        }
    }

    /**
     * 核对计算横跨代币金额和份额的换算精度，查询接口和走势图都从登记表取值。
     * Validates the decimals used to scale token and share quantities, which the read API and chart obtain from the registry.
     *
     * @param vault 当前金库登记。 Current vault registration.
     * @throws IllegalStateException 任一登记缺失、Mint 精度或代币程序不匹配。 A registration is missing or its mint precision or token program differs.
     */
    private void validateMintRegistry(VaultDO vault) {
        /** 计价资产和份额沿用六位精度。已登记的策略代币使用九位精度。 Quote and shares retain six decimals. A registered strategy asset uses nine decimals. */
        List<String> addresses = vault.strategyMint() == null ? List.of(vault.quoteMint(), vault.shareMint())
                : List.of(vault.quoteMint(), vault.shareMint(), vault.strategyMint());
        List<AssetMintDO> registeredMints = mints.selectByNetworkAndMintAddresses(NETWORK, addresses);
        if (registeredMints.size() != addresses.size() || registeredMints.stream().anyMatch(mint ->
                mint.decimals() != (mint.mintAddress().equals(vault.strategyMint())
                                ? VaultStrategySnapshot.SPOT_DECIMALS : VaultSnapshotRpc.TOKEN_DECIMALS)
                        || !VaultSnapshotRpc.TOKEN_PROGRAM_ID.equals(mint.programId()))) {
            throw new IllegalStateException("The vault mint registry does not match its classic SPL token configuration");
        }
    }

    /**
     * 使用一次已最终确认的观测构建一条历史记录。
     * Builds one history row from a finalized observation.
     *
     * @param vault 已配置的目标金库。 Registered vault to sample.
     */
    private void capture(VaultDO vault) {
        /** 同一已最终确认 slot 上的估值输入。 Valuation inputs from the same finalized slot. */
        VaultSnapshotRpc.Observation observation = rpc.observe(vault);
        /** 采集实际发生的 UTC 时间。 Actual capture timestamp in UTC. */
        OffsetDateTime observedAt = OffsetDateTime.now(ZoneOffset.UTC);
        /** 最近入库的观测用于过滤重复或 RPC 返回的较旧 slot。 Latest stored observation used to discard repeated or stale RPC slots. */
        List<VaultSnapshotDO> latest = snapshots.selectHistoryByNetworkAndAddress(NETWORK, vault.vaultAddress(), null, 1);
        if (!latest.isEmpty() && observation.slot().compareTo(latest.getFirst().slot()) <= 0) {
            return;
        }

        // 测试预言机账户记录时间但没有发布 slot。可用时间在估值时与同槽 Clock 核对。
        // The test oracle records time without a publish slot. Valuation checks its time against the same-slot Clock.
        VaultSnapshotDO sample = new VaultSnapshotDO(NETWORK, vault.vaultAddress(), observation.slot(), observedAt, null,
                observation.cashRaw(), observation.strategyAmountRaw(), observation.strategyValueRaw(),
                observation.lendValueRaw(), observation.recallableRaw(), observation.navRaw(), observation.totalSharesRaw(),
                observation.autoRecallEnabled(), observation.lendingPositionOpen());

        try {
            snapshots.insert(sample);
        } catch (DuplicateKeyException concurrentInsert) {
            // 复合主键只允许每座金库每个 slot 取一条。同一 slot 并发采集时保留先入库的观测。
            // The composite key allows one row per vault and slot. Keep the first observation when collectors race.
            LOG.debug("Devnet vault snapshot already exists for {} at slot {}", vault.vaultAddress(), observation.slot());
        }
    }
}

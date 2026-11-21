package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import io.ggboy.backend.entity.VaultSnapshotDO;
import org.apache.ibatis.annotations.Mapper;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * 通过 MyBatis-Plus 访问{@code vault_snapshot} 表中的金库的净值与流动性快照。
 * MyBatis-Plus mapper for vault NAV and liquidity snapshots in {@code vault_snapshot}.
 */
@Mapper
public interface VaultSnapshotMapper extends BaseMapper<VaultSnapshotDO> {

    /**
     * 查询指定网络各金库的最新快照，每个已采集的金库最多返回一条。
     * Load at most one latest snapshot for each requested vault on the specified network.
     *
     * <p>按网络和金库地址分别查询，按数值 slot 降序在数据库取一条。
     * Query each vault by network and address, fetching one row in descending numeric slot order.
     *
     * @param network 已校验的网络协议值，支持 {@code localnet} 和 {@code devnet}。
     *                Validated network wire value, either {@code localnet} or {@code devnet}.
     * @param vaultAddresses 待查询的金库地址集合。为空时直接返回空列表。
     *                       Vault addresses to query. An empty collection returns an empty list.
     * @return 查询所得最新快照。没有采集记录的金库无对应元素，均未采集时返回空列表。
     *         Latest snapshots. Vaults without observations are omitted, and the list is empty if none were observed.
     */
    default List<VaultSnapshotDO> selectLatestByNetworkAndVaultAddresses(
            String network, Collection<String> vaultAddresses
    ) {
        if (vaultAddresses.isEmpty()) {
            return List.of();
        }

        // 列表查询在同一事务中读取快照。去重避免重复查询同一金库。
        // The list service reads snapshots in one transaction. Deduplicate addresses to avoid repeated lookups.
        List<VaultSnapshotDO> snapshots = new ArrayList<>();
        for (String vaultAddress : new LinkedHashSet<>(vaultAddresses)) {
            // 沿用历史查询的网络范围和 slot 排序，每个金库只读取一条。
            // Reuse the history query's network scope and slot ordering to read one row per vault.
            snapshots.addAll(selectHistoryByNetworkAndAddress(network, vaultAddress, null, 1));
        }
        return snapshots;
    }

    /**
     * 读取指定网络和金库的一批历史快照，按数值 slot 从大到小排列。
     * Reads a batch of historical snapshots for one network and vault in descending numeric slot order.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param vaultAddress 金库状态账户的公钥。 Public key of the vault state account.
     * @param beforeSlot 上页末条的非负观测 slot，作为排除自身的上界。首屏传空引用。
     *                   Nonnegative observation slot of the last returned row, used as an exclusive upper bound.
     *                   Null when requesting the first page.
     * @param fetchSize 正整数，数据库最多返回的记录数。历史接口多取一条判断是否可继续翻页。
     *                  Positive database row limit. The history endpoint requests one extra row to detect another page.
     * @return 本次读取的快照列表，未采集或到达末页时可为空。
     *         Fetched snapshots, which may be empty when unobserved or past the end.
     */
    default List<VaultSnapshotDO> selectHistoryByNetworkAndAddress(
            String network, String vaultAddress, BigInteger beforeSlot, int fetchSize
    ) {
        // 用严格小于游标的条件继续查询，避免重复返回上一页末条。分页只限制数据库返回行数。
        // Resume strictly below the cursor to avoid repeating the last row. Pagination only caps rows at the database.
        return selectList(Page.of(1, fetchSize, false), Wrappers.lambdaQuery(VaultSnapshotDO.class)
                .eq(VaultSnapshotDO::getNetwork, network)
                .eq(VaultSnapshotDO::getVaultAddress, vaultAddress)
                .lt(beforeSlot != null, VaultSnapshotDO::getSlot, beforeSlot)
                .orderByDesc(VaultSnapshotDO::getSlot));
    }

    /**
     * 按网络、金库和观测 slot 精确读取金库快照，用于与钱包持仓对齐。
     * Reads the exact vault snapshot by network, vault, and observed slot to align it with a wallet's position.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param vaultAddress 金库状态账户的公钥。 Public key of the vault state account.
     * @param slot 钱包持仓快照的观测 slot，使用非负整数。 Nonnegative observation slot of the wallet snapshot.
     * @return 同一 slot 的快照。未采集该 slot 时返回空引用。
     *         The snapshot at the same slot, or null when no observation exists at that slot.
     */
    default VaultSnapshotDO selectByNetworkAndAddressAndSlot(
            String network, String vaultAddress, BigInteger slot
    ) {
        return selectOne(Wrappers.lambdaQuery(VaultSnapshotDO.class)
                .eq(VaultSnapshotDO::getNetwork, network)
                .eq(VaultSnapshotDO::getVaultAddress, vaultAddress)
                .eq(VaultSnapshotDO::getSlot, slot));
    }
}

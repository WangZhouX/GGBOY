package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;
import org.apache.ibatis.annotations.Mapper;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Collection;
import java.util.List;

/**
 * 通过 MyBatis-Plus 访问{@code lending_position_snapshot} 表中的市场参与方的供给、抵押和债务快照。
 * MyBatis-Plus mapper for snapshots of a market participant's supply, collateral and debt in {@code lending_position_snapshot}.
 */
@Mapper
public interface LendingPositionSnapshotMapper extends BaseMapper<LendingPositionSnapshotDO> {

    /**
     * 读取指定网络、市场及钱包的最新仓位快照。
     * Reads the latest position snapshot for the requested network, market and wallet.
     *
     * @param network 已校验的目标网络协议值。 Validated wire value of the target network.
     * @param marketAddress 市场状态账户地址。 Address of the market state account.
     * @param walletAddress 仓位持有人的钱包地址。 Address of the wallet that owns the position.
     * @return 数值 slot 最大的仓位快照，尚未采集时返回空值。
     *         Position snapshot with the highest numeric slot, or null if unobserved.
     */
    default LendingPositionSnapshotDO selectLatestByNetworkAndMarketAndWallet(
            String network, String marketAddress, String walletAddress
    ) {
        // 只需要当前钱包的最新观测，由数据库按数值 slot 取一条并跳过总数查询。
        // Retrieve one row by numeric slot in the database and skip counting because only the latest observation is needed.
        List<LendingPositionSnapshotDO> snapshots = selectList(
                Page.of(1, 1, false), Wrappers.lambdaQuery(LendingPositionSnapshotDO.class)
                        .eq(LendingPositionSnapshotDO::getNetwork, network)
                        .eq(LendingPositionSnapshotDO::getMarketAddress, marketAddress)
                        .eq(LendingPositionSnapshotDO::getWalletAddress, walletAddress)
                        .orderByDesc(LendingPositionSnapshotDO::getSlot)
        );
        return snapshots.isEmpty() ? null : snapshots.getFirst();
    }

    /**
     * 为「清算市场」列表首次加载或续页分批读取同一个市场快照 slot 的可排序仓位。
     * Reads batches of sortable positions at the market snapshot slot on initial load or pagination in the Liquidation Market.
     *
     * @param network 已校验的目标网络协议值。 Validated wire value of the target network.
     * @param marketAddress 市场状态账户地址。 Address of the market state account.
     * @param marketSlot 本次清算市场查询使用的市场快照 slot。 Market snapshot slot used by this liquidation query.
     * @param afterHealthFactor 上一批最后一条仓位的健康度，首批为空。
     *                          Health factor of the last position in the preceding batch, or null for the first batch.
     * @param afterWallet 与健康度一起使用的上一批最后一个钱包地址，首批为空。
     *                    Wallet address paired with the last health factor, or null for the first batch.
     * @param fetchSize 本批最多读取的行数。 Maximum number of rows to read in this batch.
     * @return 按健康度和钱包地址升序排列的仓位，由服务层确认最新性和清算资格。
     *         Positions ordered by health factor and wallet address ascending for the service to verify recency and eligibility.
     */
    default List<LendingPositionSnapshotDO> selectLiquidationScanBatch(
            String network, String marketAddress, BigInteger marketSlot,
            BigDecimal afterHealthFactor, String afterWallet, int fetchSize
    ) {
        // 使用健康度和钱包地址作为复合边界，健康度相同时仍可逐条续扫。空健康度不能参与该排序和游标。
        // Use health factor and wallet address as a compound boundary to resume within ties. Null health factors cannot form this cursor.
        return selectList(Page.of(1, fetchSize, false), Wrappers.lambdaQuery(LendingPositionSnapshotDO.class)
                .eq(LendingPositionSnapshotDO::getNetwork, network)
                .eq(LendingPositionSnapshotDO::getMarketAddress, marketAddress)
                .eq(LendingPositionSnapshotDO::getSlot, marketSlot)
                .isNotNull(LendingPositionSnapshotDO::getHealthFactor)
                .and(afterHealthFactor != null, boundary -> boundary
                        .gt(LendingPositionSnapshotDO::getHealthFactor, afterHealthFactor)
                        .or(sameHealth -> sameHealth
                                .eq(LendingPositionSnapshotDO::getHealthFactor, afterHealthFactor)
                                .gt(LendingPositionSnapshotDO::getWalletAddress, afterWallet)))
                .orderByAsc(LendingPositionSnapshotDO::getHealthFactor, LendingPositionSnapshotDO::getWalletAddress));
    }

    /**
     * 为「清算市场」查询找出已被更高 slot 仓位覆盖的候选钱包。
     * Finds candidate wallets whose positions have been superseded at a higher slot for the Liquidation Market.
     *
     * @param network 已校验的目标网络协议值。 Validated wire value of the target network.
     * @param marketAddress 市场状态账户地址。 Address of the market state account.
     * @param marketSlot 本次扫描的市场快照 slot。 Market snapshot slot for this scan.
     * @param walletAddresses 本批候选仓位的钱包地址，允许为空集合。 Candidate wallets in this batch, possibly empty.
     * @return 存在更高 slot 仓位的钱包地址，每个地址最多返回一次。
     *         Wallet addresses with a position at a higher slot, with one result per address.
     */
    default List<String> selectWalletsWithNewerPosition(
            String network, String marketAddress, BigInteger marketSlot, Collection<String> walletAddresses
    ) {
        // 候选为空时直接返回，避免构造没有钱包地址的 IN 条件。
        // Return immediately for an empty batch to avoid constructing an IN predicate with no wallets.
        if (walletAddresses.isEmpty()) {
            return List.of();
        }

        // 任意更高 slot 的仓位都覆盖旧仓位，包括已还清债务或缺少健康度的记录。
        // Any higher-slot position supersedes the old one, including repaid positions and rows without a health factor.
        return selectObjs(Wrappers.lambdaQuery(LendingPositionSnapshotDO.class)
                .select(LendingPositionSnapshotDO::getWalletAddress)
                .eq(LendingPositionSnapshotDO::getNetwork, network)
                .eq(LendingPositionSnapshotDO::getMarketAddress, marketAddress)
                .gt(LendingPositionSnapshotDO::getSlot, marketSlot)
                .in(LendingPositionSnapshotDO::getWalletAddress, walletAddresses)
                .groupBy(LendingPositionSnapshotDO::getWalletAddress));
    }
}

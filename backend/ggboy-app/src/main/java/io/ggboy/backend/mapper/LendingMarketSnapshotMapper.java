package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import org.apache.ibatis.annotations.Mapper;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * 通过 MyBatis-Plus 访问{@code lending_market_snapshot} 表中的借贷市场的资金与风险参数快照。
 * MyBatis-Plus mapper for market liquidity and risk parameter snapshots in {@code lending_market_snapshot}.
 */
@Mapper
public interface LendingMarketSnapshotMapper extends BaseMapper<LendingMarketSnapshotDO> {

    /**
     * 读取指定网络下各借贷市场的最新资金池快照，每个市场最多返回一条。
     * Loads at most one latest pool snapshot for each requested lending market on one network.
     *
     * @param network 已校验的网络协议值，支持 localnet 和 devnet。
     *                Validated network wire value, either localnet or devnet.
     * @param marketAddresses 待查询的市场状态账户公钥集合，允许为空集合。
     *                        Market state account public keys to query, possibly empty.
     * @return 已有快照的市场各返回一条，均未采集到快照时返回空列表。
     *         One snapshot for each observed market, or an empty list when no snapshots exist.
     */
    default List<LendingMarketSnapshotDO> selectLatestByNetworkAndMarketAddresses(
            String network, Collection<String> marketAddresses
    ) {
        if (marketAddresses.isEmpty()) {
            return List.of();
        }

        // 以原始地址顺序汇总已采集的市场快照，同一地址只查询一次。
        // Collect snapshots in the original address order and query each address only once.
        List<LendingMarketSnapshotDO> snapshots = new ArrayList<>();
        for (String marketAddress : new LinkedHashSet<>(marketAddresses)) {
            // 只汇总已采集到快照的市场。
            // Include markets that have an observed snapshot.
            LendingMarketSnapshotDO snapshot = selectLatestByNetworkAndAddress(network, marketAddress);
            if (snapshot != null) {
                snapshots.add(snapshot);
            }
        }
        return snapshots;
    }

    /**
     * 读取指定市场的最新快照，供「资金池现况」和「清算市场」查询使用。
     * Reads the latest market snapshot for the Pool Overview and Liquidation Market queries.
     *
     * @param network 已校验的目标网络协议值。 Validated wire value of the target network.
     * @param marketAddress 市场状态账户地址。 Address of the market state account.
     * @return 数值 slot 最大的市场快照，尚未采集时返回空值。
     *         Market snapshot with the highest numeric slot, or null if unobserved.
     */
    default LendingMarketSnapshotDO selectLatestByNetworkAndAddress(String network, String marketAddress) {
        // 由数据库按数值 slot 倒序取一条。服务层校验这一条快照的预言机和时效，查询不统计历史总数。
        // Read one row in descending numeric slot order without counting history. The service validates its oracle and freshness.
        List<LendingMarketSnapshotDO> snapshots = selectList(
                Page.of(1, 1, false), Wrappers.lambdaQuery(LendingMarketSnapshotDO.class)
                        .eq(LendingMarketSnapshotDO::getNetwork, network)
                        .eq(LendingMarketSnapshotDO::getMarketAddress, marketAddress)
                        .orderByDesc(LendingMarketSnapshotDO::getSlot)
        );
        return snapshots.isEmpty() ? null : snapshots.getFirst();
    }

    /**
     * 按完整复合主键查找与钱包仓位快照对应的市场观测。
     * Finds the market observation matching a wallet snapshot by its complete composite primary key.
     *
     * @param network 已校验的目标网络协议值。 Validated wire value of the target network.
     * @param marketAddress 市场状态账户地址。 Address of the market state account.
     * @param slot 钱包仓位快照的数值 slot。 Numeric slot of the wallet snapshot.
     * @return 同一个 slot 的市场快照，缺少观测时返回空值。 Market snapshot at the same slot, or null if unobserved.
     */
    default LendingMarketSnapshotDO selectByNetworkAndAddressAndSlot(
            String network, String marketAddress, BigInteger slot
    ) {
        // 额度估算只使用与钱包同一个 slot 的市场输入，避免混用不相容的流动性与规则。
        // Use market inputs from the wallet slot to avoid mixing liquidity and rules from incompatible observations.
        return selectOne(Wrappers.lambdaQuery(LendingMarketSnapshotDO.class)
                .eq(LendingMarketSnapshotDO::getNetwork, network)
                .eq(LendingMarketSnapshotDO::getMarketAddress, marketAddress)
                .eq(LendingMarketSnapshotDO::getSlot, slot));
    }
}

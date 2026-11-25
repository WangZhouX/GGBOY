package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import io.ggboy.backend.entity.LendingMarketDO;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

/**
 * 通过 MyBatis-Plus 访问{@code lending_market} 表中的借贷市场登记。
 * MyBatis-Plus mapper for registered lending markets in {@code lending_market}.
 */
@Mapper
public interface LendingMarketMapper extends BaseMapper<LendingMarketDO> {

    /**
     * 查询指定网络的市场登记，按市场地址升序返回。
     * Lists registered markets on one network in ascending market-address order.
     *
     * @param network 已校验的网络协议值，支持 localnet 和 devnet。
     *                Validated network wire value, either localnet or devnet.
     * @return 该网络的市场登记，没有登记时返回空列表。
     *         Registrations on the requested network, or an empty list if none are registered.
     */
    default List<LendingMarketDO> selectByNetwork(String network) {
        // 按网络隔离市场地址，按地址稳定排序以便前端展示列表。
        // Scope market addresses to one network and sort by address for stable list presentation.
        return selectList(Wrappers.lambdaQuery(LendingMarketDO.class)
                .eq(LendingMarketDO::getNetwork, network)
                .orderByAsc(LendingMarketDO::getMarketAddress));
    }


    /**
     * 按完整复合主键读取借贷市场登记。
     * Reads the registered lending market by its complete composite primary key.
     *
     * @param network 已校验的目标网络协议值。 Validated wire value of the target network.
     * @param marketAddress 市场状态账户地址。 Address of the market state account.
     * @return 找到的市场登记，未登记时返回空值。 Market registration, or null if unregistered.
     */
    default LendingMarketDO selectByNetworkAndAddress(String network, String marketAddress) {
        // 同一个状态地址可出现在不同网络，查询必须同时限定网络。
        // The same state address can occur on different networks, so always constrain the network.
        return selectOne(Wrappers.lambdaQuery(LendingMarketDO.class)
                .eq(LendingMarketDO::getNetwork, network)
                .eq(LendingMarketDO::getMarketAddress, marketAddress));
    }

    /**
     * 为此前未配置的市场绑定经账户验证的预言机。
     * Binds the verified canonical oracle for a previously unconfigured market.
     *
     * @param network 目标网络。 Target network.
     * @param marketAddress 规范市场公钥。 Canonical market public key.
     * @param oracle 规范预言机 PDA。 Canonical oracle PDA.
     * @param maxAgeSeconds 链上报价最大年龄，单位为秒。 Maximum on-chain quote age in seconds.
     * @return 更新行数。 Number of rows updated.
     */
    default int configureOracle(String network, String marketAddress, String oracle, int maxAgeSeconds) {
        return update(null, Wrappers.lambdaUpdate(LendingMarketDO.class)
                .eq(LendingMarketDO::getNetwork, network)
                .eq(LendingMarketDO::getMarketAddress, marketAddress)
                .isNull(LendingMarketDO::getOracleAddress)
                .isNull(LendingMarketDO::getOracleMaxAgeSeconds)
                .set(LendingMarketDO::getOracleAddress, oracle)
                .set(LendingMarketDO::getOracleMaxAgeSeconds, maxAgeSeconds));
    }
}

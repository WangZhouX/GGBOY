package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import io.ggboy.backend.entity.AssetMintDO;
import org.apache.ibatis.annotations.Mapper;

import java.util.Collection;
import java.util.List;

/**
 * 通过 MyBatis-Plus 访问{@code asset_mint} 表中的资产 Mint 登记。
 * MyBatis-Plus mapper for registered asset mints in {@code asset_mint}.
 */
@Mapper
public interface AssetMintMapper extends BaseMapper<AssetMintDO> {

    /**
     * 批量查询指定网络的资产 Mint 登记，供金库及借贷市场列表补齐符号和小数位。
     * Load mint registrations to supply symbols and decimals for vault and lending market lists.
     *
     * <p>通过网络和 Mint 地址筛选，确保不会混用不同网络的资产。空地址集合直接返回空列表。
     * Filter by network and mint address to keep assets from different networks separate. An empty collection yields an empty list.
     *
     * @param network 已校验的网络协议值，支持 {@code localnet} 和 {@code devnet}。
     *                Validated network wire value, either {@code localnet} or {@code devnet}.
     * @param mintAddresses 待查询的 Mint 地址集合。
     *                      Collection of mint addresses to query.
     * @return 已匹配的 Mint 登记，没有匹配项时返回空列表。
     *         Matching mint registrations, or an empty list if no mint matches.
     */
    default List<AssetMintDO> selectByNetworkAndMintAddresses(String network, Collection<String> mintAddresses) {
        // 空地址集合无匹配项，直接返回以避免空 IN 条件。
        // An empty address collection has no matches, so return early to avoid an empty IN clause.
        if (mintAddresses.isEmpty()) {
            return List.of();
        }

        return selectList(Wrappers.lambdaQuery(AssetMintDO.class)
                .eq(AssetMintDO::getNetwork, network)
                .in(AssetMintDO::getMintAddress, mintAddresses));
    }
}

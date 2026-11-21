package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.AssetMintDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code asset_mint} 表中的资产 Mint 登记。
 * MyBatis-Plus mapper for registered asset mints in {@code asset_mint}.
 */
@Mapper
public interface AssetMintMapper extends BaseMapper<AssetMintDO> {
}

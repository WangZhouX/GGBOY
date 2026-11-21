package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.ChainEventAssetDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code chain_event_asset} 表中的事件中的代币变动。
 * MyBatis-Plus mapper for token movements in a business event in {@code chain_event_asset}.
 */
@Mapper
public interface ChainEventAssetMapper extends BaseMapper<ChainEventAssetDO> {
}

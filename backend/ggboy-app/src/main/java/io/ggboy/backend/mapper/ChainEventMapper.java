package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.ChainEventDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code chain_event} 表中的交易内的业务事件。
 * MyBatis-Plus mapper for business events within a transaction in {@code chain_event}.
 */
@Mapper
public interface ChainEventMapper extends BaseMapper<ChainEventDO> {
}

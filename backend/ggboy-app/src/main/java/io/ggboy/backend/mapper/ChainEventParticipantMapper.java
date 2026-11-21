package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code chain_event_participant} 表中的事件参与方及其角色。
 * MyBatis-Plus mapper for event participants and their roles in {@code chain_event_participant}.
 */
@Mapper
public interface ChainEventParticipantMapper extends BaseMapper<ChainEventParticipantDO> {
}

package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import io.ggboy.backend.mapper.ChainEventParticipantMapper;
import io.ggboy.backend.service.ChainEventParticipantService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link ChainEventParticipantMapper} 访问事件参与方和角色。
 * Uses {@link ChainEventParticipantMapper} to persist and retrieve event participants and their roles.
 */
@Service
public class ChainEventParticipantServiceImpl extends ServiceImpl<ChainEventParticipantMapper, ChainEventParticipantDO>
        implements ChainEventParticipantService {
}

package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.mapper.ChainEventMapper;
import io.ggboy.backend.service.ChainEventService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link ChainEventMapper} 访问交易中已识别的业务事件。
 * Uses {@link ChainEventMapper} to persist and retrieve recognized business events within transactions.
 */
@Service
public class ChainEventServiceImpl extends ServiceImpl<ChainEventMapper, ChainEventDO>
        implements ChainEventService {
}

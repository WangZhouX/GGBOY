package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.mapper.ChainEventAssetMapper;
import io.ggboy.backend.service.ChainEventAssetService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link ChainEventAssetMapper} 访问业务事件的代币变动。
 * Uses {@link ChainEventAssetMapper} to persist and retrieve token movements in a business event.
 */
@Service
public class ChainEventAssetServiceImpl extends ServiceImpl<ChainEventAssetMapper, ChainEventAssetDO>
        implements ChainEventAssetService {
}

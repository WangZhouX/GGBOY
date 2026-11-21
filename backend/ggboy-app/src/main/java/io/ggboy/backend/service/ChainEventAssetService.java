package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.entity.ChainEventAssetDO;

/**
 * 提供业务事件的代币变动的基础持久化操作。
 * Provides basic persistence operations for token movements in a business event.
 */
public interface ChainEventAssetService extends IService<ChainEventAssetDO> {
}

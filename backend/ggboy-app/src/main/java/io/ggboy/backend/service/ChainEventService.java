package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.entity.ChainEventDO;

/**
 * 提供交易中已识别的业务事件的基础持久化操作。
 * Provides basic persistence operations for recognized business events within transactions.
 */
public interface ChainEventService extends IService<ChainEventDO> {
}

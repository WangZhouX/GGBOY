package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.entity.ChainTransactionDO;

/**
 * 提供已最终确认且含业务事件的链上交易的基础持久化操作。
 * Provides basic persistence operations for finalized on-chain transactions containing business events.
 */
public interface ChainTransactionService extends IService<ChainTransactionDO> {
}

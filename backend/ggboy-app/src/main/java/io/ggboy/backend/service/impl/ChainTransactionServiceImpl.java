package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.ChainTransactionDO;
import io.ggboy.backend.mapper.ChainTransactionMapper;
import io.ggboy.backend.service.ChainTransactionService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link ChainTransactionMapper} 访问已最终确认且含业务事件的链上交易。
 * Uses {@link ChainTransactionMapper} to persist and retrieve finalized on-chain transactions containing business events.
 */
@Service
public class ChainTransactionServiceImpl extends ServiceImpl<ChainTransactionMapper, ChainTransactionDO>
        implements ChainTransactionService {
}

package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.mapper.LendingMarketMapper;
import io.ggboy.backend.service.LendingMarketService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link LendingMarketMapper} 访问借贷市场的登记信息。
 * Uses {@link LendingMarketMapper} to persist and retrieve registered lending markets.
 */
@Service
public class LendingMarketServiceImpl extends ServiceImpl<LendingMarketMapper, LendingMarketDO>
        implements LendingMarketService {
}

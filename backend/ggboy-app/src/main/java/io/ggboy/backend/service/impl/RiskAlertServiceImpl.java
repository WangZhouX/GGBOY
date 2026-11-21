package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.RiskAlertDO;
import io.ggboy.backend.mapper.RiskAlertMapper;
import io.ggboy.backend.service.RiskAlertService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link RiskAlertMapper} 访问借贷仓位触发的风险提醒。
 * Uses {@link RiskAlertMapper} to persist and retrieve risk alerts triggered by lending positions.
 */
@Service
public class RiskAlertServiceImpl extends ServiceImpl<RiskAlertMapper, RiskAlertDO>
        implements RiskAlertService {
}

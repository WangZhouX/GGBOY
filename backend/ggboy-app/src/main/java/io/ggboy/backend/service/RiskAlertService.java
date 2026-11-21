package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.entity.RiskAlertDO;

/**
 * 提供借贷仓位触发的风险提醒的基础持久化操作。
 * Provides basic persistence operations for risk alerts triggered by lending positions.
 */
public interface RiskAlertService extends IService<RiskAlertDO> {
}

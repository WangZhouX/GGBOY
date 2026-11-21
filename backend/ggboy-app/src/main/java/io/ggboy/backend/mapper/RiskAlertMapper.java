package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.RiskAlertDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code risk_alert} 表中的借贷仓位触发的风险提醒。
 * MyBatis-Plus mapper for risk alerts triggered by lending positions in {@code risk_alert}.
 */
@Mapper
public interface RiskAlertMapper extends BaseMapper<RiskAlertDO> {
}

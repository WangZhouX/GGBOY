package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code lending_market_snapshot} 表中的借贷市场的资金与风险参数快照。
 * MyBatis-Plus mapper for market liquidity and risk parameter snapshots in {@code lending_market_snapshot}.
 */
@Mapper
public interface LendingMarketSnapshotMapper extends BaseMapper<LendingMarketSnapshotDO> {
}

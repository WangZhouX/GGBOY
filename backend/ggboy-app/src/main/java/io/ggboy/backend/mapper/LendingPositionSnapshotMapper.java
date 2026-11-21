package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code lending_position_snapshot} 表中的市场参与方的供给、抵押和债务快照。
 * MyBatis-Plus mapper for snapshots of a market participant's supply, collateral and debt in {@code lending_position_snapshot}.
 */
@Mapper
public interface LendingPositionSnapshotMapper extends BaseMapper<LendingPositionSnapshotDO> {
}

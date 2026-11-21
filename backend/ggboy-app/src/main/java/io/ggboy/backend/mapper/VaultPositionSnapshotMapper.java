package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.VaultPositionSnapshotDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code vault_position_snapshot} 表中的金库持有人的份额与可赎回金额快照。
 * MyBatis-Plus mapper for snapshots of vault holders' shares and redeemable amounts in {@code vault_position_snapshot}.
 */
@Mapper
public interface VaultPositionSnapshotMapper extends BaseMapper<VaultPositionSnapshotDO> {
}

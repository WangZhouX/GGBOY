package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.VaultSnapshotDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code vault_snapshot} 表中的金库的净值与流动性快照。
 * MyBatis-Plus mapper for vault NAV and liquidity snapshots in {@code vault_snapshot}.
 */
@Mapper
public interface VaultSnapshotMapper extends BaseMapper<VaultSnapshotDO> {
}

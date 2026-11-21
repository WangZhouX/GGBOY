package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.entity.VaultSnapshotDO;

/**
 * 提供金库净值与流动性快照的基础持久化操作。
 * Provides basic persistence operations for vault NAV and liquidity snapshots.
 */
public interface VaultSnapshotService extends IService<VaultSnapshotDO> {
}

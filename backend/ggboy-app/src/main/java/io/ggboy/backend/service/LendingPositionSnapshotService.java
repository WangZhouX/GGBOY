package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;

/**
 * 提供钱包在市场中的供给、抵押与债务快照的基础持久化操作。
 * Provides basic persistence operations for per-wallet market supply, collateral and debt snapshots.
 */
public interface LendingPositionSnapshotService extends IService<LendingPositionSnapshotDO> {
}

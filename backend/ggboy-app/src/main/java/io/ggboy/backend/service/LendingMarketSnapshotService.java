package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;

/**
 * 提供借贷市场的流动性与风险参数快照的基础持久化操作。
 * Provides basic persistence operations for market liquidity and risk parameter snapshots.
 */
public interface LendingMarketSnapshotService extends IService<LendingMarketSnapshotDO> {
}

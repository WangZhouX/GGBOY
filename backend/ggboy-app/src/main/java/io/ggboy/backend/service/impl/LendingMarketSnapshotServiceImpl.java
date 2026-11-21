package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import io.ggboy.backend.mapper.LendingMarketSnapshotMapper;
import io.ggboy.backend.service.LendingMarketSnapshotService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link LendingMarketSnapshotMapper} 访问借贷市场的流动性与风险参数快照。
 * Uses {@link LendingMarketSnapshotMapper} to persist and retrieve market liquidity and risk parameter snapshots.
 */
@Service
public class LendingMarketSnapshotServiceImpl extends ServiceImpl<LendingMarketSnapshotMapper, LendingMarketSnapshotDO>
        implements LendingMarketSnapshotService {
}

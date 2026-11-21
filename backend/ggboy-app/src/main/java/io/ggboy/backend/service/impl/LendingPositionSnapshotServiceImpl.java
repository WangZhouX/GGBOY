package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;
import io.ggboy.backend.mapper.LendingPositionSnapshotMapper;
import io.ggboy.backend.service.LendingPositionSnapshotService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link LendingPositionSnapshotMapper} 访问钱包在市场中的供给、抵押与债务快照。
 * Uses {@link LendingPositionSnapshotMapper} to persist and retrieve per-wallet market supply, collateral and debt snapshots.
 */
@Service
public class LendingPositionSnapshotServiceImpl extends ServiceImpl<LendingPositionSnapshotMapper, LendingPositionSnapshotDO>
        implements LendingPositionSnapshotService {
}

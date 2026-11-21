package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.VaultSnapshotDO;
import io.ggboy.backend.mapper.VaultSnapshotMapper;
import io.ggboy.backend.service.VaultSnapshotService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link VaultSnapshotMapper} 访问金库净值与流动性快照。
 * Uses {@link VaultSnapshotMapper} to persist and retrieve vault NAV and liquidity snapshots.
 */
@Service
public class VaultSnapshotServiceImpl extends ServiceImpl<VaultSnapshotMapper, VaultSnapshotDO>
        implements VaultSnapshotService {
}

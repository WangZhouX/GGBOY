package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.VaultPositionSnapshotDO;
import io.ggboy.backend.mapper.VaultPositionSnapshotMapper;
import io.ggboy.backend.service.VaultPositionSnapshotService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link VaultPositionSnapshotMapper} 访问金库份额持有人的仓位快照。
 * Uses {@link VaultPositionSnapshotMapper} to persist and retrieve vault share holders' position snapshots.
 */
@Service
public class VaultPositionSnapshotServiceImpl extends ServiceImpl<VaultPositionSnapshotMapper, VaultPositionSnapshotDO>
        implements VaultPositionSnapshotService {
}

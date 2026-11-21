package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.backend.mapper.VaultMapper;
import io.ggboy.backend.service.VaultService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link VaultMapper} 访问策略金库的登记信息。
 * Uses {@link VaultMapper} to persist and retrieve registered strategy vaults.
 */
@Service
public class VaultServiceImpl extends ServiceImpl<VaultMapper, VaultDO>
        implements VaultService {
}

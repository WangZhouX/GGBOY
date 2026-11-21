package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.service.AssetMintService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link AssetMintMapper} 访问资产 Mint 登记记录。
 * Uses {@link AssetMintMapper} to persist and retrieve registered asset mints.
 */
@Service
public class AssetMintServiceImpl extends ServiceImpl<AssetMintMapper, AssetMintDO>
        implements AssetMintService {
}

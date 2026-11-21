package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.VaultDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code vault} 表中的策略金库登记。
 * MyBatis-Plus mapper for registered strategy vaults in {@code vault}.
 */
@Mapper
public interface VaultMapper extends BaseMapper<VaultDO> {
}

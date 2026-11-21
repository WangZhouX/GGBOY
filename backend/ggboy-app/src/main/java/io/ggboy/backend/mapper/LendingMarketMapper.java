package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.LendingMarketDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code lending_market} 表中的借贷市场登记。
 * MyBatis-Plus mapper for registered lending markets in {@code lending_market}.
 */
@Mapper
public interface LendingMarketMapper extends BaseMapper<LendingMarketDO> {
}

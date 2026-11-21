package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.ChainTransactionDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code chain_transaction} 表中的包含业务事件的已确认交易。
 * MyBatis-Plus mapper for finalized transactions containing business events in {@code chain_transaction}.
 */
@Mapper
public interface ChainTransactionMapper extends BaseMapper<ChainTransactionDO> {
}

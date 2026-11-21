package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import io.ggboy.backend.entity.IndexerCheckpointDO;
import org.apache.ibatis.annotations.Mapper;

/**
 * 通过 MyBatis-Plus 访问{@code indexer_checkpoint} 表中的按网络和程序记录的同步检查点。
 * MyBatis-Plus mapper for indexing checkpoints per network and program in {@code indexer_checkpoint}.
 */
@Mapper
public interface IndexerCheckpointMapper extends BaseMapper<IndexerCheckpointDO> {
}

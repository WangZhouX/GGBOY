package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.entity.IndexerCheckpointDO;

/**
 * 提供按网络和程序记录的索引进度的基础持久化操作。
 * Provides basic persistence operations for indexing progress per network and program.
 */
public interface IndexerCheckpointService extends IService<IndexerCheckpointDO> {
}

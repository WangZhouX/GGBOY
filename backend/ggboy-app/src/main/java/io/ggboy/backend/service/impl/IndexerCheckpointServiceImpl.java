package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.entity.IndexerCheckpointDO;
import io.ggboy.backend.mapper.IndexerCheckpointMapper;
import io.ggboy.backend.service.IndexerCheckpointService;
import org.springframework.stereotype.Service;

/**
 * 通过 {@link IndexerCheckpointMapper} 访问按网络和程序记录的索引进度。
 * Uses {@link IndexerCheckpointMapper} to persist and retrieve indexing progress per network and program.
 */
@Service
public class IndexerCheckpointServiceImpl extends ServiceImpl<IndexerCheckpointMapper, IndexerCheckpointDO>
        implements IndexerCheckpointService {
}

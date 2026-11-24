package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import io.ggboy.backend.entity.IndexerCheckpointDO;
import org.apache.ibatis.annotations.Mapper;

import java.math.BigInteger;

/**
 * 通过 MyBatis-Plus 访问{@code indexer_checkpoint} 表中的按网络和程序记录的同步检查点。
 * MyBatis-Plus mapper for indexing checkpoints per network and program in {@code indexer_checkpoint}.
 */
@Mapper
public interface IndexerCheckpointMapper extends BaseMapper<IndexerCheckpointDO> {

    /**
     * 读取一个网络和程序的同步检查点，使用完整的复合主键。
     * Reads a checkpoint by its complete composite key of network and program.
     *
     * @param network 已校验的 Solana 网络代码。 Validated Solana network code.
     * @param programId 被跟踪程序的公开地址。 Public address of the tracked program.
     * @return 检查点，尚未建立时为空。 Checkpoint, or null before one exists.
     */
    default IndexerCheckpointDO selectByKey(String network, String programId) {
        return selectOne(Wrappers.lambdaQuery(IndexerCheckpointDO.class)
                .eq(IndexerCheckpointDO::getNetwork, network)
                .eq(IndexerCheckpointDO::getProgramId, programId));
    }

    /**
     * 仅在数据库的边界仍与本次扫描起点一致时推进检查点。
     * Advances the checkpoint only while the stored frontier still matches this scan's starting point.
     *
     * @param next 本笔成功处理的交易对应的新边界。 New frontier for the processed transaction.
     * @param expectedSignature 上一次扫描的边界交易签名，空表示未处理任何交易。 Previous frontier signature, or null when no transaction was processed.
     * @param expectedSlot 上一个边界的 slot，与签名同时为空或非空。 Previous frontier slot, paired with the signature.
     * @return 更新的行数，零表示没有检查点或边界已经改变。 Updated row count, zero when the row is absent or its frontier changed.
     */
    default int advance(IndexerCheckpointDO next, String expectedSignature, BigInteger expectedSlot) {
        // 只锁定与本次读取完全匹配的边界；其他索引实例推进后当前扫描须重新读取。
        // Lock only the frontier that this scan observed; another indexer advancing it forces a refresh.
        LambdaUpdateWrapper<IndexerCheckpointDO> update = Wrappers.lambdaUpdate(IndexerCheckpointDO.class)
                .eq(IndexerCheckpointDO::getNetwork, next.network())
                .eq(IndexerCheckpointDO::getProgramId, next.programId())
                .set(IndexerCheckpointDO::getLastSignature, next.lastSignature())
                .set(IndexerCheckpointDO::getLastSlot, next.lastSlot())
                .set(IndexerCheckpointDO::getUpdatedAt, next.updatedAt());
        if (expectedSignature == null) {
            update.isNull(IndexerCheckpointDO::getLastSignature).isNull(IndexerCheckpointDO::getLastSlot);
        } else {
            update.eq(IndexerCheckpointDO::getLastSignature, expectedSignature)
                    .eq(IndexerCheckpointDO::getLastSlot, expectedSlot);
        }
        return update(update);
    }
}

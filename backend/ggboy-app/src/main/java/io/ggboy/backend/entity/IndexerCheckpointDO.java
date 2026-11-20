package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigInteger;
import java.time.OffsetDateTime;

/**
 * 按网络和程序保存已连续处理的最终确认交易边界，用于重启和补扫。
 * Contiguous finalized indexing frontier per network and program, used to restart and backfill.
 *
 * <p>复合主键 / Composite primary key: {@code (network, program_id)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param programId 该检查点跟踪的链上程序 ID。
 *        ID of the on-chain program tracked by this checkpoint.
 * @param lastSignature 已处理边界的交易主签名，首次推进前为空。
 *        Primary signature at the processed frontier. Null before the first advance.
 * @param lastSlot 已处理边界所在的 slot，首次推进前为空。
 *        Slot of the processed frontier. Null before the first advance.
 * @param updatedAt 检查点的最后推进时间，初始化时为创建时间。
 *        Time the checkpoint last advanced, initially set to creation time.
 */
@TableName("indexer_checkpoint")
public record IndexerCheckpointDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "program_id", updateStrategy = FieldStrategy.NEVER) String programId,
        @TableField("last_signature") String lastSignature,
        @TableField("last_slot") BigInteger lastSlot,
        @TableField("updated_at") OffsetDateTime updatedAt
) {
}

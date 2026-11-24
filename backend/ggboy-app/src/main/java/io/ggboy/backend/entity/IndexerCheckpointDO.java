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

    /**
     * 提供复合主键中网络字段的 Lambda 访问器。
     * Exposes the network field of the composite key for Lambda predicates.
     *
     * @return 小写 Solana 网络代码。 Lowercase Solana network code.
     */
    public String getNetwork() {
        return network;
    }

    /**
     * 提供复合主键中程序字段的 Lambda 访问器。
     * Exposes the program field of the composite key for Lambda predicates.
     *
     * @return 被跟踪程序的公开地址。 Public address of the tracked program.
     */
    public String getProgramId() {
        return programId;
    }

    /**
     * 提供处理边界签名的 Lambda 访问器。
     * Exposes the processed boundary signature for Lambda comparisons and updates.
     *
     * @return 边界交易的主签名，初始为空。 Primary signature of the frontier transaction, initially null.
     */
    public String getLastSignature() {
        return lastSignature;
    }

    /**
     * 提供处理边界 slot 的 Lambda 访问器。
     * Exposes the processed boundary slot for Lambda comparisons and updates.
     *
     * @return 对应边界的已最终确认 slot，初始为空。 Finalized slot of the frontier transaction, initially null.
     */
    public BigInteger getLastSlot() {
        return lastSlot;
    }

    /**
     * 提供处理边界更新时间的 Lambda 访问器。
     * Exposes the frontier update timestamp for Lambda updates.
     *
     * @return 最近一次推进时间，含时区偏移。 Last advancement timestamp with a UTC offset.
     */
    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }
}

package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigInteger;
import java.time.OffsetDateTime;

/**
 * 已最终确认且成功、包含 GGBOY 业务事件的交易。首期模拟数据使用同样结构。
 * Finalized successful transactions with GGBOY business events. Phase one fixtures use the same structure.
 *
 * <p>复合主键 / Composite primary key: {@code (network, signature)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param signature Solana 交易主签名，Base58 编码。
 *        Primary Solana transaction signature in Base58.
 * @param slot 交易实际落入的链上 slot。
 *        On-chain slot in which the transaction landed.
 * @param blockTime 链上区块时间，RPC 未返回时为空。
 *        Block timestamp. Null when unavailable from RPC.
 * @param indexedAt 此交易首次写入索引库的时间。
 *        Time this transaction first entered the index.
 */
@TableName("chain_transaction")
public record ChainTransactionDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "signature", updateStrategy = FieldStrategy.NEVER) String signature,
        @TableField("slot") BigInteger slot,
        @TableField("block_time") OffsetDateTime blockTime,
        @TableField("indexed_at") OffsetDateTime indexedAt
) {

    /**
     * 提供 Lambda 查询使用的属性访问器，对应 {@code network}。
     * Exposes the property for Lambda queries against the {@code network} column.
     *
     * @return 网络的小写协议值。 Lowercase network wire identifier.
     */
    public String getNetwork() {
        return network;
    }

    /**
     * 提供 Lambda 查询使用的属性访问器，对应 {@code signature}。
     * Exposes the property for Lambda queries against the {@code signature} column.
     *
     * @return Base58 编码的交易主签名。 Primary transaction signature in Base58.
     */
    public String getSignature() {
        return signature;
    }

    /**
     * 提供 Lambda 查询使用的属性访问器，对应 {@code slot}。
     * Exposes the property for Lambda queries against the {@code slot} column.
     *
     * @return 交易实际落入的链上 slot。 On-chain slot in which the transaction landed.
     */
    public BigInteger getSlot() {
        return slot;
    }
}

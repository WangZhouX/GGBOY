package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import io.ggboy.backend.entity.ChainTransactionDO;
import org.apache.ibatis.annotations.Mapper;

import java.math.BigInteger;
import java.util.List;

/**
 * 通过 MyBatis-Plus 访问 {@code chain_transaction} 中包含业务事件的已确认交易。
 * MyBatis-Plus mapper for finalized transactions containing business events in {@code chain_transaction}.
 */
@Mapper
public interface ChainTransactionMapper extends BaseMapper<ChainTransactionDO> {

    /**
     * 读取「查看交易回执」使用的父交易，为事件提供链上 slot 和区块时间。
     * Loads the parent transaction that supplies the on-chain slot and block time for View Transaction Receipt.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param signature 已校验的 Base58 交易主签名。 Validated Base58 primary transaction signature.
     * @return 精确匹配的交易，未索引该交易时为空。 The exact matching transaction, or null if it is not indexed.
     */
    default ChainTransactionDO selectByNetworkAndSignature(String network, String signature) {
        // 父交易由网络和签名共同标识，即使签名相同也不能跨网络读取。
        // Identify the parent by both network and signature, so matching signatures cannot cross networks.
        return selectOne(Wrappers.lambdaQuery(ChainTransactionDO.class)
                .eq(ChainTransactionDO::getNetwork, network)
                .eq(ChainTransactionDO::getSignature, signature));
    }

    /**
     * 读取活动候选交易，按数值 slot 和签名降序在数据库限制批次大小。
     * Reads activity candidate transactions in descending numeric slot and signature order with a database row limit.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param signature 可选的 Base58 交易签名，用于检索指定交易。 Optional Base58 signature to find one transaction.
     * @param boundarySlot 游标交易的链上 slot。首批无游标时为空。 On-chain slot of the cursor transaction, or null for an unbounded first batch.
     * @param boundarySignature 与上界 slot 对应的 Base58 交易签名。 Base58 transaction signature paired with the boundary slot.
     * @param includeBoundary 是否保留游标交易，以继续读取这笔交易内尚未返回的事件。
     *                        Whether to retain the cursor transaction for remaining events in that transaction.
     * @param fetchSize 正整数，每批最多读取的交易数。 Positive maximum number of transactions in one batch.
     * @return 按顺序读取的交易列表。没有符合条件的交易时返回空列表。 Ordered transactions, or an empty list if none match.
     */
    default List<ChainTransactionDO> selectActivityBatch(
            String network, String signature, BigInteger boundarySlot, String boundarySignature,
            boolean includeBoundary, int fetchSize
    ) {
        // 延续查询保留更早的 slot，slot 相同时以数据库签名顺序定位游标。仅续页首批需要保留游标交易。
        // Continue at older slots, or use database signature order within the same slot. Keep the cursor transaction only for the first continuation batch.
        return selectList(Page.of(1, fetchSize, false), Wrappers.lambdaQuery(ChainTransactionDO.class)
                .eq(ChainTransactionDO::getNetwork, network)
                .eq(signature != null, ChainTransactionDO::getSignature, signature)
                .and(boundarySlot != null, previous -> previous.lt(ChainTransactionDO::getSlot, boundarySlot)
                        .or(sameSlot -> sameSlot.eq(ChainTransactionDO::getSlot, boundarySlot)
                                .le(includeBoundary, ChainTransactionDO::getSignature, boundarySignature)
                                .lt(!includeBoundary, ChainTransactionDO::getSignature, boundarySignature)))
                .orderByDesc(ChainTransactionDO::getSlot)
                .orderByDesc(ChainTransactionDO::getSignature));
    }
}

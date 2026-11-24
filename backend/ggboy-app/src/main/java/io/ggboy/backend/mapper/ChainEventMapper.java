package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import io.ggboy.backend.api.ActivityQuery.Category;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.entity.ChainEventKey;
import org.apache.ibatis.annotations.Mapper;

import java.util.Collection;
import java.util.List;

/**
 * 通过 MyBatis-Plus 访问 {@code chain_event} 中交易内的业务事件。
 * MyBatis-Plus mapper for business events within a transaction in {@code chain_event}.
 */
@Mapper
public interface ChainEventMapper extends BaseMapper<ChainEventDO> {

    /** 转义 PostgreSQL LIKE 模式中的下划线，精确匹配策略类型前缀。 Escape PostgreSQL's LIKE underscore wildcard to match the literal strategy type prefix. */
    String STRATEGY_TYPE_PREFIX = "STRATEGY\\_";

    /**
     * 为「查看交易回执」定位单个已索引业务事件。
     * Finds one indexed business event for View Transaction Receipt.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param key Base58 交易主签名及该交易内的零基事件序号。 Base58 primary transaction signature and zero-based event index within it.
     * @return 精确匹配的事件，未索引该事件时为空。 The exact matching event, or null if it is not indexed.
     */
    default ChainEventDO selectByEventKey(String network, ChainEventKey key) {
        // 使用完整复合主键隔离不同网络及同一笔交易内的事件。
        // Use the full composite key to isolate networks and events within the same transaction.
        return selectOne(Wrappers.lambdaQuery(ChainEventDO.class)
                .eq(ChainEventDO::getNetwork, network)
                .eq(ChainEventDO::getSignature, key.signature())
                .eq(ChainEventDO::getEventIndex, key.eventIndex()));
    }

    /**
     * 为本批交易读取活动候选事件。每笔交易内按事件序号降序返回。
     * Finds activity candidates for this transaction batch with descending event index within each transaction.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param signatures 本批交易的 Base58 主签名集合。 Base58 primary signatures of the transaction batch.
     * @param subjectAddress 可选的金库或借贷市场状态账户公钥。 Optional vault or lending market state account public key.
     * @param types 要匹配的任一业务类型。空列表允许所有类型。 Business event types to match, or an empty list to allow all types.
     * @param category 可选业务分类。空引用允许所有分类。 Optional business category, or null to allow all categories.
     * @return 与该批交易及筛选条件匹配的事件列表。 Events matching the batch and filters.
     */
    default List<ChainEventDO> selectActivityCandidates(
            String network, Collection<String> signatures, String subjectAddress, List<String> types,
            Category category
    ) {
        // 空批次不访问表，避免 IN 条件缺失后放大查询范围。
        // Skip an empty batch so the absence of an IN condition cannot broaden the query.
        if (signatures.isEmpty()) {
            return List.of();
        }
        // 分类与精确类型条件同时生效，分页只收集满足全部条件的事件。
        // Apply category and exact type conditions together so pagination counts only matching events.
        var query = Wrappers.lambdaQuery(ChainEventDO.class)
                .eq(ChainEventDO::getNetwork, network)
                .in(ChainEventDO::getSignature, signatures)
                .eq(subjectAddress != null, ChainEventDO::getSubjectAddress, subjectAddress)
                .in(!types.isEmpty(), ChainEventDO::getEventType, types);
        if (category != null) {
            query.eq(ChainEventDO::getModule, category == Category.LENDING ? "LENDING" : "VAULT")
                    .likeRight(category == Category.STRATEGY, ChainEventDO::getEventType, STRATEGY_TYPE_PREFIX)
                    .notLikeRight(category == Category.VAULT, ChainEventDO::getEventType, STRATEGY_TYPE_PREFIX);
        }
        return selectList(query.orderByDesc(ChainEventDO::getEventIndex));
    }
}

package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.support.SFunction;
import io.ggboy.backend.entity.ChainEventKey;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 为参与方和资产明细查询追加同一套事件复合键约束。
 * Applies the same composite event key constraints to participant and asset detail queries.
 */
final class ChainEventKeyConditions {

    /**
     * 工具类只提供静态方法。
     * Keeps this helper stateless and prevents instantiation.
     */
    private ChainEventKeyConditions() {
    }

    /**
     * 将事件按交易签名分组，并仅匹配每笔交易自身的事件序号。
     * Groups events by transaction signature and matches only each transaction's own event indexes.
     *
     * @param query 已限定目标网络的 Lambda 查询。 Lambda query already scoped to the target network.
     * @param signatureColumn 返回对应查询对象交易签名的 getter。 Getter for the row's transaction signature.
     * @param eventIndexColumn 返回对应查询对象零基事件序号的 getter。 Getter for the row's zero-based event index.
     * @param keys 本次明细查询的非空事件键列表。 Nonempty event key list for the detail lookup.
     * @param <T> 明细表对应的行映射类型。 Row type for the detail table.
     * @return 追加了事件键约束的查询。 Query constrained by the event keys.
     */
    static <T> LambdaQueryWrapper<T> forEvents(
            LambdaQueryWrapper<T> query, SFunction<T, String> signatureColumn,
            SFunction<T, Integer> eventIndexColumn, List<ChainEventKey> keys
    ) {
        // 每个签名只关联它自己的事件序号，避免独立 IN 条件把不同事件的主键列交叉组合。
        // Pair each signature with its own indexes so independent IN conditions cannot mix key columns from different events.
        Map<String, List<Integer>> indexesBySignature = keys.stream().collect(Collectors.groupingBy(
                ChainEventKey::signature, LinkedHashMap::new,
                Collectors.mapping(ChainEventKey::eventIndex, Collectors.toList())));
        return query.and(group -> indexesBySignature.forEach((signature, eventIndexes) -> group.or(
                sameTransaction -> sameTransaction.eq(signatureColumn, signature).in(eventIndexColumn, eventIndexes))));
    }
}

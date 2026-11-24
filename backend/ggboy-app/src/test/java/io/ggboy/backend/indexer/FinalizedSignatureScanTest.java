package io.ggboy.backend.indexer;

import io.ggboy.backend.indexer.VaultActivityData.Signature;
import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * 覆盖历史补扫、同 slot 边界和节点漏返回时的行为。
 * Covers historical backfill, same-slot boundaries and incomplete RPC history.
 */
class FinalizedSignatureScanTest {

    /**
     * 首次补扫应跨 RPC 页读取并按从旧到新返回，保留必须走过的失败交易。
     * Initial backfill crosses RPC pages, delivering oldest first including failed transactions to skip.
     */
    @Test
    void discoversAllPagesOnFirstRun() {
        /** 较早的失败交易必须纳入检查点序列。 An earlier failed transaction must remain in the checkpoint sequence. */
        Signature first = new Signature("first", BigInteger.ONE, true);
        /** 最后成交的签名排在 RPC 首页。 Latest signature appears on the first RPC page. */
        Signature last = signature("last", 8);
        /** 记录每次传给节点的排他签名。 Records the exclusive RPC cursor on each call. */
        List<String> cursors = new ArrayList<>();
        assertEquals(List.of(first, last), FinalizedSignatureScan.collectPending(null, before -> {
            cursors.add(before == null ? "<initial>" : before);
            if (before == null) {
                return List.of(last);
            }
            return before.equals(last.value()) ? List.of(first) : List.of();
        }, 20));
        assertEquals(List.of("<initial>", "last", "first"), cursors);
    }

    /**
     * 检查点与新交易在同一 slot 时，扫描应继续到精确签名。
     * A newer transaction sharing the checkpoint's slot is still discovered before the exact signature.
     */
    @Test
    void resumesAtExactSignatureWithinSameSlot() {
        /** 同一 slot 中先后成交的两个签名。 Earlier and later signatures in the same slot. */
        Signature boundary = signature("boundary", 12);
        Signature pending = signature("pending", 12);
        /** 已经扫过、比检查点早的签名。 Older signature already covered by the checkpoint. */
        Signature older = signature("older", 11);
        assertEquals(List.of(pending),
                FinalizedSignatureScan.collectPending(boundary, before -> before == null
                        ? List.of(pending) : List.of(boundary, older), 20));
        assertEquals(List.of(), FinalizedSignatureScan.collectPending(boundary, before -> List.of(boundary), 20));
    }

    /**
     * 历史被裁剪、响应跳过检查点或列表重复时，应停止推进。
     * Pauses progress when RPC history is pruned, skips the checkpoint, or repeats a page.
     */
    @Test
    void refusesMissingCheckpointAndRepeatedPages() {
        /** RPC 缺失的已保存签名，加上可供节点返回的更早或更晚签名。 Saved signature omitted by RPC and older or newer positions returned by it. */
        Signature boundary = signature("boundary", 10);
        Signature earlier = signature("earlier", 9);
        Signature later = signature("later", 11);
        assertThrows(IllegalStateException.class,
                () -> FinalizedSignatureScan.collectPending(boundary, before -> List.of(earlier), 20));
        assertThrows(IllegalStateException.class,
                () -> FinalizedSignatureScan.collectPending(boundary, before -> before == null ? List.of(later) : List.of(), 20));
        assertThrows(IllegalStateException.class,
                () -> FinalizedSignatureScan.collectPending(null, before -> List.of(earlier), 20));
    }

    /**
     * 每轮限制回执数时只返回与检查点连续的最老批次，下一轮从该批次末尾接续。
     * With capped receipt reads, keep the oldest contiguous batch and resume from its final entry the next pass.
     */
    @Test
    void keepsOldestBoundedBatchAcrossPages() {
        /** 已处理边界与后续三笔最终确认交易。 Processed frontier and the following three finalized entries. */
        Signature checkpoint = signature("checkpoint", 90);
        Signature next = signature("next", 91);
        Signature middle = signature("middle", 91);
        Signature newest = signature("newest", 92);
        assertEquals(List.of(next, middle), FinalizedSignatureScan.collectPending(checkpoint,
                before -> before == null ? List.of(newest, middle) : List.of(next, checkpoint), 2));
        assertEquals(List.of(newest), FinalizedSignatureScan.collectPending(middle,
                before -> List.of(newest, middle, next, checkpoint), 2));
    }

    /**
     * 为纯分页测试构造成功交易的位置，测试字符串不会传给 RPC。
     * Creates successful positions for pagination tests. Test strings never reach RPC.
     *
     * @param value 用于区分交易的测试标识。 Test marker distinguishing one transaction from another.
     * @param slot 测试中的已确认 slot。 Finalized slot in the scenario.
     * @return 内部签名位置。 Internal signature position.
     */
    private static Signature signature(String value, long slot) {
        return new Signature(value, BigInteger.valueOf(slot), false);
    }
}

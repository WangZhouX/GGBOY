package io.ggboy.backend.indexer;

import io.ggboy.backend.indexer.VaultActivityData.Signature;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * 共用的最终确认签名页扫描，严格验证连续边界并保留本轮可处理的最老交易。
 * Shared finalized signature scan, verifying continuity and retaining the oldest transactions for this pass.
 */
final class FinalizedSignatureScan {

    /** 仅提供静态分页逻辑。 Provides only stateless pagination logic. */
    private FinalizedSignatureScan() {
    }

    /**
     * 翻阅由新到旧的 RPC 签名页，核对持久化边界后按从旧到新返回待处理记录。
     * Pages backward through RPC history, verifies the persisted boundary, and returns pending records oldest first.
     *
     * @param checkpoint 已处理的最后一个签名，首次补扫为空。 Last processed signature, null for the initial backfill.
     * @param listPage 输入为排他 before 签名，首次请求为空。 Page loader receiving the exclusive before signature or null for the first call.
     * @param limit 单轮保留的最老待处理签名个数，限制回执查询总量。 Oldest pending signatures retained per pass, bounding receipt calls.
     * @return 检查点之后的一段连续待处理签名，按从旧到新排列。 A contiguous slice of pending signatures after the checkpoint, oldest first.
     * @throws IllegalStateException 节点结果不连续或已保存的检查点不可见。 RPC history is inconsistent or no longer shows the saved checkpoint.
     */
    static List<Signature> collectPending(Signature checkpoint, Function<String, List<Signature>> listPage, int limit) {
        /** 只保留离检查点最近的待处理签名，顺序与 RPC 页相反。 Retain only the pending signatures nearest the frontier in reverse RPC order. */
        ArrayDeque<Signature> oldestFirst = new ArrayDeque<>(limit);
        /** 拒绝重复页或不推进的 before 边界。 Seen signatures used to reject repeated pages or a stalled before cursor. */
        Set<String> seen = new HashSet<>();
        /** 下一页边界和跨页 slot 顺序的比较基准。 Boundary for the next page and reference for slot order across pages. */
        Signature previous = null;

        while (true) {
            /** 当前位置的一页。空页表示节点没有更早的可用历史。 Page at the current position, empty at the end of available RPC history. */
            List<Signature> page = listPage.apply(previous == null ? null : previous.value());
            if (page.isEmpty()) {
                if (checkpoint != null) {
                    throw new IllegalStateException("Devnet RPC did not return the saved activity history checkpoint.");
                }
                return List.copyOf(oldestFirst);
            }
            for (Signature candidate : page) {
                if (!seen.add(candidate.value()) || (previous != null && candidate.slot().compareTo(previous.slot()) > 0)) {
                    throw new IllegalStateException("Devnet RPC returned an inconsistent activity signature page.");
                }
                if (checkpoint != null) {
                    /** 同一 slot 可能有多笔，须找到精确签名才能确定连续。 A slot can hold multiple transactions, so require the exact boundary signature. */
                    int relativeSlot = candidate.slot().compareTo(checkpoint.slot());
                    if (relativeSlot == 0 && candidate.value().equals(checkpoint.value())) {
                        return List.copyOf(oldestFirst);
                    }
                    if (relativeSlot < 0 || candidate.value().equals(checkpoint.value())) {
                        throw new IllegalStateException("Devnet RPC skipped the saved activity history checkpoint.");
                    }
                }
                // 越往后读取，离保存的边界越近。队列满时淘汰最新的一条以保留连续的下一批。
                // Later reads are nearer the frontier. Evict the newest entry to keep the next contiguous batch.
                if (oldestFirst.size() == limit) {
                    oldestFirst.removeLast();
                }
                oldestFirst.addFirst(candidate);
                previous = candidate;
            }
        }
    }
}

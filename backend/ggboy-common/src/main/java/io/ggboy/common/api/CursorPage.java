package io.ggboy.common.api;

import java.util.List;

/**
 * 按查询顺序返回一页匹配记录及其后续游标。末页的游标为空。
 * Returns one page of matching items in query order and its continuation cursor. The final page has a null cursor.
 *
 * @param <T> 单条查询记录的类型。 Type of an individual query result.
 * @param items 本页记录的只读列表，保留查询顺序，允许为空列表。 Read-only list in query order, possibly empty.
 * @param nextCursor 服务生成的下一页游标，末页为 {@code null}。 Opaque service-issued cursor, or {@code null} on the final page.
 */
public record CursorPage<T>(List<T> items, String nextCursor) {

    /**
     * 固定本页的记录顺序与成员，原样保留服务生成的游标。
     * Snapshots the page membership and ordering and preserves the service-issued cursor verbatim.
     *
     * @param items 已匹配的记录列表，每个元素均须非空。 Matching items, each of which must be non-null.
     * @param nextCursor 后续游标，至少含一个非空白字符；末页传 {@code null}。
     *                   Continuation cursor containing a non-whitespace character, or {@code null} for the final page.
     * @throws NullPointerException 列表或其中任一元素为空。 The list or one of its elements is null.
     * @throws IllegalArgumentException 游标为空白，或空页携带后续游标。 The cursor is blank or an empty page has a continuation cursor.
     */
    public CursorPage {
        // 复制列表以隔离调用方的后续增删，同时拒绝空元素并保留原排序。
        // Copy the list to isolate later changes to the caller's collection, reject null elements and retain ordering.
        items = List.copyOf(items);
        // 游标格式由查询服务定义，公共响应只检查是否包含可传递的内容。
        // The query service owns the cursor format. The response only checks that a supplied token contains content.
        if (nextCursor != null && nextCursor.isBlank()) {
            throw new IllegalArgumentException("nextCursor must contain a non-whitespace character");
        }
        // 下一页从本页已返回的记录继续，空页没有可供继续查询的最后一条记录。
        // Continuation starts after the last returned item, so an empty page has no continuation point.
        if (items.isEmpty() && nextCursor != null) {
            throw new IllegalArgumentException("An empty page cannot have a continuation cursor");
        }
    }
}

package io.ggboy.common.api;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 验证游标分页对客户端公开的数据约束。 Verifies the cursor page invariants exposed to clients. */
class CursorPageTest {

    /** 验证调用方和接收方都无法改变已返回的记录顺序。 Verifies that neither side can change the returned item order. */
    @Test
    void snapshotsItemsAndPreservesTheOpaqueCursor() {
        // 模拟查询服务随后复用的可变列表。 Mutable list that the query service will reuse.
        var rows = new ArrayList<>(List.of("second", "first"));
        // 空格是这个示例令牌的一部分，用以验证游标原样传输。 Spaces in this sample token verify verbatim transport.
        String cursor = " token:2 ";
        // 捕获记录和令牌后再修改输入列表。 Capture the page and token before mutating the source list.
        var page = new CursorPage<>(rows, cursor);
        rows.clear();

        assertEquals(List.of("second", "first"), page.items());
        assertThrows(UnsupportedOperationException.class, () -> page.items().clear());
        assertEquals(cursor, page.nextCursor());
    }

    /** 末页可以有记录，也可以是空的查询结果。 The final page may contain matching items or be empty. */
    @Test
    void acceptsFinalPagesWithAndWithoutMatches() {
        assertNull(new CursorPage<>(List.of("last"), null).nextCursor());
        // 无匹配记录时，列表仍可作为成功业务数据返回。 With no matches, the page is still a successful business payload.
        var emptyPage = new CursorPage<String>(List.of(), null);
        assertEquals(List.of(), emptyPage.items());
        assertNull(emptyPage.nextCursor());
        assertEquals(emptyPage, ApiResponse.success(emptyPage).data());
    }

    /** 分页数据必须是实际列表，且每条记录非空。 Page data requires a list with non-null entries. */
    @Test
    void rejectsMissingItemsAndNullEntries() {
        assertThrows(NullPointerException.class, () -> new CursorPage<>(null, null));
        assertThrows(NullPointerException.class, () -> new CursorPage<>(Arrays.asList("item", null), null));
    }

    /** 拒绝空白游标，以及空页上的后续游标。 Rejects blank cursors and continuation from an empty page. */
    @Test
    void rejectsInvalidContinuation() {
        assertThrows(IllegalArgumentException.class, () -> new CursorPage<>(List.of("item"), ""));
        assertThrows(IllegalArgumentException.class, () -> new CursorPage<>(List.of("item"), " \t"));
        assertThrows(IllegalArgumentException.class, () -> new CursorPage<>(List.of(), "next"));
    }
}

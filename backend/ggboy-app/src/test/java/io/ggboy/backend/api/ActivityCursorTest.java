package io.ggboy.backend.api;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 验证活动游标的完整排序键、筛选范围和输入文法。 Verifies the activity cursor's full sort key, filter scope, and syntax. */
class ActivityCursorTest {

    /** 恰好编码 32 字节的测试钱包。 Test wallet encoding exactly 32 bytes. */
    private static final String WALLET = "1".repeat(32);

    /** 不同于测试钱包的金库地址。 Vault address distinct from the test wallet. */
    private static final String VAULT = "1".repeat(31) + "2";

    /** 有效且达到 Base58 上限文本长度的测试签名。 Valid fixture signature with the maximum Base58 text length. */
    private static final String SIGNATURE = "2" + "1".repeat(87);

    /** 带有钱包、金库、签名和两个事件类型限制的活动查询。 Activity query restricted by wallet, vault, signature, and two event types. */
    private static final ActivityQuery QUERY = ActivityQuery.parse("localnet", WALLET, VAULT, SIGNATURE,
            List.of("VAULT_DEPOSIT", "VAULT_REDEEM"), "4");

    /** 覆盖无符号 slot 和事件索引上界的页边界。 Page boundary covering maximum unsigned slot and maximum event index. */
    private static final ActivityCursor BOUNDARY = new ActivityCursor(
            new BigInteger("18446744073709551615"), SIGNATURE, Integer.MAX_VALUE);

    /** 省略游标保留首屏，长游标无损保存交易在链上的排序键。 An omitted cursor requests the first page, and long cursors preserve the sort key. */
    @Test
    void roundTripsMaximumSortKey() {
        // 使用最长合法载荷，防止预解码长度检查误拒绝合法游标。
        // Use the longest valid payload so the pre-decode limit cannot accidentally reject a valid cursor.
        String token = ActivityCursor.encode(QUERY, BOUNDARY);
        assertEquals(252, token.length());
        assertTrue(token.matches("[A-Za-z0-9_-]+"));
        assertEquals(BOUNDARY, ActivityCursor.decode(QUERY, token));
        assertNull(ActivityCursor.decode(QUERY, null));
    }

    /** 等价的 OR 类型筛选和新页长可以继续使用原游标。 Equivalent OR filters and a new page size preserve the cursor. */
    @Test
    void allowsEquivalentTypeFiltersAndDifferentPageSize() {
        // 更改类型顺序、重复部分类型并改变页长，实际匹配集合不变。
        // Reorder and repeat some types and change page size, keeping the matching set identical.
        var equivalent = ActivityQuery.parse("localnet", WALLET, VAULT, SIGNATURE,
                List.of("VAULT_REDEEM", "VAULT_DEPOSIT", "VAULT_DEPOSIT"), "100");
        assertEquals(BOUNDARY, ActivityCursor.decode(equivalent, ActivityCursor.encode(QUERY, BOUNDARY)));
    }

    /** 游标不能跨网络、钱包、业务主体、签名或类型复用。 A cursor cannot cross network, wallet, subject, signature, or type scope. */
    @Test
    void rejectsReuseWhenMatchingScopeChanges() {
        // 分别改变一种匹配条件，核对摘要涵盖所有匹配字段。
        // Change one match criterion at a time to verify all match fields are fingerprinted.
        var scopes = List.of(
                ActivityQuery.parse("devnet", WALLET, VAULT, SIGNATURE, QUERY.types(), "4"),
                ActivityQuery.parse("localnet", null, VAULT, SIGNATURE, QUERY.types(), "4"),
                ActivityQuery.parse("localnet", WALLET, null, SIGNATURE, QUERY.types(), "4"),
                ActivityQuery.parse("localnet", WALLET, VAULT, null, QUERY.types(), "4"),
                ActivityQuery.parse("localnet", WALLET, VAULT, SIGNATURE, List.of("VAULT_DEPOSIT"), "4")
        );
        String token = ActivityCursor.encode(QUERY, BOUNDARY);
        for (ActivityQuery changed : scopes) {
            assertThrows(IllegalArgumentException.class, () -> ActivityCursor.decode(changed, token));
        }
    }

    /**
     * 拒绝负数、空白、非规范数字或 int 溢出的事件索引。
     * Rejects negative, blank, noncanonical, or overflowing index text.
     *
     * @param invalidIndex 无效的页边界事件索引文本。 Invalid page boundary index text.
     */
    @ParameterizedTest
    @ValueSource(strings = {"", "01", "-1", "+1", "2147483648"})
    void rejectsMalformedIndexWithinCursor(String invalidIndex) {
        // 使用短签名和小 slot 产生未超长的合法编码，让错误确实发生在事件索引校验阶段。
        // Use a short signature and small slot so the malformed value reaches index validation.
        var boundary = new ActivityCursor(BigInteger.ONE, "1".repeat(64), 1);
        String token = ActivityCursor.encode(QUERY, boundary);
        String payload = new String(Base64.getUrlDecoder().decode(token), StandardCharsets.US_ASCII);
        String malformed = payload.substring(0, payload.lastIndexOf(':') + 1) + invalidIndex;
        String malformedToken = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(malformed.getBytes(StandardCharsets.US_ASCII));
        assertThrows(IllegalArgumentException.class, () -> ActivityCursor.decode(QUERY, malformedToken));
    }

    /** 明确拒绝错误长度、非法字符及可替代的填充编码。 Rejects invalid length, alphabet, and alternate padded encodings. */
    @Test
    void rejectsInvalidWireEncoding() {
        // 使用短载荷保留本应在无填充编码中被省略的末尾填充符。
        // Use a short payload with padding that would otherwise be omitted.
        var boundary = new ActivityCursor(BigInteger.ONE, "1".repeat(64), 1);
        String token = ActivityCursor.encode(QUERY, boundary);
        assertThrows(IllegalArgumentException.class, () -> ActivityCursor.decode(QUERY, ""));
        assertThrows(IllegalArgumentException.class, () -> ActivityCursor.decode(QUERY, "++"));
        assertThrows(IllegalArgumentException.class, () -> ActivityCursor.decode(QUERY, token + "="));
        assertThrows(IllegalArgumentException.class, () -> ActivityCursor.decode(QUERY, "A".repeat(253)));
    }
}

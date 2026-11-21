package io.ggboy.backend.api;

import io.ggboy.common.api.SolanaNetwork;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 验证历史游标的查询范围和 slot 边界。 Verifies query scope and slot boundaries for vault history cursors. */
class VaultHistoryCursorTest {

    /** 固定测试金库公钥。 Public key of the fixture vault. */
    private static final String VAULT = "GYVb4hWw8D22pkScWSZZB1QjT7jmuFkPCR1a9DCe1GjY";

    /** 同网络上的另一个公开账户地址，用于验证范围约束。 Another public account address for checking the scope guard. */
    private static final String OTHER_VAULT = "GfsJWjmGXMfct8JMR9Lm9ySUnniZbnGUTQDbT8ipWf9U";

    /** 缺省游标对应首屏，没有 slot 上界。 An omitted cursor requests the first page without a slot bound. */
    @Test
    void permitsOmittedCursor() {
        assertNull(VaultHistoryCursor.decode(null, SolanaNetwork.LOCALNET, VAULT));
    }

    /**
     * 验证游标能无损保存 u64 槽位，且只含 URL 安全字符。
     * Verifies lossless u64 slot encoding with a URL-safe alphabet.
     *
     * @param slotText 要往返校验的无符号 slot 十进制文本。 Unsigned slot text to round-trip.
     */
    @ParameterizedTest
    @ValueSource(strings = {"0", "10", "18446744073709551615"})
    void roundTripsUnsignedSlots(String slotText) {
        // 使用 BigInteger 构造零值、普通值和超出 Java long 范围的上界。
        // Use BigInteger for zero, a normal value, and the upper bound beyond signed Java long.
        BigInteger slot = new BigInteger(slotText);
        String cursor = VaultHistoryCursor.encode(SolanaNetwork.LOCALNET, VAULT, slot);
        assertTrue(cursor.matches("[A-Za-z0-9_-]+"));
        assertEquals(slot, VaultHistoryCursor.decode(cursor, SolanaNetwork.LOCALNET, VAULT));
    }

    /** 原样重用游标时，网络和金库地址均须符合原请求。 Reused cursors must match both the original network and vault. */
    @Test
    void rejectsCursorFromAnotherQuery() {
        // 生成仅对本地网指定金库有效的游标。
        // Issue a cursor scoped to one vault on localnet.
        String cursor = VaultHistoryCursor.encode(SolanaNetwork.LOCALNET, VAULT, BigInteger.ONE);
        assertThrows(IllegalArgumentException.class,
                () -> VaultHistoryCursor.decode(cursor, SolanaNetwork.DEVNET, VAULT));
        assertThrows(IllegalArgumentException.class,
                () -> VaultHistoryCursor.decode(cursor, SolanaNetwork.LOCALNET, OTHER_VAULT));
    }

    /** 拒绝错误版本、空值、超长文本和非规范 Base64。 Rejects bad versions, empty or oversized inputs, and noncanonical Base64. */
    @Test
    void rejectsMalformedEncodings() {
        // 合法游标和改用未支持版本标识的游标。
        // Construct a valid cursor and one with an unsupported version marker.
        String canonical = VaultHistoryCursor.encode(SolanaNetwork.LOCALNET, VAULT, BigInteger.ONE);
        String invalidVersion = encodeUncheckedPayload("vh2:localnet:" + VAULT + ":1");
        assertThrows(IllegalArgumentException.class,
                () -> VaultHistoryCursor.decode(canonical + "=", SolanaNetwork.LOCALNET, VAULT));
        assertThrows(IllegalArgumentException.class,
                () -> VaultHistoryCursor.decode(invalidVersion, SolanaNetwork.LOCALNET, VAULT));
        assertThrows(IllegalArgumentException.class,
                () -> VaultHistoryCursor.decode("", SolanaNetwork.LOCALNET, VAULT));
        assertThrows(IllegalArgumentException.class,
                () -> VaultHistoryCursor.decode("abc/", SolanaNetwork.LOCALNET, VAULT));
        assertThrows(IllegalArgumentException.class,
                () -> VaultHistoryCursor.decode("A".repeat(105), SolanaNetwork.LOCALNET, VAULT));
    }

    /**
     * 拒绝非标准十进制文本和溢出的 slot。
     * Rejects noncanonical decimal slots and overflow.
     *
     * @param invalidSlot 文法非法或无法存入 u64 的槽位文本。 Slot text that is malformed or outside u64.
     */
    @ParameterizedTest
    @ValueSource(strings = {"", "-1", "+1", "01", "1:2", "18446744073709551616"})
    void rejectsInvalidSlotPayloads(String invalidSlot) {
        // 用合法 Base64 包装非法 slot，使断言覆盖解码后的数值校验。
        // Wrap an invalid slot in valid Base64 to exercise post-decode validation.
        String cursor = encodeUncheckedPayload("vh1:localnet:" + VAULT + ":" + invalidSlot);
        assertThrows(IllegalArgumentException.class,
                () -> VaultHistoryCursor.decode(cursor, SolanaNetwork.LOCALNET, VAULT));
    }

    /**
     * 将测试文本直接包装成游标，以构造正常编码器不会生成的输入。
     * Wraps test payloads that the production encoder cannot generate.
     *
     * @param payload 自行构造的游标文本。 Manually constructed cursor payload.
     * @return URL 安全且无填充的 Base64 文本。 URL-safe Base64 text without padding.
     */
    private static String encodeUncheckedPayload(String payload) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.US_ASCII));
    }
}

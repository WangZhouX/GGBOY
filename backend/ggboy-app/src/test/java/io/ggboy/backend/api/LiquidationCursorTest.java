package io.ggboy.backend.api;

import io.ggboy.common.api.SolanaNetwork;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 验证清算游标的精确排序键、查询范围和观测版本。 Verifies exact ordering keys, query scope, and observations for liquidation cursors. */
class LiquidationCursorTest {

    /** 测试借贷市场公钥。 Lending market public key used in the tests. */
    private static final String MARKET = "GYVb4hWw8D22pkScWSZZB1QjT7jmuFkPCR1a9DCe1GjY";

    /** 测试钱包公钥，也用来构造不同市场的请求。 Fixture wallet public key, also used to scope a request to a different market. */
    private static final String WALLET = "GfsJWjmGXMfct8JMR9Lm9ySUnniZbnGUTQDbT8ipWf9U";

    /** 预言机报价观测摘要。 Oracle price observation digest. */
    private static final String PRICE_VERSION = "a".repeat(64);

    /** 数据库健康度列可精确存储的最大值。 Largest exact value that fits the database health factor column. */
    private static final BigDecimal MAX_HEALTH = new BigDecimal("9".repeat(39) + "." + "9".repeat(12));

    /** 验证未传游标时请求首屏，并保留零健康度和零 slot。 Verifies omission selects the first page and zero health and slot round-trip. */
    @Test
    void permitsOmittedCursorAndZeroValues() {
        assertNull(LiquidationCursor.decode(null, SolanaNetwork.LOCALNET, MARKET));
        // 32 个前导 1 编码 32 个零字节，覆盖 Base58 前导零公钥。
        // Thirty-two leading ones encode thirty-two zero bytes, exercising leading zero bytes in a Base58 public key.
        LiquidationCursor zero = new LiquidationCursor(BigInteger.ZERO, PRICE_VERSION, BigDecimal.ZERO, "1".repeat(32));
        assertEquals(zero, LiquidationCursor.decode(LiquidationCursor.encode(SolanaNetwork.LOCALNET, MARKET, zero),
                SolanaNetwork.LOCALNET, MARKET));
    }

    /** 验证最长合法游标、u64 上界和健康度最大精度。 Verifies the longest valid cursor, unsigned slot limit, and maximum health precision. */
    @Test
    void roundTripsTheLargestFields() {
        // 使用允许的最长字段构造游标，以同时验证编码长度上限。
        // Build the cursor from the longest permitted fields to exercise the encoded length limit.
        LiquidationCursor boundary = new LiquidationCursor(new BigInteger("18446744073709551615"), PRICE_VERSION, MAX_HEALTH, WALLET);
        String token = LiquidationCursor.encode(SolanaNetwork.LOCALNET, MARKET, boundary);
        assertEquals(322, token.length());
        assertTrue(token.matches("[A-Za-z0-9_-]+"));
        assertEquals(boundary, LiquidationCursor.decode(token, SolanaNetwork.LOCALNET, MARKET));

        // 末尾 Base64 符号的未使用位必须为零，即使解码器可以接受相同字节的其他形式。
        // Unused bits in the final Base64 symbol must be zero even when the decoder accepts alternate forms of the same bytes.
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        // finalIndex 是合法游标末尾符号在编码表中的索引。 The final index locates the last canonical symbol in the alphabet.
        int finalIndex = alphabet.indexOf(token.charAt(token.length() - 1));
        // alternate 只改动末尾符号中的一个未使用位。 The alternate token changes one unused bit in the final symbol.
        String alternate = token.substring(0, token.length() - 1) + alphabet.charAt(finalIndex + 1);
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(alternate, SolanaNetwork.LOCALNET, MARKET));
    }

    /** 验证相同健康度的不同十进制 scale 产生相同游标。 Verifies that decimal scale variants of the same value produce identical cursors. */
    @Test
    void canonicalizesHealthFactorWithoutRounding() {
        // 13 位 scale 的输入值与最小正健康度相等，移除无效尾零后可精确存储。
        // The value supplied at scale 13 equals the smallest positive health factor and fits after removing its trailing zero.
        LiquidationCursor scaled = new LiquidationCursor(BigInteger.ONE, PRICE_VERSION, new BigDecimal("0.0000000000010"), WALLET);
        // scientific 以指数形式传入同一个精确的十进制健康度。 The scientific fixture supplies the same exact decimal health factor in exponent form.
        LiquidationCursor scientific = new LiquidationCursor(BigInteger.ONE, PRICE_VERSION, new BigDecimal("1e-12"), WALLET);
        assertEquals(scientific, scaled);
        assertEquals(LiquidationCursor.encode(SolanaNetwork.DEVNET, MARKET, scientific),
                LiquidationCursor.encode(SolanaNetwork.DEVNET, MARKET, scaled));
        assertEquals(new BigDecimal("0.000000000001"), scaled.healthFactor());

        assertThrows(IllegalArgumentException.class,
                () -> new LiquidationCursor(BigInteger.ONE, PRICE_VERSION, new BigDecimal("1e-13"), WALLET));
        assertThrows(IllegalArgumentException.class,
                () -> new LiquidationCursor(BigInteger.ONE, PRICE_VERSION, new BigDecimal("1e39"), WALLET));
    }

    /** 验证查询范围绑定网络和市场。 Verifies that query scope binds both network and market. */
    @Test
    void rejectsDifferentQueryScope() {
        // 一张本地网市场的游标在其他网络或市场无效。
        // A localnet market cursor is invalid on another network or market.
        String token = encodePayload("1", PRICE_VERSION, "0.75", WALLET);
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(token, SolanaNetwork.DEVNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(token, SolanaNetwork.LOCALNET, WALLET));
    }

    /** 验证空、超长、非 URL 安全或有填充的编码会被拒绝。 Verifies rejection of empty, oversized, non-URL-safe, or padded encodings. */
    @Test
    void rejectsMalformedEncodings() {
        // 合法游标可用于手动追加多余的填充字符。
        // Use a valid cursor as the basis for manually adding unexpected padding.
        String token = encodePayload("1", PRICE_VERSION, "0.75", WALLET);
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(token + "=", SolanaNetwork.LOCALNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode("", SolanaNetwork.LOCALNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode("abc/", SolanaNetwork.LOCALNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode("A".repeat(323), SolanaNetwork.LOCALNET, MARKET));
    }

    /**
     * 验证游标中的健康度文本必须是精度范围内的标准非负十进制。
     * Verifies that the health factor inside a cursor must be canonical, nonnegative decimal text within its precision bounds.
     *
     * @param health 非法健康度的原始文本。 Raw text of an invalid health factor.
     */
    @ParameterizedTest
    @ValueSource(strings = {"", "-1", "-0", "+1", "00", ".5", "1.", "0.0", "0.050", "1e-2", "0.0000000000001",
            "1000000000000000000000000000000000000000"})
    void rejectsInvalidHealthFactorText(String health) {
        // 保持其余字段有效以单独验证健康度。
        // Keep the remaining fields valid to exercise health factor validation in isolation.
        String token = encodePayload("1", PRICE_VERSION, health, WALLET);
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(token, SolanaNetwork.LOCALNET, MARKET));
    }

    /** 验证格式版本、无符号 slot、摘要、钱包和字段数量的校验。 Verifies format version, unsigned slot, digest, wallet, and field-count validation. */
    @Test
    void rejectsOtherMalformedFields() {
        // 改写格式版本并保留其余有效字段。 Change the version marker while preserving the other valid fields.
        String unknownVersion = Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("lc2:localnet:" + MARKET + ":1:" + PRICE_VERSION + ":0.75:" + WALLET).getBytes(StandardCharsets.US_ASCII));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(unknownVersion, SolanaNetwork.LOCALNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(
                encodePayload("01", PRICE_VERSION, "0.75", WALLET), SolanaNetwork.LOCALNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(
                encodePayload("18446744073709551616", PRICE_VERSION, "0.75", WALLET), SolanaNetwork.LOCALNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(
                encodePayload("1", "A".repeat(64), "0.75", WALLET), SolanaNetwork.LOCALNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(
                encodePayload("1", "a".repeat(63), "0.75", WALLET), SolanaNetwork.LOCALNET, MARKET));

        // 32 位 Base58 文本可以解码成短于 32 字节的值，必须校验实际长度。
        // Thirty-two Base58 characters can decode to fewer than thirty-two bytes, so check the decoded length.
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(
                encodePayload("1", PRICE_VERSION, "0.75", "2".repeat(32)), SolanaNetwork.LOCALNET, MARKET));
        assertThrows(IllegalArgumentException.class, () -> LiquidationCursor.decode(
                encodePayload("1", PRICE_VERSION, "0.75", WALLET + ":extra"), SolanaNetwork.LOCALNET, MARKET));
    }

    /** 单独验证观测变化的异常类型，便于清算页与无效游标区分。 Verifies the changed-observation exception so liquidation pages can distinguish it from invalid tokens. */
    @Test
    void rejectsChangedReadyObservations() {
        // 使用已解码的游标验证两个版本字段，各自变化时都要求从首屏开始。
        // Start from a decoded cursor and check that either changed version requires a restart at page one.
        LiquidationCursor cursor = LiquidationCursor.decode(encodePayload("1", PRICE_VERSION, "0.75", WALLET),
                SolanaNetwork.LOCALNET, MARKET);
        assertDoesNotThrow(() -> cursor.requireObservation(BigInteger.ONE, PRICE_VERSION));
        assertThrows(LiquidationCursor.ObservationChangedException.class,
                () -> cursor.requireObservation(BigInteger.TWO, PRICE_VERSION));
        assertThrows(LiquidationCursor.ObservationChangedException.class,
                () -> cursor.requireObservation(BigInteger.ONE, "b".repeat(64)));
    }

    /**
     * 绕过生产编码前的校验，将测试字段直接编为当前版本的 Base64 游标。
     * Encodes arbitrary test fields into current-version Base64 cursor text, bypassing production encode-time validation.
     *
     * @param slot 原始市场 slot。 Raw market slot.
     * @param priceVersion 原始价格摘要。 Raw price digest.
     * @param health 原始健康度。 Raw health factor.
     * @param wallet 原始钱包地址。 Raw wallet address.
     * @return 测试用 Base64 游标文本。 Base64 cursor text for testing.
     */
    private static String encodePayload(String slot, String priceVersion, String health, String wallet) {
        // payload 是模拟客户端提交的未经校验的字段拼接结果。 Payload joins the unchecked fields of a simulated client request.
        String payload = "lc1:localnet:" + MARKET + ":" + slot + ":" + priceVersion + ":" + health + ":" + wallet;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.US_ASCII));
    }
}

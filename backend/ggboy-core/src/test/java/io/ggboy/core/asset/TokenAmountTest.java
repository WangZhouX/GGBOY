package io.ggboy.core.asset;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 检验 SPL 数量与 Mint 编码的边界。 / Verifies boundaries for SPL quantities and mint encodings. */
public class TokenAmountTest {

    /** 32 字节全为 0xff 的 Base58 公钥。 / Base58 public key consisting of 32 bytes of 0xff. */
    private static final String HIGH_BIT_MINT = "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG";

    /** SPL 单笔原始数量允许的最大值。 / Maximum raw quantity for one SPL movement. */
    private static final BigInteger MAX_U64 = new BigInteger("18446744073709551615");

    /** 校验最大原始金额和 Mint 精度原样保留。 / Verifies the maximum quantity and mint precision are preserved. */
    @Test
    public void preservesMaximumUnsignedAmount() {
        // 最高位为 1 的金额和公钥都必须按无符号值处理。
        // The amount and the public key both have their high bit set and must be treated as unsigned.
        TokenAmount amount = new TokenAmount(HIGH_BIT_MINT, 255, MAX_U64);
        assertEquals(MAX_U64, amount.amountRaw());
        assertEquals(255, amount.decimals());
        assertEquals(HIGH_BIT_MINT, amount.mint());
    }

    /** 拒绝超出 u64 任一边界的数量。 / Rejects quantities outside either bound of u64. */
    @Test
    public void rejectsQuantitiesOutsideUnsignedRange() {
        assertThrows(IllegalArgumentException.class,
                () -> new TokenAmount(HIGH_BIT_MINT, 6, MAX_U64.add(BigInteger.ONE)));
        assertThrows(IllegalArgumentException.class,
                () -> new TokenAmount(HIGH_BIT_MINT, 6, BigInteger.ONE.negate()));
    }

    /** 保留 Base58 公钥的前导零字节。 / Preserves leading zero bytes in a Base58 public key. */
    @Test
    public void acceptsPublicKeyWithLeadingZeroBytes() {
        // 前 31 个 '1' 表示零字节，最后的 '2' 表示 0x01。
        // The first 31 '1' characters encode zero bytes and the last '2' encodes 0x01.
        String mint = "1".repeat(31) + "2";
        assertEquals(mint, new TokenAmount(mint, 0, BigInteger.ZERO).mint());
    }

    /** 编码文本长度合规时仍要按解码长度验证公钥。 / Checks the decoded length even for acceptable text lengths. */
    @Test
    public void rejectsKeysThatDoNotDecodeToThirtyTwoBytes() {
        // 两个字符串均为有效 Base58 文本，但解码后一个不足 32 字节，另一个有 33 字节。
        // Both strings are valid Base58 text, but one decodes to fewer than 32 bytes and the other to 33.
        assertThrows(IllegalArgumentException.class,
                () -> new TokenAmount("2".repeat(32), 6, BigInteger.ZERO));
        assertThrows(IllegalArgumentException.class,
                () -> new TokenAmount("1".repeat(33), 6, BigInteger.ZERO));
    }
}

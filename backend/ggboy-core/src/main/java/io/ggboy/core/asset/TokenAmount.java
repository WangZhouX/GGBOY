package io.ggboy.core.asset;

import io.ggboy.common.utils.UnsignedIntegerUtil;

import java.math.BigInteger;
import java.util.Objects;

/**
 * 一笔 SPL Token 资产变动的精确金额。 / Exact amount of one SPL token movement.
 *
 * @param mint 代币 Mint 的 Base58 公钥。 / Base58 public key of the token mint.
 * @param decimals Mint 的小数位数，范围为 0 到 255。 / Mint decimal precision, from 0 through 255.
 * @param amountRaw 以最小代币单位表示的无符号 64 位整数。 / Unsigned 64-bit quantity in token base units.
 */
public record TokenAmount(String mint, int decimals, BigInteger amountRaw) {

    /** Solana 公钥使用的 Base58 字母表。 / Base58 alphabet for Solana public keys. */
    private static final String BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    /** 解码公钥时使用的进位基数。 / Numeric radix used to decode public keys. */
    private static final BigInteger RADIX = BigInteger.valueOf(BASE58.length());

    /**
     * 校验 Mint 的公钥编码和链上金额字段的范围。 / Validates the mint public key encoding and on-chain amount ranges.
     *
     * @throws NullPointerException Mint 或原始金额为空。 / The mint or raw amount is null.
     * @throws IllegalArgumentException 公钥编码、精度或数量越界。 / The key encoding, precision or quantity is invalid.
     */
    public TokenAmount {
        validateMint(Objects.requireNonNull(mint, "mint"));
        if (decimals < 0 || decimals > 255) {
            throw new IllegalArgumentException("decimals must be between 0 and 255");
        }
        // SPL 单笔数量是 u64，合法值可以超过 Java 有符号 long 的正数上限。
        // A single SPL quantity is a u64 and may exceed the positive range of a signed Java long.
        UnsignedIntegerUtil.requireUint64(amountRaw);
    }

    /**
     * 检查 Base58 文本是否恰好编码 32 个字节。 / Checks that the Base58 text encodes exactly 32 bytes.
     *
     * @param mint 待验证的非空地址。 / Non-null address to validate.
     * @throws IllegalArgumentException 文本不能解码为 Solana 公钥。 / The text cannot decode to a Solana public key.
     */
    private static void validateMint(String mint) {
        // 限制输入长度后再解码。32 字节公钥的 Base58 文本长度为 32 到 44。
        // Bound the input before decoding. A 32-byte public key takes 32 to 44 Base58 characters.
        if (mint.length() < 32 || mint.length() > 44) {
            throw new IllegalArgumentException("mint must encode a 32-byte public key");
        }

        // 每个前导 '1' 编码一个零字节，整数解码会丢失这些字节。
        // Each leading '1' encodes a zero byte that integer decoding would drop.
        int leadingZeroBytes = 0;
        while (leadingZeroBytes < mint.length() && mint.charAt(leadingZeroBytes) == '1') {
            leadingZeroBytes++;
        }

        // 累计非前导部分的无符号值。 / Accumulate the unsigned value after the leading zero bytes.
        BigInteger value = BigInteger.ZERO;
        // index 是当前 Base58 字符在 Mint 中的位置。 / Index is the position of the current Base58 character.
        for (int index = leadingZeroBytes; index < mint.length(); index++) {
            // digit 是此字符对应的数值。 / Digit is the numeric value of this character.
            int digit = BASE58.indexOf(mint.charAt(index));
            if (digit < 0) {
                throw new IllegalArgumentException("mint contains an invalid Base58 character");
            }
            value = value.multiply(RADIX).add(BigInteger.valueOf(digit));
        }

        // 使用无符号字节数，避免最高位被误算为符号位。
        // Count unsigned bytes so that a set high bit does not add a sign byte.
        int decodedBytes = leadingZeroBytes + Math.ceilDiv(value.bitLength(), Byte.SIZE);
        if (decodedBytes != 32) {
            throw new IllegalArgumentException("mint must encode a 32-byte public key");
        }
    }
}

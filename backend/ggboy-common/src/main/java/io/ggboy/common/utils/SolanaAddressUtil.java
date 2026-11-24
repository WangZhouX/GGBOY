package io.ggboy.common.utils;

import java.math.BigInteger;
import java.util.Objects;

/** 转换 Solana 公钥，并校验公钥和交易签名的文本编码。 / Encodes Solana public keys and validates public keys and transaction signatures. */
public final class SolanaAddressUtil {

    /** Solana 公钥和签名使用的 Base58 字母表。 / Base58 alphabet for Solana public keys and signatures. */
    private static final String BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    /** 编解码使用的进位基数。 / Numeric radix used for encoding and decoding. */
    private static final BigInteger RADIX = BigInteger.valueOf(BASE58.length());

    /**
     * 防止实例化仅包含静态方法的工具类。 / Prevents instantiation of the static utility.
     */
    private SolanaAddressUtil() {
    }

    /**
     * 将 32 字节公钥编码为规范的 Solana Base58 文本。
     * Encodes a 32-byte public key as canonical Solana Base58 text.
     *
     * @param publicKey 公钥原始字节，按链上编码顺序。 Raw public key bytes in wire order.
     * @return 保留前导零字节的 Base58 公钥。 Base58 public key preserving leading zero bytes.
     * @throws IllegalArgumentException 输入长度不为 32 字节。 Input is not 32 bytes long.
     */
    public static String encodePublicKey(byte[] publicKey) {
        Objects.requireNonNull(publicKey, "publicKey");
        if (publicKey.length != 32) {
            throw new IllegalArgumentException("publicKey must contain 32 bytes");
        }

        /** 无符号大端数，以及从低位到高位积累的 Base58 字符。 Unsigned big-endian value and Base58 digits accumulated from lowest to highest. */
        BigInteger value = new BigInteger(1, publicKey);
        StringBuilder reversed = new StringBuilder();
        while (value.signum() != 0) {
            /** 商为剩余高位，余数为当前 Base58 数位。 The quotient holds higher digits and the remainder selects the current Base58 digit. */
            BigInteger[] division = value.divideAndRemainder(RADIX);
            reversed.append(BASE58.charAt(division[1].intValueExact()));
            value = division[0];
        }

        // 整数编码会丢掉原公钥的前导零字节，将其逐个恢复为 Base58 的 '1'。
        // Integer encoding drops leading zero bytes. Restore each one as a Base58 '1'.
        for (byte leading : publicKey) {
            if (leading != 0) {
                break;
            }
            reversed.append('1');
        }
        return reversed.reverse().toString();
    }

    /**
     * 要求地址为恰好编码 32 字节的 Base58 文本。 / Requires an address to be Base58 text encoding exactly 32 bytes.
     *
     * @param address 待验证的 Solana 钱包、Mint 或账户地址。 / Solana wallet, mint, or account address to validate.
     * @param fieldName 错误消息使用的字段名。 / Field name used in validation errors.
     * @throws NullPointerException 地址为空。 / The address is null.
     * @throws IllegalArgumentException 字符非法或解码后长度不是 32 字节。 / A character is invalid or the decoded length differs from 32 bytes.
     */
    public static void requirePublicKey(String address, String fieldName) {
        requireBase58(address, fieldName, 32, 44, "32-byte public key");
    }

    /**
     * 要求交易签名为恰好编码 64 字节的 Base58 文本。
     * Requires a transaction signature to be Base58 text encoding exactly 64 bytes.
     *
     * @param signature 待验证的 Solana 交易主签名。 Primary Solana transaction signature to validate.
     * @param fieldName 错误消息使用的字段名。 Field name used in validation errors.
     * @throws NullPointerException 签名为空。 The signature is null.
     * @throws IllegalArgumentException 字符非法或解码后长度不是 64 字节。 A character is invalid or the decoded length differs from 64 bytes.
     */
    public static void requireSignature(String signature, String fieldName) {
        requireBase58(signature, fieldName, 64, 88, "64-byte transaction signature");
    }

    /**
     * 在解码前限制文本长度，再检查合法字符和包括前导零的字节数。
     * Bounds text length before decoding, then checks the alphabet and byte count including leading zeros.
     *
     * @param encoded 待校验的 Base58 文本。 Base58 text to validate.
     * @param fieldName 供错误消息使用的参数名。 Parameter name used in validation errors.
     * @param byteLength 所需的确切字节数，也是允许的最短文本长度。 Required byte count, also the shortest allowed text length.
     * @param maxEncodedLength 该字节数可产生的最大 Base58 文本长度。 Largest Base58 text length possible for the byte count.
     * @param description 长度错误消息使用的值类型描述。 Value type description used in length errors.
     */
    private static void requireBase58(
            String encoded, String fieldName, int byteLength, int maxEncodedLength, String description
    ) {
        Objects.requireNonNull(encoded, fieldName);

        // 先限制输入长度，避免对超长文本做整数运算。
        // Bound the input length before performing integer arithmetic.
        if (encoded.length() < byteLength || encoded.length() > maxEncodedLength) {
            throw new IllegalArgumentException(fieldName + " must encode a " + description);
        }

        // 每个前导 '1' 编码一个零字节，整数解码会丢失这些字节。
        // Each leading '1' encodes a zero byte that integer decoding would drop.
        int leadingZeroBytes = 0;
        while (leadingZeroBytes < encoded.length() && encoded.charAt(leadingZeroBytes) == '1') {
            leadingZeroBytes++;
        }

        // 累计非前导部分的无符号值。 / Accumulate the unsigned value after the leading zero bytes.
        BigInteger value = BigInteger.ZERO;
        // index 是当前 Base58 字符在文本中的位置。 / Index is the position of the current Base58 character.
        for (int index = leadingZeroBytes; index < encoded.length(); index++) {
            // digit 是此字符对应的数值。 / Digit is the numeric value of this character.
            int digit = BASE58.indexOf(encoded.charAt(index));
            if (digit < 0) {
                throw new IllegalArgumentException(fieldName + " contains an invalid Base58 character");
            }
            value = value.multiply(RADIX).add(BigInteger.valueOf(digit));
        }

        // 使用无符号字节数，避免最高位被误算为符号位。
        // Count unsigned bytes so that a set high bit does not add a sign byte.
        int decodedBytes = leadingZeroBytes + Math.ceilDiv(value.bitLength(), Byte.SIZE);
        if (decodedBytes != byteLength) {
            throw new IllegalArgumentException(fieldName + " must encode a " + description);
        }
    }
}

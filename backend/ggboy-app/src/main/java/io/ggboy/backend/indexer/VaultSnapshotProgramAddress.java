package io.ggboy.backend.indexer;

import io.ggboy.common.utils.SolanaAddressUtil;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * 从公开种子派生 Solana 规范 PDA，用于查询金库估值账户。
 * Derives canonical Solana PDAs from public seeds to locate vault valuation accounts.
 */
final class VaultSnapshotProgramAddress {

    /** Solana Base58 数位表和进制。 Solana Base58 alphabet and radix. */
    private static final String BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static final BigInteger BASE58_RADIX = BigInteger.valueOf(58);
    /** PDA 哈希末尾的固定域分隔符。 Fixed domain separator at the end of a PDA hash. */
    private static final byte[] PDA_MARKER = "ProgramDerivedAddress".getBytes(StandardCharsets.US_ASCII);

    /** Edwards25519 底域模数、Legendre 指数和曲线参数。 Edwards25519 field modulus, Legendre exponent and curve parameter. */
    private static final BigInteger FIELD = BigInteger.TWO.pow(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger LEGENDRE_EXPONENT = FIELD.subtract(BigInteger.ONE).shiftRight(1);
    private static final BigInteger CURVE_D = BigInteger.valueOf(-121665)
            .multiply(BigInteger.valueOf(121666).modInverse(FIELD)).mod(FIELD);

    /** 只提供静态派生方法。 Exposes only static derivation. */
    private VaultSnapshotProgramAddress() {
    }

    /**
     * 从 UTF-8 种子前缀和一个或多个规范的公钥查找第一个离曲线 PDA。
     * Finds the first off-curve PDA from a UTF-8 seed prefix and its accompanying canonical public keys.
     *
     * @param program 拥有该 PDA 派生命名空间的程序公钥。 Program owning the PDA derivation namespace.
     * @param seed 固定种子前缀。 Fixed seed prefix.
     * @param keys 作为独立字节种子使用的公钥，按链上账户约束顺序。 Public keys used as separate seeds in on-chain constraint order.
     * @return PDA 地址和规范 bump，bump 在 0 到 255 范围。 PDA address and canonical bump in the 0–255 range.
     */
    static Address derive(String program, String seed, String... keys) {
        /** SHA-256 按地址协议拼接输入。 SHA-256 concatenates the address protocol inputs. */
        MessageDigest digest = sha256();
        /** 预先解码公钥，跨 bump 候选复用。 Decode public keys once across all bump candidates. */
        byte[] programBytes = decode(program);
        byte[] prefix = seed.getBytes(StandardCharsets.UTF_8);
        byte[][] seeds = new byte[keys.length][];
        if (prefix.length > 32 || keys.length > 14) {
            throw new IllegalArgumentException("Invalid Solana PDA seed size or count");
        }
        for (int index = 0; index < keys.length; index++) {
            seeds[index] = decode(keys[index]);
        }

        // 从 255 向下寻找与链上一致的规范 bump，跳过可以解压成曲线点的候选。
        // Search downward from 255 for the canonical bump and skip candidates that decompress to a curve point.
        for (int bump = 255; bump > 0; bump--) {
            digest.update(prefix);
            for (byte[] key : seeds) {
                digest.update(key);
            }
            digest.update((byte) bump);
            digest.update(programBytes);
            byte[] candidate = digest.digest(PDA_MARKER);
            if (!isOnCurve(candidate)) {
                return new Address(SolanaAddressUtil.encodePublicKey(candidate), bump);
            }
        }
        throw new IllegalStateException("No canonical Solana PDA bump");
    }

    /**
     * 检查压缩 Edwards25519 编码是否能解压，判断地址是否位于曲线上。
     * Checks whether the compressed Edwards25519 encoding decompresses to a curve point.
     *
     * @param compressed 32 字节的 SHA-256 地址候选。 32-byte SHA-256 address candidate.
     * @return 存在曲线点时为 true。 True if a curve point exists.
     */
    private static boolean isOnCurve(byte[] compressed) {
        /** 提取低 255 位的小端 y 坐标，转换为 BigInteger 的无符号大端字节。 Converts the little-endian 255-bit y-coordinate to unsigned BigInteger bytes. */
        byte[] yBytes = new byte[compressed.length];
        for (int index = 0; index < compressed.length; index++) {
            yBytes[index] = compressed[compressed.length - 1 - index];
        }
        yBytes[0] &= 0x7f;
        BigInteger y = new BigInteger(1, yBytes);
        BigInteger ySquared = y.multiply(y).mod(FIELD);
        /** Edwards 方程分解为 x²=(y²−1)/(dy²+1)。 The Edwards equation gives x²=(y²−1)/(dy²+1). */
        BigInteger numerator = ySquared.subtract(BigInteger.ONE).mod(FIELD);
        BigInteger denominator = CURVE_D.multiply(ySquared).add(BigInteger.ONE).mod(FIELD);
        if (denominator.signum() == 0) {
            return false;
        }
        // 非零分母与其逆元具有相同二次特征，可直接用乘积检查是否存在平方根。
        // A nonzero denominator shares the quadratic character of its inverse, so the product tests for a square root.
        return numerator.signum() == 0
                || numerator.multiply(denominator).modPow(LEGENDRE_EXPONENT, FIELD).equals(BigInteger.ONE);
    }

    /**
     * 解码一个 32 字节公钥，并恢复前导零。
     * Decodes one 32-byte public key and restores leading zero bytes.
     *
     * @param address 规范 Base58 公钥。 Canonical Base58 public key.
     * @return 32 字节的链上顺序公钥。 32-byte public key in on-chain wire order.
     */
    private static byte[] decode(String address) {
        SolanaAddressUtil.requirePublicKey(address, "PDA seed");
        /** 文本对应的无符号值。 Unsigned value represented by the address text. */
        BigInteger value = BigInteger.ZERO;
        for (int index = 0; index < address.length(); index++) {
            value = value.multiply(BASE58_RADIX).add(BigInteger.valueOf(BASE58.indexOf(address.charAt(index))));
        }
        /** BigInteger 字节可能含额外符号位，或没有链上要求的前导零。 BigInteger bytes may include a sign prefix or omit required leading zeros. */
        byte[] encoded = value.toByteArray();
        byte[] key = new byte[32];
        int copyLength = Math.min(encoded.length, key.length);
        System.arraycopy(encoded, encoded.length - copyLength, key, key.length - copyLength, copyLength);
        return key;
    }

    /**
     * 获取标准 JDK 的 SHA-256 实现。
     * Obtains the standard JDK SHA-256 implementation.
     *
     * @return 可重复用于派生的消息摘要。 Message digest reusable for derivation.
     */
    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException missingAlgorithm) {
            throw new IllegalStateException("Required SHA-256 provider unavailable", missingAlgorithm);
        }
    }

    /**
     * PDA 派生结果。
     * PDA derivation result.
     *
     * @param publicKey 规范 Base58 账户地址。 Canonical Base58 account address.
     * @param bump 按无符号 u8 表示的规范 bump。 Canonical bump as an unsigned u8.
     */
    record Address(String publicKey, int bump) {
    }
}

package io.ggboy.backend.api;

import io.ggboy.common.api.SolanaNetwork;
import io.ggboy.common.utils.UnsignedIntegerUtil;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * 生成并校验金库历史快照的分页游标。游标只描述公开查询中的范围和下一页边界。
 * Encodes and validates vault history cursors. A cursor carries the scope and boundary of a public query.
 */
public final class VaultHistoryCursor {

    /** 金库历史游标的类型和首版格式标识。 Type marker and version for the first vault history cursor format. */
    private static final String TYPE_VERSION = "vh1:";

    /** 最多 78 个 ASCII 字节经 Base64 URL 编码后为 104 个字符。 An encoded cursor of up to 78 ASCII bytes has at most 104 characters. */
    private static final int MAX_ENCODED_LENGTH = 104;

    /** URL 安全且省略填充的编码器。 URL-safe encoder without padding. */
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();

    /** 仅接受 URL 安全字符表的解码器。 Decoder for the URL-safe alphabet. */
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();

    /** 游标编解码通过静态方法完成。 Cursor encoding and decoding use static methods. */
    private VaultHistoryCursor() {
    }

    /**
     * 将本页最后一条快照的 slot 绑定到当前查询网络和金库。
     * Binds the slot of the last item on the current page to the queried network and vault.
     *
     * @param network 当前查询的已校验网络。 Validated network for the current query.
     * @param vaultAddress 当前查询的已校验金库公钥。 Validated vault public key for the current query.
     * @param slot 最后一条已返回快照的无符号 64 位 slot。 Unsigned 64-bit slot of the last returned snapshot.
     * @return 可直接作为下一页请求参数的游标。 Cursor ready to pass as the next page's query parameter.
     * @throws IllegalArgumentException slot 超出无符号 64 位整数范围。 The slot exceeds the unsigned 64-bit range.
     */
    public static String encode(SolanaNetwork network, String vaultAddress, BigInteger slot) {
        // 保留精确的十进制 slot，覆盖超过 Java 有符号 long 上限的链上值。
        // Preserve the exact decimal slot, including on-chain values beyond Java signed long.
        String payload = scopePrefix(network, vaultAddress) + UnsignedIntegerUtil.formatUint64(slot);
        return ENCODER.encodeToString(payload.getBytes(StandardCharsets.US_ASCII));
    }

    /**
     * 解码并验证游标，返回下一页的排他 slot 上界。
     * Decodes and validates a cursor to return the exclusive upper slot bound for the next page.
     *
     * @param cursor 客户端传入的上一页游标，首屏未传时为空引用。 Cursor from the previous page, or null when omitted on the first page.
     * @param network 当前请求的已校验网络。 Validated network for the current request.
     * @param vaultAddress 当前请求的已校验金库公钥。 Validated vault public key for the current request.
     * @return 用于查询更早 slot 的排他上界，未传游标时为空引用。 Exclusive bound for older slots, or null when omitted.
     * @throws IllegalArgumentException 游标格式、范围或查询对象不匹配。 Cursor format, slot range, or query scope is invalid.
     */
    public static BigInteger decode(String cursor, SolanaNetwork network, String vaultAddress) {
        if (cursor == null) {
            return null;
        }
        // 限制原始字符串长度再解码，防止超长输入分配缓冲区。
        // Limit encoded length before decoding to bound allocation for invalid inputs.
        if (cursor.isEmpty() || cursor.length() > MAX_ENCODED_LENGTH) {
            throw new IllegalArgumentException("Invalid vault history cursor length");
        }

        // 规范化校验拒绝带填充或使用同字节非标准尾位的 Base64 文本。
        // Require canonical Base64 to reject padding and alternate encodings of the final bits.
        byte[] payload = DECODER.decode(cursor);
        if (!ENCODER.encodeToString(payload).equals(cursor)) {
            throw new IllegalArgumentException("Invalid vault history cursor encoding");
        }

        // 精确匹配类型、网络和地址，防止直接把其他查询的游标用于当前金库。
        // Match type, network, and address exactly so a cursor from another query cannot be reused directly.
        String expectedPrefix = scopePrefix(network, vaultAddress);
        String decoded = new String(payload, StandardCharsets.US_ASCII);
        if (!decoded.startsWith(expectedPrefix)) {
            throw new IllegalArgumentException("Vault history cursor does not match the query");
        }
        return UnsignedIntegerUtil.parseUint64(decoded.substring(expectedPrefix.length()));
    }

    /**
     * 构造标明版本、网络和金库的精确前缀，以分隔符结束。
     * Constructs the exact version, network, and vault prefix with a trailing separator.
     *
     * @param network 已校验的网络。 Validated network.
     * @param vaultAddress 已校验的金库公钥。 Validated vault public key.
     * @return 可与 slot 连接或对比的游标前缀。 Cursor prefix to append to or match against the slot payload.
     */
    private static String scopePrefix(SolanaNetwork network, String vaultAddress) {
        return TYPE_VERSION + network.wireValue() + ":" + vaultAddress + ":";
    }
}

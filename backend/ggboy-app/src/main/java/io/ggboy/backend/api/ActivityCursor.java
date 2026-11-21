package io.ggboy.backend.api;

import io.ggboy.common.utils.SolanaAddressUtil;
import io.ggboy.common.utils.UnsignedIntegerUtil;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * 事件列表的排他边界。编码游标携带完整排序键并绑定到原查询的筛选条件。
 * Exclusive activity page boundary. Encoded cursors carry the entire sort key and bind it to the original filters.
 *
 * @param slot 交易所在的无符号 64 位链上 slot。 Unsigned 64-bit on-chain slot containing the transaction.
 * @param signature 同 slot 下确定顺序的交易主签名。 Primary transaction signature ordering events within the same slot.
 * @param eventIndex 同交易内确定顺序的零基事件索引。 Zero-based event index ordering events within one transaction.
 */
public record ActivityCursor(BigInteger slot, String signature, int eventIndex) {

    /** 交易活动游标标识和编码版本。 Type marker and version for the activity cursor format. */
    private static final String TYPE_VERSION = "ac1:";

    /** 189 个 ASCII 字节的最长合法载荷需要 252 个 Base64 URL 字符。 A maximum 189-byte ASCII payload takes 252 Base64 URL characters. */
    private static final int MAX_ENCODED_LENGTH = 252;

    /** Java int 范围内事件索引的十进制文法，禁止前导零和符号。 Decimal syntax for an int event index, without leading zeros or signs. */
    private static final Pattern EVENT_INDEX_TEXT = Pattern.compile("0|[1-9][0-9]{0,9}");

    /** URL 安全、无填充的规范编码器。 Canonical URL-safe encoder without padding. */
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();

    /** URL 安全字母表的解码器。 Decoder for the URL-safe alphabet. */
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();

    /**
     * 确保来自数据库或已解码游标的排序键都可用于查询。
     * Verifies that a sort key from the database or a decoded cursor can be used for querying.
     *
     * @param slot 非负无符号 64 位 slot。 Nonnegative unsigned 64-bit slot.
     * @param signature 64 字节签名的 Base58 文本。 Base58 text of a 64-byte signature.
     * @param eventIndex 交易事件的非负索引。 Nonnegative index of the transaction event.
     * @throws IllegalArgumentException 排序键不符合值域或签名格式。 A sort key value or signature format is invalid.
     */
    public ActivityCursor {
        UnsignedIntegerUtil.requireUint64(slot);
        SolanaAddressUtil.requireSignature(signature, "signature");
        if (eventIndex < 0) {
            throw new IllegalArgumentException("eventIndex must be nonnegative");
        }
    }

    /**
     * 编码当前页最后一条已返回事件的排序键作为后续查询游标。
     * Encodes the sort key of the last returned event as the next page cursor.
     *
     * @param query 本页的已校验查询。 Validated query for the current page.
     * @param cursor 本页最后一条已返回事件的排序键。 Sort key of the last returned event.
     * @return 可直接作为后续请求参数的 URL 安全游标。 URL-safe cursor ready to use in the next request.
     */
    public static String encode(ActivityQuery query, ActivityCursor cursor) {
        // 用 ASCII 十进制保留链上 slot 的精度，事件索引也采用稳定的十进制形式。
        // Preserve full slot precision using ASCII decimal text and use a stable decimal event index.
        String payload = scopePrefix(query) + cursor.slot() + ":" + cursor.signature() + ":" + cursor.eventIndex();
        return ENCODER.encodeToString(payload.getBytes(StandardCharsets.US_ASCII));
    }

    /**
     * 按请求的网络及筛选条件验证游标，返回下一页的排他边界。
     * Validates a cursor against the request network and filters and returns its exclusive page boundary.
     *
     * @param query 当前已校验的查询。 Current validated query.
     * @param token 上一页返回的游标，首屏省略时为空引用。 Previous page cursor, or null when omitted on the first page.
     * @return 已校验的排序键，首屏没有边界时返回空引用。 Validated sort key, or null for an unbounded first page.
     * @throws IllegalArgumentException 游标格式、排序值或绑定的筛选范围无效。 The cursor format, key, or bound query scope is invalid.
     */
    public static ActivityCursor decode(ActivityQuery query, String token) {
        if (token == null) {
            return null;
        }
        // 限制原始文本长度，再检查编码是否为唯一的无填充形式。
        // Bound the raw token length and require the unique unpadded encoding.
        if (token.isEmpty() || token.length() > MAX_ENCODED_LENGTH) {
            throw new IllegalArgumentException("Invalid activity cursor length");
        }
        byte[] payload = DECODER.decode(token);
        if (!ENCODER.encodeToString(payload).equals(token)) {
            throw new IllegalArgumentException("Invalid activity cursor encoding");
        }

        // 先核对查询范围，避免跨网络或变更筛选后沿用旧游标。
        // Check the query scope before parsing to reject reuse across networks or changed filters.
        String prefix = scopePrefix(query);
        String decoded = new String(payload, StandardCharsets.US_ASCII);
        if (!decoded.startsWith(prefix)) {
            throw new IllegalArgumentException("Activity cursor does not match the query");
        }

        // 边界的三项值必须完整。负数、非规范十进制和溢出的索引无效。
        // The boundary must contain three values. Negative, noncanonical, and overflowing indices are invalid.
        String[] key = decoded.substring(prefix.length()).split(":", -1);
        if (key.length != 3 || !EVENT_INDEX_TEXT.matcher(key[2]).matches()) {
            throw new IllegalArgumentException("Invalid activity cursor key");
        }
        return new ActivityCursor(UnsignedIntegerUtil.parseUint64(key[0]), key[1], Integer.parseInt(key[2]));
    }

    /**
     * 对固定顺序的匹配条件生成摘要，保持游标长度固定。
     * Hashes the matching filters in a fixed order to keep the scope section a fixed size.
     *
     * @param query 已校验且具有规范类型顺序的查询。 Validated query with normalized type order.
     * @return 带版本和筛选摘要的游标前缀，以分隔符结束。 Cursor prefix containing the version and scope digest, with a trailing separator.
     */
    private static String scopePrefix(ActivityQuery query) {
        // 地址、签名和类型均不含分隔符。页长不改变匹配集合，因此继续翻页可使用不同页长。
        // Addresses, signatures, and types contain no delimiters. Page size does not change matches, so it can change on continuation.
        String scope = String.join(":", query.network().wireValue(), Objects.toString(query.wallet(), ""),
                Objects.toString(query.subjectAddress(), ""), Objects.toString(query.signature(), ""),
                String.join(",", query.types()));
        try {
            // 每次调用独立创建摘要对象，避免在并发请求之间共享状态。
            // Create a fresh digest per call to avoid sharing state across concurrent requests.
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(scope.getBytes(StandardCharsets.US_ASCII));
            return TYPE_VERSION + HexFormat.of().formatHex(digest) + ":";
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is required by the Java runtime", error);
        }
    }
}

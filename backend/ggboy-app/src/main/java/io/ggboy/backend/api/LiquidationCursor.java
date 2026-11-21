package io.ggboy.backend.api;

import io.ggboy.common.api.SolanaNetwork;
import io.ggboy.common.utils.SolanaAddressUtil;
import io.ggboy.common.utils.UnsignedIntegerUtil;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * 保存清算市场分页所用的市场与价格观测版本，以及上一页末尾的风险排序键。
 * Carries the market and price observation versions and the final risk ordering key of a liquidation page.
 *
 * @param marketSlot 生成上一页时使用的市场快照 slot。 Market snapshot slot used for the previous page.
 * @param oraclePriceVersion 生成上一页时所用预言机报价的 SHA-256 十六进制摘要。 Hexadecimal SHA-256 digest of the oracle quote used for the previous page.
 * @param healthFactor 上一页末尾仓位的精确健康度。 Exact health factor of the last position on the previous page.
 * @param walletAddress 上一页末尾仓位的钱包公钥，用于区分健康度相同的仓位。 Wallet public key of the last position, used to distinguish equal health factors.
 */
public record LiquidationCursor(BigInteger marketSlot, String oraclePriceVersion, BigDecimal healthFactor, String walletAddress) {

    /** 清算游标的类型与首版格式。 Type marker and first format version for liquidation cursors. */
    private static final String TYPE_VERSION = "lc1:";

    /** 241 个 ASCII 字节经无填充 Base64 编码后最多为 322 字符。 An unpadded Base64 encoding of 241 ASCII bytes has at most 322 characters. */
    private static final int MAX_ENCODED_LENGTH = 322;

    /** PostgreSQL 健康度列允许的最大整数位数。 Maximum integer digits in the PostgreSQL health factor column. */
    private static final int MAX_HEALTH_INTEGER_DIGITS = 39;

    /** PostgreSQL 健康度列允许的最大小数位数。 Maximum fractional digits in the PostgreSQL health factor column. */
    private static final int MAX_HEALTH_SCALE = 12;

    /** 价格观测摘要的固定小写十六进制格式。 Fixed lowercase hexadecimal format of a price observation digest. */
    private static final Pattern PRICE_VERSION = Pattern.compile("[0-9a-f]{64}");

    /** 健康度的标准十进制格式，禁止前导零和冗余小数尾零。 Canonical decimal format for health factors, without leading zeros or redundant fractional zeros. */
    private static final Pattern HEALTH_TEXT = Pattern.compile("(?:0|[1-9][0-9]{0,38})(?:\\.[0-9]{0,11}[1-9])?");

    /** URL 安全且省略填充的编码器。 URL-safe encoder without padding. */
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();

    /** URL 安全字符表的解码器。 Decoder for the URL-safe alphabet. */
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();

    /**
     * 校验观测版本和排序键，并规范化健康度以保留精确数值。
     * Validates observation versions and the sort key and normalizes the health factor without losing precision.
     *
     * @param marketSlot 市场快照的无符号 64 位 slot。 Unsigned 64-bit slot of the market snapshot.
     * @param oraclePriceVersion 预言机报价摘要。 Oracle quote digest.
     * @param healthFactor 排序使用的非负健康度。 Nonnegative health factor used for sorting.
     * @param walletAddress 排序使用的 Solana 钱包公钥。 Solana wallet public key used for sorting.
     * @throws IllegalArgumentException slot、报价版本、健康度或钱包地址不满足格式与范围要求。 A slot, quote version, health factor, or wallet address fails its format or range requirement.
     */
    public LiquidationCursor {
        UnsignedIntegerUtil.requireUint64(marketSlot);
        if (!PRICE_VERSION.matcher(Objects.requireNonNull(oraclePriceVersion, "oraclePriceVersion")).matches()) {
            throw new IllegalArgumentException("Invalid liquidation oracle price version");
        }
        SolanaAddressUtil.requirePublicKey(walletAddress, "walletAddress");
        healthFactor = normalizeHealthFactor(healthFactor);
    }

    /**
     * 为前端清算市场的下一页请求生成包含查询范围的游标。
     * Generates a query-scoped cursor for the liquidation market's next-page request.
     *
     * @param network 当前 Solana 网络。 Current Solana network.
     * @param marketAddress 当前借贷市场公钥。 Public key of the current lending market.
     * @param cursor 市场与价格观测版本以及本页末尾的排序键。 Market and price observation versions and the final sort key of this page.
     * @return 可直接作为 cursor 查询参数的文本。 Text ready to pass as the cursor query parameter.
     */
    public static String encode(SolanaNetwork network, String marketAddress, LiquidationCursor cursor) {
        // 将版本和所有排序字段编码为精确 ASCII 文本，保持数据库十进制精度。
        // Encode the observation versions and sort fields as exact ASCII text to preserve database decimal precision.
        String payload = scopePrefix(network, marketAddress) + UnsignedIntegerUtil.formatUint64(cursor.marketSlot())
                + ":" + cursor.oraclePriceVersion() + ":" + cursor.healthFactor().toPlainString() + ":" + cursor.walletAddress();
        return ENCODER.encodeToString(payload.getBytes(StandardCharsets.US_ASCII));
    }

    /**
     * 解码清算市场查询的页边界，并精确校验网络和市场地址。
     * Decodes a liquidation market page boundary and checks the exact network and market address.
     *
     * @param token 前端翻页时传入的游标，首屏未传时为空。 Cursor supplied for pagination, or null when omitted on the first page.
     * @param network 当前请求网络。 Network of the current request.
     * @param marketAddress 当前请求的借贷市场公钥。 Lending market public key of the current request.
     * @return 已校验的页边界，未传游标时为空。 Validated page boundary, or null when the cursor was omitted.
     * @throws IllegalArgumentException 游标编码、字段或查询范围不匹配。 The cursor encoding, fields, or query scope is invalid.
     */
    public static LiquidationCursor decode(String token, SolanaNetwork network, String marketAddress) {
        if (token == null) {
            return null;
        }
        // 解码前限制输入长度，避免为异常游标分配超出格式上限的缓冲区。
        // Bound input length before decoding to limit buffer allocation for malformed cursors.
        if (token.isEmpty() || token.length() > MAX_ENCODED_LENGTH) {
            throw new IllegalArgumentException("Invalid liquidation cursor length");
        }

        // 将字节重新编码后逐字符比对，拒绝带填充或非标准尾位的 Base64。
        // Re-encode the bytes and compare the text to reject Base64 padding and alternate final bits.
        byte[] payload = DECODER.decode(token);
        if (!ENCODER.encodeToString(payload).equals(token)) {
            throw new IllegalArgumentException("Invalid liquidation cursor encoding");
        }

        // 核对格式、网络和市场后，仅解析剩余字段。
        // Parse the remaining fields only after checking the format, network, and market.
        String expectedPrefix = scopePrefix(network, marketAddress);
        // decoded 是包含查询范围和分页排序键的 ASCII 载荷。 Decoded is the ASCII payload containing the scope and page sort key.
        String decoded = new String(payload, StandardCharsets.US_ASCII);
        if (!decoded.startsWith(expectedPrefix)) {
            throw new IllegalArgumentException("Liquidation cursor does not match the query");
        }

        // 保留空字段以拒绝空钱包地址和多余分隔符，并在构造十进制对象前验证数字文本。
        // Keep empty fields to reject empty wallet addresses and extra separators, and validate decimal text before parsing.
        String[] fields = decoded.substring(expectedPrefix.length()).split(":", -1);
        if (fields.length != 4 || !HEALTH_TEXT.matcher(fields[2]).matches()) {
            throw new IllegalArgumentException("Invalid liquidation cursor fields");
        }
        return new LiquidationCursor(UnsignedIntegerUtil.parseUint64(fields[0]), fields[1], new BigDecimal(fields[2]), fields[3]);
    }

    /**
     * 校验当前可用观测是否与上一页一致，以便前端在数据版本变化时回到首屏。
     * Checks whether the current ready observation matches the previous page, so the frontend can reload page one after a change.
     * 调用方应在确认当前快照与报价可用后调用。 Call only after confirming the current snapshot and quote are ready.
     *
     * @param marketSlot 当前可用市场快照 slot。 Slot of the current ready market snapshot.
     * @param oraclePriceVersion 当前可用预言机报价的摘要。 Digest of the current ready oracle quote.
     * @throws ObservationChangedException 市场快照或预言机报价已变化。 The market snapshot or oracle quote has changed.
     */
    public void requireObservation(BigInteger marketSlot, String oraclePriceVersion) {
        // 比对两个独立的版本，检测市场快照和报价任意一方的变化。
        // Check both versions independently so a change in either the market snapshot or quote is detected.
        if (!this.marketSlot.equals(marketSlot) || !this.oraclePriceVersion.equals(oraclePriceVersion)) {
            throw new ObservationChangedException();
        }
    }

    /**
     * 校验健康度的数据库精度范围，并将相同数值归一为相同的十进制形式。
     * Checks the database precision bounds and normalizes equal health factors to the same decimal form.
     *
     * @param healthFactor 作为页边界的完整精度健康度。 Full-precision health factor used as the page boundary.
     * @return 在 numeric(51,12) 内的标准非负值。 Canonical nonnegative value within numeric(51,12).
     * @throws IllegalArgumentException 健康度为负数，或超出允许的整数位数或小数位数。 Health factor is negative or exceeds the permitted integer or fractional digits.
     */
    private static BigDecimal normalizeHealthFactor(BigDecimal healthFactor) {
        Objects.requireNonNull(healthFactor, "healthFactor");
        if (healthFactor.signum() == 0) {
            return BigDecimal.ZERO;
        }

        // 以 long 计算整数位数，先排除过大的负 scale，避免转换为普通十进制时产生超长字符串。
        // Count integer digits as a long and reject extreme negative scales before expanding to plain decimal.
        if (healthFactor.signum() < 0 || (long) healthFactor.precision() - healthFactor.scale() > MAX_HEALTH_INTEGER_DIGITS) {
            throw new IllegalArgumentException("Invalid liquidation health factor range");
        }

        // 先去掉表示上的小数尾零，再校验实际需要的小数位数。
        // Strip representational trailing zeros before checking how many fractional digits the value needs.
        BigDecimal normalized = healthFactor.stripTrailingZeros();
        if (normalized.scale() > MAX_HEALTH_SCALE) {
            throw new IllegalArgumentException("Invalid liquidation health factor scale");
        }
        // 整数保持零 scale，确保数字相等的整数也具有相同的记录表示。
        // Represent integers with zero scale so numerically equal integers also share one record representation.
        return normalized.scale() < 0 ? normalized.setScale(0) : normalized;
    }

    /**
     * 构造包含格式版本、网络和借贷市场公钥的前缀。
     * Builds the prefix carrying the format version, network, and lending market public key.
     *
     * @param network 当前 Solana 网络。 Current Solana network.
     * @param marketAddress 当前借贷市场公钥。 Public key of the current lending market.
     * @return 以字段分隔符结尾的查询范围前缀。 Query scope prefix ending with a field separator.
     */
    private static String scopePrefix(SolanaNetwork network, String marketAddress) {
        SolanaAddressUtil.requirePublicKey(marketAddress, "marketAddress");
        return TYPE_VERSION + network.wireValue() + ":" + marketAddress + ":";
    }

    /**
     * 有效游标所属的市场与报价观测已变化，分页查询需要从首屏重新发起。
     * The market or quote observation bound to a valid cursor has changed, requiring a restart from the first page.
     */
    public static final class ObservationChangedException extends IllegalArgumentException {

        /** 观测版本变化异常的序列化版本。 Serialization version of the changed observation exception. */
        private static final long serialVersionUID = 1L;

        /** 构造通知调用方重新加载首屏的异常。 Builds an exception indicating that the caller should reload page one. */
        private ObservationChangedException() {
            super("Liquidation observation changed. Reload the first page.");
        }
    }
}

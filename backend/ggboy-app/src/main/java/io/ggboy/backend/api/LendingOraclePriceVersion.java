package io.ggboy.backend.api;

import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;

/**
 * 为同一市场风险评估使用的精确价格生成可重现的版本标识。
 * Computes a reproducible version for the exact price used in one market risk evaluation.
 */
public final class LendingOraclePriceVersion {

    /** 标识价格元组的编码版本。 Identifies the encoding version of the price tuple. */
    private static final String FORMAT_VERSION = "liq-oracle-v1";

    /** 版本计算通过静态方法完成。 Price versions are computed through static methods. */
    private LendingOraclePriceVersion() {
    }

    /**
     * 校验已具备价格字段的市场快照是否携带相同价格元组的版本。
     * Checks whether a populated market snapshot carries the version of its exact price tuple.
     *
     * @param snapshot 已通过价格字段完整性校验的市场快照。 Market snapshot whose required price fields were already checked.
     * @return 版本与当前价格元组完全匹配时为 true。 True if the version matches the exact price tuple.
     */
    public static boolean matches(LendingMarketSnapshotDO snapshot) {
        return compute(
                snapshot.oracleAddress(), snapshot.oracleCollateralMint(), snapshot.oracleDebtMint(),
                snapshot.oraclePriceNumerator(), snapshot.oraclePriceDenominator(),
                snapshot.oracleSlot(), snapshot.oraclePublishedAt()
        ).equals(snapshot.oraclePriceVersion());
    }

    /**
     * 对预言机身份、Mint、精确价格及发布时间生成 SHA-256 小写十六进制版本。
     * Computes the lowercase SHA-256 hex version of the oracle identity, mints, exact price and publication point.
     *
     * @param oracleAddress 经校验的预言机账户公钥。 Validated oracle account public key.
     * @param collateralMint 经校验的抵押资产 Mint 公钥。 Validated collateral mint public key.
     * @param debtMint 经校验的借款资产 Mint 公钥。 Validated debt mint public key.
     * @param numerator 正整数价格分子，价格单位为每整单位抵押资产对应的借款资产。 Positive price numerator in debt tokens per whole collateral token.
     * @param denominator 正整数价格分母。 Positive price denominator.
     * @param publishSlot 价格发布的无符号 slot。 Unsigned slot of price publication.
     * @param publishedAt 价格发布时间，索引时按 PostgreSQL 的微秒精度保存。 Publication time stored by the indexer at PostgreSQL microsecond precision.
     * @return 供市场和本次仓位观测共同保存的价格版本。 Price version stored by both market and position observations.
     */
    public static String compute(
            String oracleAddress,
            String collateralMint,
            String debtMint,
            BigInteger numerator,
            BigInteger denominator,
            BigInteger publishSlot,
            OffsetDateTime publishedAt
    ) {
        // 使用与 PostgreSQL 时间戳精度一致的微秒级 UTC 时间。
        // Use a UTC time at PostgreSQL's microsecond timestamp precision.
        String utcPublishedAt = publishedAt.toInstant().truncatedTo(ChronoUnit.MICROS).toString();
        // 摘要输入固定字段顺序，确保市场和仓位使用的价格可以核对。
        // Keep hash input fields in a fixed order so market and position quotes can be compared.
        String input = String.join("|", FORMAT_VERSION, oracleAddress, collateralMint, debtMint,
                numerator.toString(), denominator.toString(), publishSlot.toString(), utcPublishedAt);
        try {
            // 每次计算使用独立的摘要实例，避免并发请求共享状态。
            // Use a separate digest per call so concurrent requests share no mutable digest state.
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.US_ASCII));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is required by the Java runtime", error);
        }
    }
}

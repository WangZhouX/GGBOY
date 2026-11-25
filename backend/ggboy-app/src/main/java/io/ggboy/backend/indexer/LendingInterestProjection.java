package io.ggboy.backend.indexer;

import java.math.BigInteger;
import java.nio.ByteBuffer;

/**
 * 在最终确认 Clock 槽按借贷程序的定点精度计算启用计息后的借款与池价值。
 * Projects interest-bearing debt and lending pool value at the finalized Clock slot using the program's fixed-point precision.
 */
final class LendingInterestProjection {

    /** 旧版及启用计息的池和借款账户尺寸，包含 Anchor 判别符。 Legacy and interest-enabled pool and loan sizes, including Anchor discriminators. */
    static final int LEGACY_POOL_BYTES = 56;
    static final int ACTIVE_POOL_BYTES = 88;
    static final int LEGACY_POSITION_BYTES = 88;
    static final int ACTIVE_POSITION_BYTES = 112;
    /** 每分钟定点倍率和债务换算分母。 Fixed-point per-minute factor and debt conversion denominator. */
    private static final BigInteger INDEX_SCALE = BigInteger.TEN.pow(12);
    private static final BigInteger RATE_FACTOR = INDEX_SCALE.add(BigInteger.valueOf(190_258));
    private static final BigInteger DEBT_SCALE = BigInteger.TEN.pow(18);
    /** 协议固定借款年化利率，基点。 Protocol fixed borrow APR in basis points. */
    static final int BORROW_APR_BPS = 1_000;

    /** 仅提供账户读取和无状态估值。 Exposes only account reads and stateless projections. */
    private LendingInterestProjection() {
    }

    /** 启用计息的池账户追加的开始 Unix 秒。 Interest start Unix seconds appended to an active pool account. */
    static long startTime(ByteBuffer activePool) {
        return activePool.getLong(56);
    }

    /** 借款仓位计息起点对应的链上 Unix 秒。 On-chain Unix second anchor for this borrower's normalized debt. */
    static long positionStartTime(ByteBuffer activePosition) {
        return activePosition.getLong(88);
    }

    /** 计息池已入账的现金，排除未记账捐款。 Tracked interest-pool cash excluding unaccounted transfers. */
    static BigInteger trackedCash(ByteBuffer activePool) {
        return VaultSnapshotRpc.unsignedLongAt(activePool, 64);
    }

    /** 读取市场总归一化债务数，采用链上小端 u128。 Reads the market's normalized debt sum as a little-endian u128. */
    static BigInteger normalizedTotal(ByteBuffer activePool) {
        return unsigned128(activePool, 72);
    }

    /** 读取单仓位归一化债务数，采用链上小端 u128。 Reads this loan's normalized debt as a little-endian u128. */
    static BigInteger normalizedPosition(ByteBuffer activePosition) {
        return unsigned128(activePosition, 96);
    }

    /** 从同槽时钟投影池总应还数，单位为借款 Mint 最小单位。 Projects total market debt in debt mint base units from the same-slot clock. */
    static BigInteger marketDebt(ByteBuffer activePool, long observedEpochSeconds) {
        return debt(normalizedTotal(activePool), startTime(activePool), observedEpochSeconds);
    }

    /** 从同槽时钟投影单仓位应还数，单位为借款 Mint 最小单位。 Projects one loan's debt in debt mint base units from the same-slot clock. */
    static BigInteger positionDebt(ByteBuffer activePosition, long observedEpochSeconds) {
        return debt(normalizedPosition(activePosition), positionStartTime(activePosition), observedEpochSeconds);
    }

    /** 计息池资产等于入账现金加投影应还数，使用借款 Mint 最小单位。 Projected pool assets equal tracked cash plus projected debt in debt mint base units. */
    static BigInteger poolAssets(ByteBuffer activePool, long observedEpochSeconds) {
        BigInteger assets = trackedCash(activePool).add(marketDebt(activePool, observedEpochSeconds));
        if (assets.bitLength() > 64) {
            throw new IllegalStateException("Projected lending pool value is outside u64");
        }
        return assets;
    }

    /**
     * 逐次定点下取整进行平方倍增，再将应还数向上取到一个借款最小单位。
     * Exponentiates with rounding down at each fixed-point multiply, then rounds debt up to a debt base unit.
     *
     * @param normalized 归一化债务 u128。 Normalized debt as a u128.
     * @param start 链上计息起点 Unix 秒。 On-chain interest start time in Unix seconds.
     * @param now 同槽 Clock Unix 秒。 Same-slot Clock Unix seconds.
     * @return 投影应还数，单位为借款 Mint 最小单位。 Projected debt in debt mint base units.
     */
    static BigInteger debt(BigInteger normalized, long start, long now) {
        if (normalized.signum() < 0 || normalized.bitLength() > 128 || start <= 0 || now < 0) {
            throw new IllegalStateException("Invalid lending interest clock");
        }
        /** 整分钟数及定点指数，开始前按零分钟计。 Whole elapsed minutes and their fixed-point index, with zero minutes before start. */
        long epochs = Math.max(now - start, 0) / 60;
        BigInteger index = INDEX_SCALE;
        BigInteger factor = RATE_FACTOR;
        while (epochs > 0) {
            if ((epochs & 1) == 1) {
                index = scaleProduct(index, factor);
            }
            epochs >>= 1;
            if (epochs > 0) {
                factor = scaleProduct(factor, factor);
            }
        }
        /** 按协议先拆整份和余数，两项乘积限制在 u128，然后将剩余的最小单位向上取整。 Split whole and fractional shares, check both u128 products, and round fractional base units up as on chain. */
        BigInteger[] parts = normalized.divideAndRemainder(DEBT_SCALE);
        BigInteger whole = u128Product(parts[0], index);
        BigInteger remainder = u128Product(parts[1], index);
        BigInteger amount = whole.add(remainder.add(DEBT_SCALE.subtract(BigInteger.ONE)).divide(DEBT_SCALE));
        if (amount.bitLength() > 64) {
            throw new IllegalStateException("Projected lending debt is outside u64");
        }
        return amount;
    }

    /** 用链上一致的定点分母下取整，并防止未经约束的指数增大。 Floors using the on-chain fixed-point denominator and prevents unbounded index growth. */
    private static BigInteger scaleProduct(BigInteger left, BigInteger right) {
        return u128Product(left, right).divide(INDEX_SCALE);
    }

    /** 复制链上 checked_mul 的精度约束。 Mirrors the protocol's checked multiplication width. */
    private static BigInteger u128Product(BigInteger left, BigInteger right) {
        BigInteger product = left.multiply(right);
        if (product.bitLength() > 128) {
            throw new IllegalStateException("Lending interest product is outside u128");
        }
        return product;
    }

    /** 拼接低、高两个无符号 u64 字得到小端 u128。 Forms a little-endian u128 from its low and high unsigned words. */
    private static BigInteger unsigned128(ByteBuffer data, int offset) {
        return VaultSnapshotRpc.unsignedLongAt(data, offset + Long.BYTES).shiftLeft(64)
                .add(VaultSnapshotRpc.unsignedLongAt(data, offset));
    }
}

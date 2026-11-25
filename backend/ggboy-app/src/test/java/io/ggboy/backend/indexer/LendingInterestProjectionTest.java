package io.ggboy.backend.indexer;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 用 Rust 账本相同的时间和数值验证 Java 计息投影。 Tests the Java projection with the Rust ledger's time and monetary units. */
class LendingInterestProjectionTest {

    /** 计息起始时刻及本金。 Interest start and initial principal. */
    private static final long START = 1_700_000_000L;
    private static final BigInteger PRINCIPAL = BigInteger.valueOf(10_000_000);
    /** 使用含非零高位的 u128 归一化债务覆盖线布局。 Normalized u128 debt uses a nonzero high word to exercise wire decoding. */
    private static final BigInteger NORMALIZED = PRINCIPAL.multiply(BigInteger.TEN.pow(6));

    /** 起点前和首分钟内使用本金，跨整分钟后才按定点指数变化并向上取整。 Uses principal before the first epoch and applies rounded fixed-point accrual at whole minute boundaries. */
    @Test
    void matchesMinuteAndCeilingBoundaries() {
        assertEquals(PRINCIPAL, LendingInterestProjection.debt(NORMALIZED, START, START - 1));
        assertEquals(PRINCIPAL, LendingInterestProjection.debt(NORMALIZED, START, START + 59));
        assertEquals(BigInteger.valueOf(10_000_002), LendingInterestProjection.debt(NORMALIZED, START, START + 60));
        assertEquals(BigInteger.valueOf(10_000_004), LendingInterestProjection.debt(NORMALIZED, START, START + 120));
    }

    /** 池、仓位尾部使用小端 u128，资金池价值计入应还而其现金不变。 Little-endian u128 trailers project identical pool and position debt, with accrual isolated from cash. */
    @Test
    void decodesActivePoolAndPositionTrailers() {
        BigInteger normalized = BigInteger.ONE.shiftLeft(64).add(NORMALIZED);
        ByteBuffer pool = ByteBuffer.allocate(LendingInterestProjection.ACTIVE_POOL_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer position = ByteBuffer.allocate(LendingInterestProjection.ACTIVE_POSITION_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        pool.putLong(56, START).putLong(64, 90_000_000).putLong(72, normalized.longValue()).putLong(80, 1);
        position.putLong(88, START).putLong(96, normalized.longValue()).putLong(104, 1);
        var marketDebt = LendingInterestProjection.marketDebt(pool, START + 120);
        assertEquals(normalized, LendingInterestProjection.normalizedTotal(pool));
        assertEquals(normalized, LendingInterestProjection.normalizedPosition(position));
        assertEquals(marketDebt, LendingInterestProjection.positionDebt(position, START + 120));
        assertEquals(BigInteger.valueOf(90_000_000),
                LendingInterestProjection.poolAssets(pool, START + 120).subtract(marketDebt));
    }

    /** 账户金额加应还超过 u64 时停止估值，和程序的检查一致。 Pool cash plus debt must fit u64 just as in the program. */
    @Test
    void rejectsPoolAssetOverflow() {
        ByteBuffer pool = ByteBuffer.allocate(LendingInterestProjection.ACTIVE_POOL_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        pool.putLong(56, START).putLong(64, -1).putLong(72, 1);
        assertThrows(IllegalStateException.class, () -> LendingInterestProjection.poolAssets(pool, START));
    }
}

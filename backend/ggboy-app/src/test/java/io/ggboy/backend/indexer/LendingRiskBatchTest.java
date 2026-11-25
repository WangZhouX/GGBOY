package io.ggboy.backend.indexer;

import io.ggboy.backend.api.LendingOraclePriceVersion;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;
import io.ggboy.backend.indexer.LendingRiskBatch.Loan;
import io.ggboy.backend.indexer.LendingRiskBatch.Observation;
import io.ggboy.backend.indexer.LendingRiskBatch.Quote;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.OffsetDateTime;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 验证同槽资金与风险投影的边界行为。 Exercises the boundaries of same-slot liquidity and risk projection. */
class LendingRiskBatchTest {

    /** 固定的采集时间和市场登记用于构造可重复的快照。 Fixed observation time and registered market for repeatable snapshots. */
    private static final OffsetDateTime NOW = OffsetDateTime.parse("2026-01-01T00:00:00Z");
    private static final LendingMarketDO MARKET = new LendingMarketDO("devnet", "market", "program", "debt", "collateral", "oracle", 60);

    /** 健康度等于 1 时不可清算，同一钱包相差一个借款最小单位即可跨过阈值。 Health exactly one is safe and one more debt base unit crosses the threshold. */
    @Test
    void appliesExactThresholdAndUnifiesWalletAmounts() {
        var quote = new Quote(raw(100_000_000), NOW.minusSeconds(1), raw(106));
        var loans = Map.of("threshold", new Loan(raw(1_000_000_000), raw(80_000_000)),
                "unsafe", new Loan(raw(1_000_000_000), raw(80_000_001)));
        var batch = LendingRiskBatch.from(MARKET, input(raw(50_000_001), quote, loans, true));
        LendingPositionSnapshotDO safe = batch.positions().getFirst();
        LendingPositionSnapshotDO unsafe = batch.positions().getLast();

        assertEquals(2, batch.positions().size());
        assertEquals("threshold", safe.walletAddress());
        assertEquals(new BigDecimal("1.000000000000"), safe.healthFactor());
        assertFalse(safe.isLiquidatable());
        assertEquals(raw(70_000_000), safe.suppliedValueRaw());
        assertTrue(unsafe.isLiquidatable());
        assertTrue(unsafe.healthFactor().compareTo(BigDecimal.ONE) < 0);
        assertEquals(raw(108), unsafe.slot());
        assertEquals(quote.slot(), unsafe.oracleSlot());
        assertEquals(batch.market().oraclePriceVersion(), unsafe.oraclePriceVersion());
        assertEquals(raw(1_000_000), batch.market().oraclePriceDenominator());
        assertTrue(LendingOraclePriceVersion.matches(batch.market()));
        assertEquals(1_000, batch.market().borrowRateBps());
        assertEquals(761, batch.market().supplyRateBps());
        assertEquals(raw(49_999_999), batch.market().availableToBorrowRaw());
    }

    /** 缺价时观测账本可用，正债清算未知，无债不会成为候选。 The ledger remains available without a quote; positive-debt risk is unknown and zero-debt wallets are ineligible. */
    @Test
    void separatesMissingPriceFromDefinitiveZeroDebt() {
        var loans = Map.of("threshold", new Loan(raw(1), BigInteger.ZERO),
                "unsafe", new Loan(raw(1), BigInteger.ONE));
        var batch = LendingRiskBatch.from(MARKET, input(raw(50_000_001), null, loans, false));
        assertFalse(batch.market().riskBatchPublished());
        assertNull(batch.market().oracleAddress());
        assertNull(batch.market().oraclePriceNumerator());
        assertEquals(0, batch.market().borrowRateBps());
        assertEquals(0, batch.market().supplyRateBps());
        assertNull(batch.positions().getFirst().healthFactor());
        assertFalse(batch.positions().getFirst().isLiquidatable());
        assertNull(batch.positions().getLast().healthFactor());
        assertNull(batch.positions().getLast().isLiquidatable());
        assertNull(batch.positions().getLast().oraclePriceVersion());
    }

    /** 托管余额不覆盖池的已记账现金时拒绝整个观测。 Rejects an observation whose physical custody is below accounted cash. */
    @Test
    void rejectsUnbackedLiquidity() {
        assertThrows(IllegalStateException.class, () -> LendingRiskBatch.from(MARKET,
                input(raw(49_999_998), null, Map.of(), false)));
    }

    /**
     * 构造一笔含份额和精确债务总额的已校验观测。
     * Creates a validated sample containing supply shares and an exact debt aggregate.
     *
     * @param cash 托管借款币余额。 Custody balance in debt base units.
     * @param quote 市场报价，可为空。 Optional market quote.
     * @param loans 钱包的仓位。 Wallet loan positions.
     * @param active 是否启用计息。 Whether accrual is active.
     * @return 固定的最终确认钱包和市场观测。 Fixed finalized market and wallet observation.
     */
    private static Observation input(BigInteger cash, Quote quote, Map<String, Loan> loans, boolean active) {
        return new Observation(raw(108), NOW, cash, raw(210_000_000), raw(3), raw(160_000_001),
                6, 9, "oracle", quote, loans, Map.of("threshold", raw(1)), active);
    }

    /** 小整数转为与真实金额相同的精确表示。 Converts a small fixture value into the exact amount representation. */
    private static BigInteger raw(long amount) {
        return BigInteger.valueOf(amount);
    }
}

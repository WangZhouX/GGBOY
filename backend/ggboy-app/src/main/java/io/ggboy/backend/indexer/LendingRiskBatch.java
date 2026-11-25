package io.ggboy.backend.indexer;

import io.ggboy.backend.api.LendingOraclePriceVersion;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * 一次借贷市场风险批次及钱包快照，整数金额使用 Mint 最小单位。
 * One lending market risk batch and its wallet snapshots, with integer amounts in mint base units.
 *
 * @param market 可供池概览及清算查询读取的市场快照。 Market snapshot for pool and liquidation queries.
 * @param positions 完整采集的出借和借款钱包仓位。 Complete borrower and supplier position observations.
 * @param canonicalOracle 由借贷程序及市场派生的测试预言机。 Mock oracle derived from the lending program and market.
 */
record LendingRiskBatch(
        LendingMarketSnapshotDO market, List<LendingPositionSnapshotDO> positions, String canonicalOracle
) {
    /** 程序规定的测试价格有效期和借款、清算阈值。 Test price lifetime, borrowing limit and liquidation threshold from the program and API design. */
    static final int ORACLE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
    static final int BORROW_LTV_BPS = 7_000;
    static final int LIQUIDATION_THRESHOLD_BPS = 8_000;
    /** 基点分母。 Basis points per whole unit. */
    private static final BigInteger BPS = BigInteger.valueOf(10_000);
    /** 持仓估值与风险结果在数据库中展示的健康度小数位。 Database fractional digits for displayed health factors. */
    private static final int HEALTH_SCALE = 12;

    /**
     * 将冻结在同一 slot 的原始观测换算成市场和钱包记录。
     * Converts raw observations frozen at the same slot into market and wallet records.
     *
     * @param registration 已核实市场及 Mint 的目录对象。 Validated registry market and mints.
     * @param input 带完整账户集和价格证明的链上观测。 Verified chain observation with the complete account set and price evidence.
     * @return 可一次性提交的风险批次。 Risk batch ready for atomic persistence.
     */
    static LendingRiskBatch from(LendingMarketDO registration, Observation input) {
        /** 有效报价以整 tSOL 对整 mockUSDC 的有理数表示。 The usable price is a ratio of whole mockUSDC units per whole tSOL. */
        Quote quote = input.quote();
        BigInteger debtScale = BigInteger.TEN.pow(input.debtDecimals());
        String version = quote == null ? null : LendingOraclePriceVersion.compute(
                input.oracleAddress(), registration.collateralMint(), registration.debtMint(),
                quote.priceRaw(), debtScale, quote.slot(), quote.publishedAt());
        /** 可借现金排除直接转入的未记账代币。 Borrowable cash excludes unaccounted direct transfers. */
        BigInteger available = input.assetsRaw().subtract(input.totalDebtRaw());
        if (available.signum() < 0 || available.compareTo(input.cashRaw()) > 0) {
            throw new IllegalStateException("The lending cash custody does not cover the recorded pool liquidity");
        }
        /** 利用率以已借出金额占池总资产换算，按同一布局的状态或投影值计算。 Utilization is the debt share of pool assets from the same decoded or projected ledger. */
        int utilization = input.assetsRaw().signum() == 0 ? 0
                : input.totalDebtRaw().multiply(BPS).divide(input.assetsRaw()).intValueExact();
        /** 供给收益率为借款年化利率乘以利用率，应用整数基点向下取整。 Supply APR is borrow APR times utilization, rounded down in basis points. */
        int borrowApr = input.interestEnabled() ? LendingInterestProjection.BORROW_APR_BPS : 0;
        int supplyApr = borrowApr * utilization / BPS.intValueExact();
        LendingMarketSnapshotDO market = new LendingMarketSnapshotDO(registration.network(), registration.marketAddress(),
                input.slot(), input.observedAt(), input.cashRaw(), available, input.totalDebtRaw(), supplyApr, borrowApr, utilization,
                BORROW_LTV_BPS, LIQUIDATION_THRESHOLD_BPS,
                quote == null ? null : input.oracleAddress(),
                quote == null ? null : registration.collateralMint(),
                quote == null ? null : registration.debtMint(),
                quote == null ? null : quote.priceRaw(), quote == null ? null : debtScale,
                quote == null ? null : quote.slot(), quote == null ? null : quote.publishedAt(), version, quote != null);

        /** 同一公钥可以同时借款和出借，只发一条钱包快照。 One wallet can both borrow and supply and receives a single snapshot. */
        TreeSet<String> wallets = new TreeSet<>(input.borrows().keySet());
        wallets.addAll(input.supplies().keySet());
        List<LendingPositionSnapshotDO> positions = wallets.stream()
                .map(wallet -> position(registration, input, wallet, quote, version)).toList();
        return new LendingRiskBatch(market, positions, input.oracleAddress());
    }

    /**
     * 计算单个钱包的份额价值、健康度和清算状态，同槽输出。
     * Computes one wallet's share value, health and liquidation status at the observation slot.
     *
     * @param registration 已核实的市场登记。 Verified market registry.
     * @param input 同槽的账户输入和精度。 Same-slot account inputs and decimals.
     * @param wallet 统一的借款人或出借人公钥。 Unified borrower or supplier public key.
     * @param quote 已证明的报价，缺少时为空。 Verified quote, or null if unavailable.
     * @param version 该报价对应的版本标识。 Version of that quote.
     * @return 该钱包的数据库快照。 Database snapshot for the wallet.
     */
    private static LendingPositionSnapshotDO position(
            LendingMarketDO registration, Observation input, String wallet, Quote quote, String version
    ) {
        /** 已锁抵押品、本金和出借份额都从该钱包在同一 slot 的账户取得。 Get locked collateral, principal and supply shares from wallet accounts at the same slot. */
        Loan loan = input.borrows().getOrDefault(wallet, new Loan(BigInteger.ZERO, BigInteger.ZERO));
        BigInteger shares = input.supplies().getOrDefault(wallet, BigInteger.ZERO);
        BigInteger value = shares.signum() == 0 ? BigInteger.ZERO
                : input.assetsRaw().multiply(shares).divide(input.totalSharesRaw());
        /** 无债务不参加清算、缺少价格时不能评估有债仓位。 Debt-free wallets are ineligible. Borrower risk remains unknown without a verified quote. */
        Boolean eligible = loan.debtRaw().signum() == 0 ? Boolean.FALSE : null;
        BigDecimal health = null;
        if (quote != null && loan.debtRaw().signum() > 0) {
            /** 分子和分母保留完整精度，只有展示健康度向下取到数据库小数位。 Compare full-width integers and round down only for displayed health. */
            BigInteger adjustedCollateral = loan.collateralRaw().multiply(quote.priceRaw())
                    .multiply(BigInteger.valueOf(LIQUIDATION_THRESHOLD_BPS));
            BigInteger scaledDebt = loan.debtRaw().multiply(BigInteger.TEN.pow(input.collateralDecimals())).multiply(BPS);
            eligible = loan.collateralRaw().signum() > 0 && adjustedCollateral.compareTo(scaledDebt) < 0;
            health = new BigDecimal(adjustedCollateral).divide(new BigDecimal(scaledDebt), HEALTH_SCALE, RoundingMode.DOWN);
        }
        return new LendingPositionSnapshotDO(registration.network(), registration.marketAddress(), wallet, input.slot(),
                input.observedAt(), quote == null ? null : quote.slot(), shares, value, loan.collateralRaw(),
                loan.debtRaw(), health, eligible, version);
    }

    /**
     * 已校验的市场报价。
     * A verified market quote.
     *
     * @param priceRaw 一个完整抵押 token 对应的借款 Mint 最小单位。 Debt base units per whole collateral token.
     * @param publishedAt 链上发布时间。 On-chain publication time.
     * @param slot 原始价格写入交易所在 slot。 Slot of the original price write.
     */
    record Quote(BigInteger priceRaw, OffsetDateTime publishedAt, BigInteger slot) {
    }

    /**
     * 签名钱包的借款账本。
     * Borrow ledger for a signing wallet.
     *
     * @param collateralRaw 抵押 Mint 最小单位。 Collateral mint base units.
     * @param debtRaw 借款 Mint 最小单位。 Debt mint base units.
     */
    record Loan(BigInteger collateralRaw, BigInteger debtRaw) {
    }

    /**
     * 从同一个最终确认 slot 采集并核实的借贷账户视图。
     * Verified lending account view sampled at one finalized slot.
     *
     * @param slot 统一观测 slot。 Shared observation slot.
     * @param observedAt 同槽 Clock 的 UTC 时间。 UTC time from the same-slot Clock.
     * @param cashRaw 池实际托管金额，单位为借款 Mint 最小单位。 Physical pool custody in debt mint base units.
     * @param assetsRaw 池账面资产，单位为借款 Mint 最小单位。 Pool book assets in debt mint base units.
     * @param totalSharesRaw 池全部出借份额最小单位。 Total pool supply share base units.
     * @param totalDebtRaw 池全部未偿款，单位为借款 Mint 最小单位。 Total pool debt in debt mint base units.
     * @param debtDecimals 借款 Mint 小数精度。 Debt mint decimal precision.
     * @param collateralDecimals 抵押 Mint 小数精度。 Collateral mint decimal precision.
     * @param oracleAddress 规范的测试预言机 PDA。 Canonical mock oracle PDA.
     * @param quote 已证明的报价，缺价时为空。 Verified quote, nullable when unavailable.
     * @param borrows 按借款人公钥索引的借款账本。 Loan ledgers keyed by borrower.
     * @param supplies 按出借人公钥索引的最小单位份额。 Supply shares in base units keyed by supplier.
     * @param interestEnabled 是否启用链上计息。 Whether on-chain accrual is enabled.
     */
    record Observation(
            BigInteger slot, OffsetDateTime observedAt,
            BigInteger cashRaw, BigInteger assetsRaw, BigInteger totalSharesRaw, BigInteger totalDebtRaw,
            int debtDecimals, int collateralDecimals, String oracleAddress, Quote quote,
            Map<String, Loan> borrows, Map<String, BigInteger> supplies, boolean interestEnabled
    ) {
    }
}

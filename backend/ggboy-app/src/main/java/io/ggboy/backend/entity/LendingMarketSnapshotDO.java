package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigInteger;
import java.time.OffsetDateTime;

/**
 * 借贷市场在某一最终确认观测 slot 的流动性、债务、利率和风险参数。
 * Market liquidity, debt, rates and risk parameters at a finalized observation slot.
 *
 * <p>复合主键 / Composite primary key: {@code (network, market_address, slot)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param marketAddress 链上借贷市场状态账户地址。
 *        On-chain lending market state account address.
 * @param slot RPC 读取市场与计算输入所处的最终确认观测 slot。
 *        Finalized RPC observation slot of the market and calculation inputs.
 * @param observedAt 索引器取得该快照的时间，API 统一输出 UTC。
 *        Time the indexer obtained the snapshot. The API emits UTC.
 * @param cashRaw 池内现金余额，单位为借款 Mint 最小单位。
 *        Pool cash balance in debt mint base units.
 * @param availableToBorrowRaw 应用市场级限制后的可借金额，单位为借款 Mint 最小单位。
 *        Amount available to borrow after market-level limits, in debt mint base units.
 * @param totalDebtRaw 计息后未偿且未核销的总债务，单位为借款 Mint 最小单位。
 *        Accrued outstanding debt excluding write-offs, in debt mint base units.
 * @param supplyRateBps 按基点表示的出借年化利率。
 *        Annualized supply rate in basis points.
 * @param borrowRateBps 按基点表示的借款年化利率。
 *        Annualized borrow rate in basis points.
 * @param utilizationBps 按基点表示的资金利用率。
 *        Pool utilization in basis points.
 * @param borrowLtvBps 按基点表示的借款 LTV 上限。
 *        Maximum borrowing loan-to-value ratio in basis points.
 * @param liquidationThresholdBps 按基点表示、用于计算健康度的清算阈值。
 *        Liquidation threshold used to calculate health, in basis points.
 */
@TableName("lending_market_snapshot")
public record LendingMarketSnapshotDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "market_address", updateStrategy = FieldStrategy.NEVER) String marketAddress,
        @TableField(value = "slot", updateStrategy = FieldStrategy.NEVER) BigInteger slot,
        @TableField("observed_at") OffsetDateTime observedAt,
        @TableField("cash_raw") BigInteger cashRaw,
        @TableField("available_to_borrow_raw") BigInteger availableToBorrowRaw,
        @TableField("total_debt_raw") BigInteger totalDebtRaw,
        @TableField("supply_rate_bps") int supplyRateBps,
        @TableField("borrow_rate_bps") int borrowRateBps,
        @TableField("utilization_bps") int utilizationBps,
        @TableField("borrow_ltv_bps") int borrowLtvBps,
        @TableField("liquidation_threshold_bps") int liquidationThresholdBps
) {
}

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
 * @param oracleAddress 快照所用的价格源账户地址。
 *        Price feed account address used by this snapshot.
 * @param oracleCollateralMint 价格比率的抵押资产 Mint 地址。
 *        Collateral mint address in the price ratio.
 * @param oracleDebtMint 价格比率的债务资产 Mint 地址。
 *        Debt mint address in the price ratio.
 * @param oraclePriceNumerator 每整单位抵押资产所值整单位债务资产的报价分子。
 *        Numerator of the whole debt tokens per whole collateral token price ratio.
 * @param oraclePriceDenominator 每整单位抵押资产所值整单位债务资产的报价分母。
 *        Denominator of the whole debt tokens per whole collateral token price ratio.
 * @param oracleSlot 预言机原始报价的链上发布 slot。
 *        On-chain publication slot of the original oracle quote.
 * @param oraclePublishedAt 预言机原始报价的发布时间。
 *        Publication time of the original oracle quote.
 * @param oraclePriceVersion 该批次所用报价的 64 字符小写十六进制版本。
 *        The 64-character lowercase hexadecimal version of the quote used by this batch.
 * @param riskBatchPublished 该风险快照批次是否已完整发布。
 *        Whether this risk snapshot batch has been fully published.
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
        @TableField("liquidation_threshold_bps") int liquidationThresholdBps,
        @TableField("oracle_address") String oracleAddress,
        @TableField("oracle_collateral_mint") String oracleCollateralMint,
        @TableField("oracle_debt_mint") String oracleDebtMint,
        @TableField("oracle_price_numerator") BigInteger oraclePriceNumerator,
        @TableField("oracle_price_denominator") BigInteger oraclePriceDenominator,
        @TableField("oracle_slot") BigInteger oracleSlot,
        @TableField("oracle_published_at") OffsetDateTime oraclePublishedAt,
        @TableField("oracle_price_version") String oraclePriceVersion,
        @TableField("risk_batch_published") boolean riskBatchPublished
) {

    /**
     * 提供 Lambda 查询使用的网络属性访问器，对应 network 列。
     * Exposes the network property for lambda queries against the network column.
     *
     * @return 网络的小写协议值。 Lowercase network wire identifier.
     */
    public String getNetwork() {
        return network;
    }

    /**
     * 提供 Lambda 查询使用的市场地址访问器，对应 market_address 列。
     * Exposes the market address property for lambda queries against the market_address column.
     *
     * @return 借贷市场状态账户公钥。 Public key of the lending market state account.
     */
    public String getMarketAddress() {
        return marketAddress;
    }

    /**
     * 提供 Lambda 排序使用的观测 slot 访问器，对应数值型 slot 列。
     * Exposes the observation slot for lambda ordering of the numeric slot column.
     *
     * @return 市场账户与计算输入的最终确认观测 slot。 Finalized observation slot of the market and calculation inputs.
     */
    public BigInteger getSlot() {
        return slot;
    }
}

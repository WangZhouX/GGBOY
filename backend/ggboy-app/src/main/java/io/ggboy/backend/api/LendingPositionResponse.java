package io.ggboy.backend.api;

/**
 * 一个市场下指定钱包的借款与出借仓位。
 * Borrowing and supplying position of one wallet in one lending market.
 *
 * @param network 市场所在网络，使用小写协议标识。 Lowercase wire identifier of the market's network.
 * @param marketAddress 借贷市场状态账户的公钥。 Public key of the lending market state account.
 * @param walletAddress 仓位持有人的公钥。 Public key of the position owner.
 * @param snapshot 最新钱包仓位快照，钱包从未被采集时为空。
 *        Latest wallet observation, or null when the wallet has never been observed.
 */
public record LendingPositionResponse(String network, String marketAddress, String walletAddress, Snapshot snapshot) {

    /**
     * 钱包仓位在一个观测 slot 的基础数据和可判定额度。
     * Wallet position data and determinate limits at one observation slot.
     *
     * @param slot 钱包仓位观测 slot，以十进制整数字符串表示。 Wallet observation slot as a decimal integer string.
     * @param observedAt 索引器采集时间，使用 ISO 8601 UTC。 Indexer observation time as ISO 8601 UTC.
     * @param oracleSlot 观测使用的预言机发布 slot，价格不可用时为空。
     *        Publish slot of the price used at observation, or null when unavailable.
     * @param freshness 根据钱包观测时间和借贷配置确定的新鲜度。 Freshness based on wallet observation time and lending configuration.
     * @param collateralRaw 抵押品数量，以抵押 Mint 最小单位的整数字符串表示。 Collateral as an integer string in collateral mint base units.
     * @param debtRaw 观测时计息后的未偿债务，以借款 Mint 最小单位的整数字符串表示。
     *        Observed accrued debt as an integer string in debt mint base units.
     * @param healthFactor 观测时无量纲健康度的小数字符串，无债务或缺少有效价格时为空。
     *        Observed dimensionless health factor as a decimal string, or null with no debt or usable price.
     * @param isLiquidatable 观测时的清算标记，无债务为 false，正债务但价格缺失时为空。
     *        Observed liquidation eligibility, false without debt and null with positive debt but no usable price.
     * @param supplySharesRaw 钱包持有的出借份额，以程序份额最小单位的整数字符串表示。
     *        Wallet supply shares as an integer string in program share base units.
     * @param suppliedValueRaw 钱包出借估值，以借款 Mint 最小单位的整数字符串表示。
     *        Wallet supply value as an integer string in debt mint base units.
     * @param maxBorrowRaw 当前可新增的债务上限，以借款 Mint 最小单位的整数字符串表示，无法确定时为空。
     *        Current additional borrowing limit as an integer string in debt mint base units, or null if unknown.
     * @param maxCollateralWithdrawRaw 当前最多可取回抵押品，以抵押 Mint 最小单位的整数字符串表示，无法确定时为空。
     *        Current collateral withdrawal limit as an integer string in collateral mint base units, or null if unknown.
     * @param maxSupplyWithdrawRaw 当前出借可提取到账上限，以借款 Mint 最小单位的整数字符串表示，无法确定时为空。
     *        Current maximum supply payout as an integer string in debt mint base units, or null if unknown.
     * @param maxSupplyWithdrawSharesRaw 与到账上限配套的可提取份额，以程序份额最小单位的整数字符串表示，无法确定时为空。
     *        Shares associated with the payout limit, as an integer string in program share base units, or null if unknown.
     * @param marketRisk 同 slot 市场的风险参数和可计算的临界清算价。匹配快照缺失时为空。
     *        Risk parameters and any available liquidation price from the same slot, or null without a matching snapshot.
     */
    public record Snapshot(
            String slot,
            String observedAt,
            String oracleSlot,
            SnapshotFreshness freshness,
            String collateralRaw,
            String debtRaw,
            String healthFactor,
            Boolean isLiquidatable,
            String supplySharesRaw,
            String suppliedValueRaw,
            String maxBorrowRaw,
            String maxCollateralWithdrawRaw,
            String maxSupplyWithdrawRaw,
            String maxSupplyWithdrawSharesRaw,
            MarketRisk marketRisk
    ) {
    }

    /**
     * 「额度与清算条件」区域使用的风险参数与价格信息。
     * Risk parameters and prices for the Borrowing Limits and Liquidation Conditions section.
     *
     * @param borrowLtvBps 观测时借款 LTV 上限，以基点表示。 Observed borrowing LTV cap in basis points.
     * @param liquidationThresholdBps 观测时的清算阈值，以基点表示。 Observed liquidation threshold in basis points.
     * @param collateralPrice 每一个整单位抵押资产对应的借款资产价格，现有快照没有价格时为空。
     *        Debt tokens per whole collateral token, or null when the current schema does not provide the price.
     * @param currentLtv 无量纲的当前债务与抵押品价值比率，缺少有效估值时为空。
     *        Dimensionless ratio of current debt to collateral value, or null without a usable valuation.
     * @param liquidationPrice 健康度为 1 的临界价格，以每整单位抵押资产对应的借款资产计，无法估算时为空。
     *        Price at a health factor of 1 in debt tokens per whole collateral token, or null when unavailable.
     */
    public record MarketRisk(
            int borrowLtvBps,
            int liquidationThresholdBps,
            String collateralPrice,
            String currentLtv,
            String liquidationPrice
    ) {
    }
}

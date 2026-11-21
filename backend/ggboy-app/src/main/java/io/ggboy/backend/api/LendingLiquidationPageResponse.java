package io.ggboy.backend.api;

import java.util.List;

/**
 * 市场的清算候选分页及该页使用的市场和价格上下文。
 * Market liquidation candidates and the market and price context applied to their page.
 *
 * @param network 小写网络协议标识。 Lowercase network wire identifier.
 * @param marketAddress 已登记的市场状态账户公钥。 Public key of the registered market state account.
 * @param availability 数据能否用于当前清算候选查询。 Availability of data for the current liquidation candidate query.
 * @param marketSlot 最新市场观测的十进制 slot，尚未采集时为空。 Latest market observation slot as decimal text, or null if unobserved.
 * @param observedAt 最新市场观测的 ISO 8601 UTC 时间，尚未采集时为空。 Latest market observation time in ISO 8601 UTC, or null if unobserved.
 * @param oracleAddress 经验证的预言机账户公钥，列表未就绪时为空。 Verified oracle account public key, or null if the page is not ready.
 * @param oracleSlot 经验证价格的十进制发布 slot，列表未就绪时为空。 Verified price publish slot as decimal text, or null if the page is not ready.
 * @param oraclePublishedAt 经验证价格的 ISO 8601 UTC 发布时间，列表未就绪时为空。 Verified price publication time in ISO 8601 UTC, or null if the page is not ready.
 * @param collateralPrice 每整单位抵押资产的借款资产价格，使用小数字符串，列表未就绪时为空。
 *        Debt asset price per whole collateral asset as a decimal string, or null if the page is not ready.
 * @param items 本页清算候选，按健康度和钱包地址升序。 Candidates ordered by ascending health factor and wallet address.
 * @param nextCursor 继续读取同一评估上下文的游标，空页、末页或未就绪时为空。
 *        Cursor for the same evaluation context, null for an empty, final or unavailable page.
 */
public record LendingLiquidationPageResponse(
        String network,
        String marketAddress,
        Availability availability,
        String marketSlot,
        String observedAt,
        String oracleAddress,
        String oracleSlot,
        String oraclePublishedAt,
        String collateralPrice,
        List<Item> items,
        String nextCursor
) {

    /**
     * 固化候选列表，保留查询顺序。
     * Snapshots the list of candidates while preserving query order.
     *
     * @param network 小写网络协议标识。 Lowercase network wire identifier.
     * @param marketAddress 市场状态账户公钥。 Public key of the market state account.
     * @param availability 清算候选数据状态。 Availability of liquidation candidate data.
     * @param marketSlot 市场观测 slot，没有观测时为空。 Market observation slot, or null if unobserved.
     * @param observedAt 市场观测时间，没有观测时为空。 Market observation time, or null if unobserved.
     * @param oracleAddress 经验证的预言机账户公钥。 Verified oracle account public key.
     * @param oracleSlot 已验证价格的发布 slot。 Publish slot of the verified price.
     * @param oraclePublishedAt 已验证价格的发布时间。 Publication time of the verified price.
     * @param collateralPrice 每整单位抵押资产的借款资产价格。 Debt asset price per whole collateral asset.
     * @param items 本页候选。 Candidates on this page.
     * @param nextCursor 续页游标，无法续页时为空。 Continuation cursor, or null when no continuation is available.
     */
    public LendingLiquidationPageResponse {
        items = List.copyOf(items);
    }

    /**
     * 当前市场的清算候选数据状态。
     * Availability of liquidation candidate data in the current market.
     */
    public enum Availability {

        /** 最新评估批次已发布且价格有效。 The current evaluation batch is published and its price is valid. */
        READY,

        /** 市场尚未采集，或风险批次尚未发布。 The market is unobserved or its risk batch is unpublished. */
        NO_SNAPSHOT,

        /** 市场观测超出新鲜度阈值或时间不可用。 The market observation is beyond the freshness threshold or its time is unusable. */
        STALE,

        /** 价格缺失、过期或与市场配置不相容。 Price is missing, stale or incompatible with the market configuration. */
        PRICE_UNAVAILABLE
    }

    /**
     * 一条入选的可清算仓位，交易额度由实时清算预览确定。
     * One liquidation candidate whose transaction limits are resolved by a live preview.
     *
     * @param walletAddress 借款人钱包公钥。 Borrower's wallet public key.
     * @param collateralRaw 抵押 Mint 最小单位数量的十进制整数字符串。 Collateral mint base units as a decimal integer string.
     * @param debtRaw 借款 Mint 最小单位的计息后债务的整数字符串。 Accrued debt in debt mint base units as a decimal integer string.
     * @param healthFactor 展示精度的无量纲健康度小数字符串。 Dimensionless health factor as a display-precision decimal string.
     * @param slot 钱包观测的十进制 slot，匹配市场 slot。 Wallet observation slot as decimal text, matching the market slot.
     * @param observedAt 钱包观测的 ISO 8601 UTC 时间。 Wallet observation time in ISO 8601 UTC.
     * @param isLiquidatable 按完整精度评估的清算标记。 Liquidation eligibility assessed at full precision.
     */
    public record Item(
            String walletAddress,
            String collateralRaw,
            String debtRaw,
            String healthFactor,
            String slot,
            String observedAt,
            boolean isLiquidatable
    ) {
    }
}

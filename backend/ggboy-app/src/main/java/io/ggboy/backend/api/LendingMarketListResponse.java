package io.ggboy.backend.api;

import java.util.List;

/**
 * 借贷市场目录及最新资金池快照的响应数据。
 * Response payload containing registered lending markets and their latest pool snapshots.
 *
 * @param items 按市场地址升序排列，当前网络未登记市场时为空列表。
 *        Items ordered by market address, or an empty list when no markets are registered on the network.
 */
public record LendingMarketListResponse(List<Item> items) {

    /**
     * 一个借贷市场的登记信息和最新已观测数据。
     * Registration and latest observed data for one lending market.
     *
     * @param network 市场部署网络的小写协议标识。 Lowercase wire identifier of the market's deployment network.
     * @param address 市场状态账户的公钥。 Public key of the market state account.
     * @param programId 拥有市场状态账户的借贷程序公钥。 Public key of the lending program that owns the market state account.
     * @param debtAsset 用于出借、借款和还款的资产及精度。 Asset and precision for supplying, borrowing, and repayments.
     * @param collateralAsset 市场支持的抵押资产及精度。 Collateral asset and precision supported by the market.
     * @param latestSnapshot 最新资金池快照，未观测时为空。 Latest pool snapshot, or null before the first observation.
     */
    public record Item(
            String network,
            String address,
            String programId,
            AssetMintResponse debtAsset,
            AssetMintResponse collateralAsset,
            Snapshot latestSnapshot
    ) {
    }

    /**
     * 「资金池现况」所需的已采集数据，金额保持借款资产最小单位的完整精度。
     * Observed Pool Overview data with exact amounts in debt asset base units.
     *
     * @param slot RPC 读取资金池的观测 slot，使用十进制整数字符串。 Pool observation slot as a decimal integer string.
     * @param observedAt 索引器采集时间，使用 ISO 8601 UTC 文本。 Indexer observation time as ISO 8601 UTC text.
     * @param cashRaw 池内现金，以借款 Mint 最小单位的整数字符串表示。 Pool cash as an integer string in debt mint base units.
     * @param availableToBorrowRaw 受市场级限制的可借金额，以借款 Mint 最小单位的整数字符串表示。
     *        Amount available after market-level borrowing limits, as an integer string in debt mint base units.
     * @param totalDebtRaw 计息后未偿且未核销的债务，以借款 Mint 最小单位的整数字符串表示。
     *        Accrued outstanding debt excluding write-offs, as an integer string in debt mint base units.
     * @param utilizationBps 资金利用率，以基点表示。 Pool utilization in basis points.
     * @param borrowRateBps 借款年化利率，以基点表示。 Annual borrowing rate in basis points.
     * @param supplyRateBps 出借年化利率，以基点表示。 Annual supply rate in basis points.
     * @param freshness 根据观测时间和借贷配置确定的新鲜度。 Freshness based on observation time and lending configuration.
     */
    public record Snapshot(
            String slot,
            String observedAt,
            String cashRaw,
            String availableToBorrowRaw,
            String totalDebtRaw,
            int utilizationBps,
            int borrowRateBps,
            int supplyRateBps,
            SnapshotFreshness freshness
    ) {
    }
}

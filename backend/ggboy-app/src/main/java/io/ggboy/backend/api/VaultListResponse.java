package io.ggboy.backend.api;

import java.util.List;

/**
 * 策略金库列表的成功响应数据。
 * Success payload for the strategy vault list.
 *
 * @param items 按金库地址升序排列的条目，没有登记金库时为空列表。
 *        Entries ordered by vault address, or an empty list when no vaults are registered.
 */
public record VaultListResponse(List<Item> items) {

    /**
     * 一条金库登记及其最新观测快照。
     * A registered vault and its latest observed snapshot.
     *
     * @param network 请求网络的小写协议标识。
     *        Lowercase wire identifier for the requested network.
     * @param address 金库状态账户的公钥。
     *        Public key of the vault state account.
     * @param programId 管理金库状态账户的链上程序公钥。
     *        Public key of the on-chain program that owns the vault state account.
     * @param quoteAsset 存入、赎回和估值使用的资产。
     *        Asset used for deposits, redemptions, and valuation.
     * @param shareAsset 代表金库权益的份额资产。
     *        Share asset representing ownership in the vault.
     * @param strategyAsset 策略资产；未配置时为空。
     *        Strategy asset, or null when unconfigured.
     * @param lendingMarketAddress 配置的借贷市场公钥；未配置时为空。
     *        Configured lending market public key, or null when unconfigured.
     * @param latestSnapshot 最新观测快照；尚未采集时为空。
     *        Latest observed snapshot, or null when none has been collected.
     */
    public record Item(
            String network,
            String address,
            String programId,
            AssetMintResponse quoteAsset,
            AssetMintResponse shareAsset,
            AssetMintResponse strategyAsset,
            String lendingMarketAddress,
            Snapshot latestSnapshot
    ) {
    }

    /**
     * 金库的最新已采集快照。各最小单位数量和 slot 均为十进制整数字符串。
     * Latest collected vault snapshot. Base-unit quantities and slots are decimal integer strings.
     *
     * @param slot 读到账户时的观测 slot。 Slot at which the accounts were observed.
     * @param observedAt 索引器采集时间，使用 ISO 8601 UTC 文本。
     *        Indexer observation time as ISO 8601 UTC text.
     * @param oracleSlot 有效价格的发布 slot；没有可用价格时为空。
     *        Publish slot of the valid oracle price, or null when none is available.
     * @param cashRaw 金库现金，单位为计价资产最小单位。
     *        Vault cash in quote asset base units.
     * @param strategyAmountRaw 策略资产数量，单位为策略资产最小单位。
     *        Strategy holdings in strategy asset base units.
     * @param strategyValueRaw 策略估值，单位为计价资产最小单位；需要估值且价格不可用时为空。
     *        Strategy valuation in quote asset base units, or null if a required price is unavailable.
     * @param lendValueRaw 出借仓位账面价值，单位为计价资产最小单位。
     *        Book value of the lending position in quote asset base units.
     * @param lendingWithdrawableRaw 当前可从借贷池提取的金额，单位为计价资产最小单位。
     *        Currently withdrawable pool amount in quote asset base units.
     * @param navRaw 金库总净值，单位为计价资产最小单位；估值不可用时为空。
     *        Total net asset value in quote asset base units, or null when unavailable.
     * @param totalSharesRaw 已发行份额总量，单位为份额资产最小单位。
     *        Total outstanding shares in share asset base units.
     * @param autoRecallEnabled 本次观测的链上状态是否允许赎回时自动收回借贷流动性。
     *        Whether the observed on-chain state allows automatic recall during redemption.
     * @param freshness 根据采集时间与配置阈值确定的新鲜度。
     *        Freshness determined from the observation time and configured threshold.
     */
    public record Snapshot(
            String slot,
            String observedAt,
            String oracleSlot,
            String cashRaw,
            String strategyAmountRaw,
            String strategyValueRaw,
            String lendValueRaw,
            String lendingWithdrawableRaw,
            String navRaw,
            String totalSharesRaw,
            boolean autoRecallEnabled,
            SnapshotFreshness freshness
    ) {
    }
}

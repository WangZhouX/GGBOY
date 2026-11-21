package io.ggboy.backend.api;

/**
 * 策略金库页「我的金库份额」的成功响应，定位到一个网络、金库和钱包。
 * Success payload for My Vault Shares, scoped to one network, vault and wallet.
 *
 * @param network 请求网络的小写协议标识。 Lowercase wire identifier of the requested network.
 * @param vaultAddress 金库状态账户的公钥。 Public key of the vault state account.
 * @param walletAddress 持有份额的钱包公钥。 Public key of the wallet holding the shares.
 * @param snapshot 最新持仓快照，钱包尚未被采集时为空。
 *        Latest position snapshot, or null when the wallet has not been observed.
 */
public record VaultPositionResponse(String network, String vaultAddress, String walletAddress, Snapshot snapshot) {

    /**
     * 钱包在指定 slot 的份额及赎回估算。slot 和最小单位数量均使用十进制整数字符串。
     * Wallet shares and redemption estimates at one slot. Slots and base-unit quantities are decimal integer strings.
     *
     * @param slot 钱包持仓的观测 slot。 Observation slot of the wallet position.
     * @param observedAt 钱包快照采集时间，使用 ISO 8601 UTC 文本。
     *        Wallet snapshot observation time as ISO 8601 UTC text.
     * @param freshness 根据钱包快照的采集时间和配置阈值确定的新鲜度。
     *        Freshness based on the wallet snapshot observation time and configured threshold.
     * @param sharesRaw 钱包持有的份额，以份额 Mint 最小单位计，已观测到无份额时为 "0"。
     *        Wallet holdings in share mint base units, or "0" when observed to be empty.
     * @param positionValueRaw 全部份额的估值，以计价 Mint 最小单位计，估值不可用时为空。
     *        Value of all shares in quote mint base units, or null when the valuation is unavailable.
     * @param maxRedeemSharesRaw 受同一 slot 流动性约束的可赎回份额，以份额 Mint 最小单位计，无法计算时为空。
     *        Redeemable shares subject to same-slot liquidity, in share mint base units, or null when unavailable.
     * @param redeemableRaw 赎回上限对应的预计到账，以计价 Mint 最小单位计，无法计算时为空。
     *        Estimated payout for the share limit, in quote mint base units, or null when unavailable.
     */
    public record Snapshot(
            String slot,
            String observedAt,
            SnapshotFreshness freshness,
            String sharesRaw,
            String positionValueRaw,
            String maxRedeemSharesRaw,
            String redeemableRaw
    ) {
    }
}

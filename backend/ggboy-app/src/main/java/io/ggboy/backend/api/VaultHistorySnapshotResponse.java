package io.ggboy.backend.api;

import io.ggboy.backend.entity.VaultSnapshotDO;
import java.util.Objects;

/**
 * 金库「每份净值走势」使用的一条历史快照。最小单位数量和 slot 均使用十进制整数字符串。
 * One historical snapshot for NAV per Share History. Base-unit amounts and slots use decimal integer strings.
 *
 * @param slot 读取金库状态时的观测 slot。 Slot at which the vault state was observed.
 * @param observedAt 索引器采集时间，使用 ISO 8601 UTC 文本。 Indexer observation time as ISO 8601 UTC text.
 * @param oracleSlot 有效价格的发布 slot，无有效价格时为空。 Valid price publish slot, or null when unavailable.
 * @param cashRaw 金库现金，单位为计价 Mint 最小单位。 Vault cash in quote mint base units.
 * @param strategyAmountRaw 策略资产数量，单位为策略 Mint 最小单位。 Strategy holdings in strategy mint base units.
 * @param strategyValueRaw 策略资产估值，单位为计价 Mint 最小单位，价格不可用且需要估值时为空。
 *        Strategy valuation in quote mint base units, or null if a required price is unavailable.
 * @param lendValueRaw 出借仓位账面价值，单位为计价 Mint 最小单位。
 *        Lending position book value in quote mint base units.
 * @param lendingWithdrawableRaw 当时可从借贷池提取的金额，单位为计价 Mint 最小单位。
 *        Amount withdrawable from the lending pool at observation, in quote mint base units.
 * @param navRaw 金库净值，单位为计价 Mint 最小单位，估值不可用时为空。
 *        Vault NAV in quote mint base units, or null if valuation is unavailable.
 * @param totalSharesRaw 当时流通的份额，单位为份额 Mint 最小单位。
 *        Share supply at observation, in share mint base units.
 */
public record VaultHistorySnapshotResponse(
        String slot,
        String observedAt,
        String oracleSlot,
        String cashRaw,
        String strategyAmountRaw,
        String strategyValueRaw,
        String lendValueRaw,
        String lendingWithdrawableRaw,
        String navRaw,
        String totalSharesRaw
) {

    /**
     * 将持久化快照转换成统一的观测字段，便于历史页和最新快照共用。
     * Maps a persisted snapshot to observation fields shared by history and latest-snapshot responses.
     *
     * @param snapshot 金库快照记录。 Persisted vault snapshot.
     * @return 观测时间采用 UTC，数值保持完整精度，未知值保留为空的快照。
     *        Snapshot with UTC observation time, full numeric precision, and null for unknown values.
     */
    public static VaultHistorySnapshotResponse from(VaultSnapshotDO snapshot) {
        // 保留无价格时的净值缺口。已知的零值仍输出十进制字符串 0。
        // Preserve missing price data so the chart can show a gap. Known zero values still serialize as decimal 0.
        return new VaultHistorySnapshotResponse(
                snapshot.slot().toString(),
                snapshot.observedAt().toInstant().toString(),
                Objects.toString(snapshot.oracleSlot(), null),
                snapshot.cashRaw().toString(),
                snapshot.strategyAmountRaw().toString(),
                Objects.toString(snapshot.strategyValueRaw(), null),
                snapshot.lendValueRaw().toString(),
                snapshot.lendingWithdrawableRaw().toString(),
                Objects.toString(snapshot.navRaw(), null),
                snapshot.totalSharesRaw().toString()
        );
    }
}

package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.OffsetDateTime;

/**
 * 一个市场参与者在某一观测 slot 的供给、抵押、欠款和风险状态。
 * Supply, collateral, debt and risk observed for one market participant at a given slot.
 *
 * <p>复合主键 / Composite primary key: {@code (network, market_address, wallet_address, slot)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param marketAddress 链上借贷市场状态账户地址。
 *        On-chain lending market state account address.
 * @param walletAddress 仓位所属的出借人、借款人或供给资金的金库 PDA 地址。
 *        Owner address of the supplier, borrower or vault PDA supplying funds.
 * @param slot RPC 读取该仓位及其计算输入所处的最终确认观测 slot。
 *        Finalized RPC observation slot of the position and calculation inputs.
 * @param observedAt 索引器取得该快照的时间，API 统一输出 UTC。
 *        Time the indexer obtained the snapshot. The API emits UTC.
 * @param oracleSlot 使用的预言机发布 slot。未取得可用价格时为空。
 *        Publish slot of the oracle price used. Null when a usable price is unavailable.
 * @param supplySharesRaw 持有的借贷池份额原始单位数量，依据借贷程序的份额精度。
 *        Lending pool shares held in the internal raw units defined by the lending program.
 * @param suppliedValueRaw 供给份额对应的账面资产价值，单位为借款 Mint 最小单位。
 *        Book value of supplied shares in debt mint base units.
 * @param collateralRaw 当前托管抵押品的数量，单位为抵押 Mint 最小单位。
 *        Collateral held in custody, in collateral mint base units.
 * @param debtRaw 当前计息后的未偿债务，单位为借款 Mint 最小单位。
 *        Current outstanding debt with accrued interest, in debt mint base units.
 * @param healthFactor 无量纲健康度，展示精度为 12 位小数。无债务或需用的价格无效时为空。
 *        Dimensionless health factor displayed to 12 decimals. Null when debt is zero or a required price is unusable.
 * @param isLiquidatable 按完整精度评估的清算资格。无债务为 false，有债务但价格不可用时为空。
 *        Liquidation eligibility evaluated at full precision. False for zero debt and null if debt exists but its price input is unavailable.
 */
@TableName("lending_position_snapshot")
public record LendingPositionSnapshotDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "market_address", updateStrategy = FieldStrategy.NEVER) String marketAddress,
        @TableField(value = "wallet_address", updateStrategy = FieldStrategy.NEVER) String walletAddress,
        @TableField(value = "slot", updateStrategy = FieldStrategy.NEVER) BigInteger slot,
        @TableField("observed_at") OffsetDateTime observedAt,
        @TableField("oracle_slot") BigInteger oracleSlot,
        @TableField("supply_shares_raw") BigInteger supplySharesRaw,
        @TableField("supplied_value_raw") BigInteger suppliedValueRaw,
        @TableField("collateral_raw") BigInteger collateralRaw,
        @TableField("debt_raw") BigInteger debtRaw,
        @TableField("health_factor") BigDecimal healthFactor,
        @TableField("is_liquidatable") Boolean isLiquidatable
) {
}

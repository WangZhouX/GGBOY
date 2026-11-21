package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigInteger;
import java.time.OffsetDateTime;

/**
 * 金库在某一最终确认观测 slot 的估值、资金分布和赎回流动性。
 * Vault valuation, allocation and redemption liquidity at a finalized observation slot.
 *
 * <p>复合主键 / Composite primary key: {@code (network, vault_address, slot)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param vaultAddress 链上金库状态账户地址。
 *        On-chain vault state account address.
 * @param slot RPC 读取金库和估值输入所处的最终确认观测 slot。
 *        Finalized RPC observation slot of the vault and valuation inputs.
 * @param observedAt 索引器取得该快照的时间，API 统一输出 UTC。
 *        Time the indexer obtained the snapshot. The API emits UTC.
 * @param oracleSlot 使用的预言机发布 slot。未取得可用价格时为空。
 *        Publish slot of the oracle price used. Null when a usable price is unavailable.
 * @param cashRaw 金库持有的结算现金，单位为计价 Mint 最小单位。
 *        Cash held by the vault in base units of the quote mint.
 * @param strategyAmountRaw 金库持有的策略资产量，单位为策略 Mint 最小单位。
 *        Strategy assets held, in base units of the strategy mint.
 * @param strategyValueRaw 按有效预言机价格折算的策略资产价值，单位为计价 Mint 最小单位。需要价格且价格不可用时为空。
 *        Strategy value from a usable oracle price, in quote mint base units. Null when a required price is unavailable.
 * @param lendValueRaw 出借仓位账面价值，已反映计息和确认坏账，单位为计价 Mint 最小单位。
 *        Lending position book value after accrued interest and recognized bad debt, in quote mint base units.
 * @param lendingWithdrawableRaw 当前可从借贷池提取的金额，单位为计价 Mint 最小单位。
 *        Amount currently withdrawable from the lending pool, in quote mint base units.
 * @param navRaw 金库现金、策略估值和出借价值之和，单位为计价 Mint 最小单位。策略估值为空时为空。
 *        Sum of vault cash, strategy value and lending value in quote mint base units. Null if strategy value is unavailable.
 * @param totalSharesRaw 当前已发行的份额总量，单位为份额 Mint 最小单位。
 *        Current outstanding share supply in base units of the share mint.
 */
@TableName("vault_snapshot")
public record VaultSnapshotDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "vault_address", updateStrategy = FieldStrategy.NEVER) String vaultAddress,
        @TableField(value = "slot", updateStrategy = FieldStrategy.NEVER) BigInteger slot,
        @TableField("observed_at") OffsetDateTime observedAt,
        @TableField("oracle_slot") BigInteger oracleSlot,
        @TableField("cash_raw") BigInteger cashRaw,
        @TableField("strategy_amount_raw") BigInteger strategyAmountRaw,
        @TableField("strategy_value_raw") BigInteger strategyValueRaw,
        @TableField("lend_value_raw") BigInteger lendValueRaw,
        @TableField("lending_withdrawable_raw") BigInteger lendingWithdrawableRaw,
        @TableField("nav_raw") BigInteger navRaw,
        @TableField("total_shares_raw") BigInteger totalSharesRaw
) {

    /**
     * 提供 Lambda 查询使用的网络属性访问器，对应表中的 network。
     * Exposes the network property for lambda queries against the network column.
     *
     * @return 网络的小写协议值。 Lowercase network wire identifier.
     */
    public String getNetwork() {
        return network;
    }

    /**
     * 提供 Lambda 查询使用的金库地址访问器，对应 vault_address。
     * Exposes the vault address property for lambda queries against vault_address.
     *
     * @return 金库账户公钥。 Public key of the vault account.
     */
    public String getVaultAddress() {
        return vaultAddress;
    }

    /**
     * 提供 Lambda 排序使用的观测 slot 访问器，对应数值列 slot。
     * Exposes the observation slot for lambda ordering of the numeric slot column.
     *
     * @return 账户的最终确认观测 slot。 Finalized account observation slot.
     */
    public BigInteger getSlot() {
        return slot;
    }
}

package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigInteger;
import java.time.OffsetDateTime;

/**
 * 一个链上持有人在指定金库和观测 slot 的份额、估值和可赎回额度。
 * Shares, valuation and redeemable amount for one on-chain holder, vault and observation slot.
 *
 * <p>复合主键 / Composite primary key: {@code (network, vault_address, wallet_address, slot)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param vaultAddress 链上金库状态账户地址。
 *        On-chain vault state account address.
 * @param walletAddress 持有金库份额的链上账户所有者地址。
 *        On-chain owner address holding the vault shares.
 * @param slot RPC 读取该份额仓位与估值输入所处的最终确认观测 slot。
 *        Finalized RPC observation slot of the share position and valuation inputs.
 * @param observedAt 索引器取得该快照的时间，API 统一输出 UTC。
 *        Time the indexer obtained the snapshot. The API emits UTC.
 * @param sharesRaw 已持有的份额，单位为份额 Mint 最小单位。
 *        Shares held in base units of the share mint.
 * @param positionValueRaw 该持有人的份额价值，单位为计价 Mint 最小单位。需要估值且估值不可用时为空。
 *        Value of the shares in quote mint base units. Null when a required valuation is unavailable.
 * @param redeemableRaw 该持有人的当前可赎回额上限，单位为计价 Mint 最小单位。需要估值且估值不可用时为空。
 *        Current redemption value ceiling in quote mint base units. Null when a required valuation is unavailable.
 */
@TableName("vault_position_snapshot")
public record VaultPositionSnapshotDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "vault_address", updateStrategy = FieldStrategy.NEVER) String vaultAddress,
        @TableField(value = "wallet_address", updateStrategy = FieldStrategy.NEVER) String walletAddress,
        @TableField(value = "slot", updateStrategy = FieldStrategy.NEVER) BigInteger slot,
        @TableField("observed_at") OffsetDateTime observedAt,
        @TableField("shares_raw") BigInteger sharesRaw,
        @TableField("position_value_raw") BigInteger positionValueRaw,
        @TableField("redeemable_raw") BigInteger redeemableRaw
) {
}

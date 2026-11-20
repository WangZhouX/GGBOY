package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigInteger;
import java.time.OffsetDateTime;

/**
 * 风险规则命中的一条记录，保留触发它的借贷仓位快照。
 * A risk rule hit retaining the lending position snapshot that triggered it.
 *
 * <p>复合主键 / Composite primary key: {@code (network, market_address, wallet_address, slot, alert_type)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param marketAddress 链上借贷市场状态账户地址。
 *        On-chain lending market state account address.
 * @param walletAddress 被提示风险的借贷仓位所有者地址。
 *        Owner address of the lending position flagged by the rule.
 * @param slot 触发规则的借贷仓位快照观测 slot。
 *        Observation slot of the lending position snapshot that triggered the rule.
 * @param alertType 风险规则代码，当前为 LOW_HEALTH 或 LIQUIDATABLE。
 *        Risk rule code, currently LOW_HEALTH or LIQUIDATABLE.
 * @param createdAt 该规则命中首次记录的时间。
 *        Time this rule hit was first recorded.
 */
@TableName("risk_alert")
public record RiskAlertDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "market_address", updateStrategy = FieldStrategy.NEVER) String marketAddress,
        @TableField(value = "wallet_address", updateStrategy = FieldStrategy.NEVER) String walletAddress,
        @TableField(value = "slot", updateStrategy = FieldStrategy.NEVER) BigInteger slot,
        @TableField(value = "alert_type", updateStrategy = FieldStrategy.NEVER) String alertType,
        @TableField("created_at") OffsetDateTime createdAt
) {
}

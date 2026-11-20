package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigInteger;

/**
 * 事件中的一项实际资产变动，保存当时的 Mint 和精度。
 * One actual asset movement in an event, including its mint and precision at the time.
 *
 * <p>复合主键 / Composite primary key: {@code (network, signature, event_index, leg_index)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param signature Solana 交易主签名，Base58 编码。
 *        Primary Solana transaction signature in Base58.
 * @param eventIndex 事件在整笔交易日志中的零基稳定序号。
 *        Stable zero-based index of the event in the full transaction log.
 * @param legIndex 事件内的零基资产变动序号，由事件映射定义。
 *        Zero-based asset movement index within the event, defined by its mapping.
 * @param mintAddress 交易发生时的 SPL Token Mint 地址，包括份额 Mint。
 *        SPL token mint address at the time of the transaction, including share mints.
 * @param decimals 该 Mint 的小数位数，用于展示最小单位金额。
 *        Decimal precision of the mint, used to display base-unit amounts.
 * @param amountRaw 实际资产变动量，使用对应代币的最小单位。
 *        Actual amount moved in base units of the associated token.
 * @param legType 资产变动的业务语义。出入方向依据事件主体定义。
 *        Meaning of the asset movement. Direction is relative to the event subject.
 */
@TableName("chain_event_asset")
public record ChainEventAssetDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "signature", updateStrategy = FieldStrategy.NEVER) String signature,
        @TableField(value = "event_index", updateStrategy = FieldStrategy.NEVER) int eventIndex,
        @TableField(value = "leg_index", updateStrategy = FieldStrategy.NEVER) int legIndex,
        @TableField("mint_address") String mintAddress,
        @TableField("decimals") short decimals,
        @TableField("amount_raw") BigInteger amountRaw,
        @TableField("leg_type") String legType
) {
}

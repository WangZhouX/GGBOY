package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigInteger;

/**
 * 事件中的一项资产变动或坏账核销，保存当时的 Mint 和精度。
 * One asset movement or bad debt write-off in an event, including its mint and precision at the time.
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
 * @param amountRaw 转账或账面损失的金额，使用对应代币的最小单位。
 *        Amount transferred or written off in base units of the associated token.
 * @param legType 转账或核销的业务语义。BAD_DEBT 表示借款资产账面损失。
 *        Business meaning of the transfer or write-off. BAD_DEBT represents a book loss in the debt asset.
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

    /**
     * 提供 Lambda 查询使用的属性访问器，对应 {@code network}。
     * Exposes the property for Lambda queries against the {@code network} column.
     *
     * @return 网络的小写协议值。 Lowercase network wire identifier.
     */
    public String getNetwork() {
        return network;
    }

    /**
     * 提供 Lambda 查询使用的属性访问器，对应 {@code signature}。
     * Exposes the property for Lambda queries against the {@code signature} column.
     *
     * @return Base58 编码的交易主签名。 Primary transaction signature in Base58.
     */
    public String getSignature() {
        return signature;
    }

    /**
     * 提供 Lambda 查询使用的属性访问器，对应 {@code event_index}。
     * Exposes the property for Lambda queries against the {@code event_index} column.
     *
     * @return 事件在交易日志中的零基稳定序号。 Stable zero-based index of the event in the transaction log.
     */
    public int getEventIndex() {
        return eventIndex;
    }

    /**
     * 提供 Lambda 查询使用的属性访问器，对应 {@code leg_index}。
     * Exposes the property for Lambda queries against the {@code leg_index} column.
     *
     * @return 资产变动在该事件内的零基序号。 Zero-based index of the asset movement within the event.
     */
    public int getLegIndex() {
        return legIndex;
    }
}

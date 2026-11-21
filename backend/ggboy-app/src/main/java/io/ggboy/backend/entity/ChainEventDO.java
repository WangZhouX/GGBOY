package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 在一笔交易内发生的单个可展示业务事件。
 * One displayable business event within a transaction.
 *
 * <p>复合主键 / Composite primary key: {@code (network, signature, event_index)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param signature Solana 交易主签名，Base58 编码。
 *        Primary Solana transaction signature in Base58.
 * @param eventIndex 事件在整笔交易日志中的零基稳定序号。
 *        Stable zero-based index of the event in the full transaction log.
 * @param programId 该事件的来源程序 ID。
 *        Program ID that emitted the event.
 * @param module 事件所属领域，限 VAULT 或 LENDING。
 *        Business domain of the event, VAULT or LENDING.
 * @param eventType 稳定的业务动作代码，由索引映射维护。
 *        Stable business action code maintained by the indexer mapping.
 * @param subjectAddress 本业务事件对应的金库或借贷市场状态地址。
 *        Vault or lending market state address associated with this event.
 */
@TableName("chain_event")
public record ChainEventDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "signature", updateStrategy = FieldStrategy.NEVER) String signature,
        @TableField(value = "event_index", updateStrategy = FieldStrategy.NEVER) int eventIndex,
        @TableField("program_id") String programId,
        @TableField("module") String module,
        @TableField("event_type") String eventType,
        @TableField("subject_address") String subjectAddress
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
     * 提供 Lambda 查询使用的属性访问器，对应 {@code subject_address}。
     * Exposes the property for Lambda queries against the {@code subject_address} column.
     *
     * @return 本事件主体的状态账户公钥。 State account public key for the event subject.
     */
    public String getSubjectAddress() {
        return subjectAddress;
    }

    /**
     * 提供 Lambda 查询使用的属性访问器，对应 {@code event_type}。
     * Exposes the property for Lambda queries against the {@code event_type} column.
     *
     * @return 索引器使用的业务事件类型代码。 Business event type code used by the indexer.
     */
    public String getEventType() {
        return eventType;
    }
}

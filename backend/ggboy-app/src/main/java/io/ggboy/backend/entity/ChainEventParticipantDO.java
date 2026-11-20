package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 事件涉及的业务钱包或 PDA 及其角色，支持按任一参与方查询。
 * Business wallets or PDAs and their roles in an event, searchable by any participant.
 *
 * <p>复合主键 / Composite primary key: {@code (network, signature, event_index, wallet_address, role)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param signature Solana 交易主签名，Base58 编码。
 *        Primary Solana transaction signature in Base58.
 * @param eventIndex 事件在整笔交易日志中的零基稳定序号。
 *        Stable zero-based index of the event in the full transaction log.
 * @param walletAddress 参与业务的链上钱包或 PDA 地址。
 *        On-chain wallet or PDA participating in the business action.
 * @param role 当前事件内的参与角色，同一地址可具有多个角色。
 *        Participant role in this event. An address may have multiple roles.
 */
@TableName("chain_event_participant")
public record ChainEventParticipantDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "signature", updateStrategy = FieldStrategy.NEVER) String signature,
        @TableField(value = "event_index", updateStrategy = FieldStrategy.NEVER) int eventIndex,
        @TableField(value = "wallet_address", updateStrategy = FieldStrategy.NEVER) String walletAddress,
        @TableField(value = "role", updateStrategy = FieldStrategy.NEVER) String role
) {
}

package io.ggboy.backend.api;

import io.swagger.v3.oas.annotations.media.Schema;
import java.util.List;

/**
 * 可展示的一条链上业务事件，携带其父交易、完整参与方及资产变动。
 * One displayable on-chain business event with its parent transaction, participants, and asset changes.
 *
 * @param network 公共接口的链上网络标识。 Network wire identifier used by the public API.
 * @param signature 父交易的 Base58 主签名。 Parent transaction's primary Base58 signature.
 * @param eventIndex 事件在整笔交易中的零基索引。 Zero-based index of the event within the transaction.
 * @param slot 交易确认的链上 slot，以十进制整数字符串表示。 Confirmed on-chain slot as a decimal string.
 * @param blockTime UTC 区块时间，RPC 无值时为空。 UTC block timestamp, null if the RPC result has no value.
 * @param programId 发出事件的程序公钥。 Public key of the program that emitted the event.
 * @param module 事件所属业务模块。 Business module that owns the event.
 * @param type 稳定的事件业务类型代码。 Stable business event code.
 * @param subjectAddress 业务对应的金库或借贷市场状态账户。 Vault or lending market state account for the event.
 * @param participants 该事件的全部钱包和角色。 All wallets and roles associated with this event.
 * @param assets 该事件的所有实际资产变动，按变动索引升序。 All actual asset changes for the event in ascending leg order.
 */
public record ActivityResponse(
        String network,
        String signature,
        int eventIndex,
        String slot,
        String blockTime,
        String programId,
        String module,
        String type,
        String subjectAddress,
        List<Participant> participants,
        List<Asset> assets
) {

    /**
     * 固化已组装的事件明细，避免后续可变列表修改影响响应。
     * Snapshots the assembled event details so later list changes cannot alter the response.
     *
     * @param network 公开链上网络标识。 Public network wire identifier.
     * @param signature 父交易的 Base58 主签名。 Parent transaction's primary Base58 signature.
     * @param eventIndex 零基事件索引。 Zero-based event index.
     * @param slot 交易 slot 的十进制整数字符串。 Decimal string representing the transaction slot.
     * @param blockTime 可缺失的 UTC 区块时间。 UTC block timestamp, if available.
     * @param programId 来源程序公钥。 Source program public key.
     * @param module 事件所属业务模块。 Business module that owns the event.
     * @param type 稳定的业务事件代码。 Stable business event code.
     * @param subjectAddress 业务状态账户公钥。 Business state account public key.
     * @param participants 事件的参与方列表。 Event participant list.
     * @param assets 事件的资产变动列表。 Event asset change list.
     */
    public ActivityResponse {
        participants = List.copyOf(participants);
        assets = List.copyOf(assets);
    }

    /**
     * 事件中的一项参与身份，同一钱包可具有多种角色。
     * One participant identity in an event. A wallet can have more than one role.
     *
     * @param walletAddress 参与的 Solana 钱包或 PDA 公钥。 Public key of the participating Solana wallet or PDA.
     * @param role 稳定的业务角色代码。 Stable business role code.
     */
    public record Participant(String walletAddress, String role) {
    }

    /**
     * 一项可独立展示的资产变动，包含代币精度及业务语义。
     * One displayable asset change, including token precision and business meaning.
     *
     * @param legIndex 在该事件内的零基变动序号。 Zero-based asset leg index within the event.
     * @param mint 发生变动的 SPL Token Mint 公钥。 Public key of the SPL Token mint that changed.
     * @param decimals 交易发生时记录的 Mint 小数位数。 Mint decimals recorded at the time of the transaction.
     * @param amountRaw 变动最小单位数量，以十进制整数字符串表示。 Amount changed in base units as a decimal string.
     * @param legType 资产变动的稳定语义代码。 Stable code describing the asset change.
     * @param symbol 当前网络的 Mint 登记简称，未登记或未配置时为空。 Current network's registered mint symbol, or null when unavailable.
     */
    public record Asset(
            int legIndex, String mint, int decimals, String amountRaw, String legType,
            @Schema(nullable = true) String symbol
    ) {
    }
}

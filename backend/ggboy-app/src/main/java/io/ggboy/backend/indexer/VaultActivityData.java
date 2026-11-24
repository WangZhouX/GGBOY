package io.ggboy.backend.indexer;

import java.math.BigInteger;
import java.time.OffsetDateTime;
import java.util.List;

/**
 * 金库索引器在 RPC、日志解析与数据库之间交换的数据。
 * Data shared by the vault indexer's RPC, log decoder and persistence layer.
 */
final class VaultActivityData {

    /**
     * 仅组织索引器内部类型。
     * Prevents instantiation of this container for indexer types.
     */
    private VaultActivityData() {
    }

    /**
     * 一笔已最终确认的交易在程序历史中的位置。
     * The position of a finalized transaction in program history.
     *
     * @param value Base58 编码的交易主签名。 Base58-encoded primary transaction signature.
     * @param slot 成交 slot，保留无符号整数范围。 Landing slot with its unsigned range preserved.
     * @param failed 链上明确执行失败时为 true。 True when the chain reports an execution failure.
     */
    record Signature(String value, BigInteger slot, boolean failed) {
    }

    /**
     * 由 RPC 查到的成功交易及其完整运行时日志。
     * A successful transaction and its complete runtime logs fetched by RPC.
     *
     * @param signature 交易的签名及最终确认 slot。 Signature and finalized slot.
     * @param blockTime 链上区块时间（UTC），RPC 未提供时为空。 UTC block time, nullable when unavailable from RPC.
     * @param logs 按原始位置排列的日志。 Log entries in their original order.
     */
    record Transaction(Signature signature, OffsetDateTime blockTime, List<String> logs) {
    }

    /**
     * 已从金库程序的成功调用中解出的实际存入或赎回。
     * Actual deposit or redemption decoded from a successful vault program invocation.
     *
     * @param logIndex 事件的原始零基日志行号。 Original zero-based event log index.
     * @param vault 金库状态账户的 Base58 公钥。 Base58 vault state account key.
     * @param investor 投资者的 Base58 钱包公钥。 Base58 investor wallet key.
     * @param assetMint 结算资产 Mint 的 Base58 公钥。 Base58 settlement mint key.
     * @param shareMint 金库份额 Mint 的 Base58 公钥。 Base58 vault share mint key.
     * @param assetAmount 结算资产的实际转账量，以最小单位计。 Actual transfer in settlement base units.
     * @param shareAmount 份额的实际铸造或销毁量，以最小单位计。 Actual mint or burn in share base units.
     * @param action 存入或赎回。 Deposit or redemption.
     */
    record Event(
            int logIndex, String vault, String investor, String assetMint, String shareMint,
            BigInteger assetAmount, BigInteger shareAmount, Action action
    ) {
    }

    /**
     * 金库索引器当前识别的业务动作。
     * Business actions currently recognized by the vault indexer.
     */
    enum Action {
        /** 存入结算资产并铸造份额。 Deposits settlement assets and mints shares. */
        DEPOSIT,
        /** 销毁份额并收回结算资产。 Burns shares and receives settlement assets. */
        REDEEM
    }
}

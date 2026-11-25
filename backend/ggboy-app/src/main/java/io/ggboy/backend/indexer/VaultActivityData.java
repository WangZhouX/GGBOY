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
     * 金库程序成功调用发出的活动共用日志序号和金库地址。
     * Vault activities emitted by successful program invocations share a log index and vault address.
     */
    sealed interface VaultEvent permits Event, StrategyEvent {
        /**
         * 返回整笔交易中的零基原始日志行号。
         * Returns the zero-based original log index within the transaction.
         */
        int logIndex();

        /**
         * 返回活动所属金库 PDA 的 Base58 公钥。
         * Returns the Base58 public key of the vault PDA associated with this activity.
         */
        String vault();
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
    ) implements VaultEvent {
    }

    /**
     * 已从金库程序成功调用解出的管理者换币、出借或收回事件。
     * Manager swap, lending, or recall decoded from a successful vault program invocation.
     *
     * @param logIndex 原始零基日志行号。 Original zero-based log index.
     * @param vault 金库状态账户的 Base58 公钥。 Base58 vault state account key.
     * @param manager 签名策略管理者的 Base58 公钥。 Base58 key of the signing strategy manager.
     * @param action 确定资金变动方向的策略动作。 Strategy action determining the movement direction.
     * @param inputMint 换出的 Mint，出借和收回时为结算 Mint。 Swap output from custody, or the settlement mint for lending and recall.
     * @param outputMint 换入的 Mint，出借和收回时为结算 Mint。 Swap input into custody, or the settlement mint for lending and recall.
     * @param inputAmount 换出量，出借和收回时为实际转账量，按对应 Mint 最小单位计。 Swapped-out or transferred quantity in mint base units.
     * @param outputAmount 换入量，出借和收回时与输入量相同，按对应 Mint 最小单位计。 Swapped-in quantity in mint base units, identical to the input for lending and recall.
     */
    record StrategyEvent(
            int logIndex, String vault, String manager, StrategyAction action, String inputMint, String outputMint,
            BigInteger inputAmount, BigInteger outputAmount
    ) implements VaultEvent {
    }

    /**
     * 策略指令的固定业务类型。
     * Stable business actions emitted by strategy instructions.
     */
    enum StrategyAction {
        /** 在结算和策略资产之间换币。 Swaps between settlement and strategy assets. */
        SWAP,
        /** 将结算资产从金库转入借贷池。 Supplies settlement assets from the vault to the lending pool. */
        LEND,
        /** 将结算资产从借贷池收回金库。 Recalls settlement assets from the lending pool to the vault. */
        RECALL
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

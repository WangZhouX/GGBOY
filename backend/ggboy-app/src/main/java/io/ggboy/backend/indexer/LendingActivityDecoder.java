package io.ggboy.backend.indexer;

import io.ggboy.backend.indexer.AnchorTransactionLogs.RawEvent;
import io.ggboy.common.utils.SolanaAddressUtil;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;

/**
 * 从成功且最终确认的借贷交易提取 Anchor 借款、出借存取和清算事件。
 * Extracts Anchor borrowing, supply, withdrawal and liquidation events from finalized successful lending transactions.
 */
final class LendingActivityDecoder {

    /** 借贷程序 IDL 中 LendingBorrowAction 事件的八字节标识。 Eight-byte LendingBorrowAction discriminator in the lending program IDL. */
    private static final byte[] BORROW_ACTION_DISCRIMINATOR = HexFormat.of().parseHex("6de49f44dcdf88da");
    /** 借贷程序 IDL 中 LendingSupply 事件的八字节标识。 Eight-byte LendingSupply discriminator in the lending program IDL. */
    private static final byte[] SUPPLY_DEPOSIT_DISCRIMINATOR = HexFormat.of().parseHex("85a557c52c344682");
    /** 借贷程序 IDL 中 LendingSupplyWithdrawal 事件的八字节标识。 Eight-byte LendingSupplyWithdrawal discriminator in the lending program IDL. */
    private static final byte[] SUPPLY_WITHDRAWAL_DISCRIMINATOR = HexFormat.of().parseHex("dc547c71ab01e519");
    /** 借贷程序 IDL 中 LendingLiquidation 事件的八字节标识。 Eight-byte LendingLiquidation discriminator in the lending program IDL. */
    private static final byte[] LIQUIDATION_DISCRIMINATOR = HexFormat.of().parseHex("7118b671721ebfc3");
    /** Solana 公钥的原始字节数。 Raw byte length of a Solana public key. */
    private static final int PUBLIC_KEY_BYTES = 32;
    /** 固定 Borsh 布局包含标识、两个公钥、一个操作编号和三个 u64。 Fixed Borsh layout containing the discriminator, two keys, one action code, and three u64 values. */
    private static final int BORROW_ACTION_BYTES =
            BORROW_ACTION_DISCRIMINATOR.length + 2 * PUBLIC_KEY_BYTES + Byte.BYTES + 3 * Long.BYTES;

    /** 出借存入的 Borsh 布局含标识、三个公钥和两个 u64。 Deposit Borsh layout with a discriminator, three keys, and two u64 values. */
    private static final int SUPPLY_DEPOSIT_BYTES =
            SUPPLY_DEPOSIT_DISCRIMINATOR.length + 3 * PUBLIC_KEY_BYTES + 2 * Long.BYTES;

    /** 提取事件的 Borsh 布局包含标识、三个公钥和三个 u64。 Withdrawal Borsh layout containing the discriminator, three keys, and three u64 values. */
    private static final int SUPPLY_WITHDRAWAL_BYTES =
            SUPPLY_WITHDRAWAL_DISCRIMINATOR.length + 3 * PUBLIC_KEY_BYTES + 3 * Long.BYTES;

    /** 清算事件含标识、五个公钥和三个 u64 最小单位数量。 Liquidation layout has a discriminator, five keys, and three u64 base-unit quantities. */
    private static final int LIQUIDATION_BYTES =
            LIQUIDATION_DISCRIMINATOR.length + 5 * PUBLIC_KEY_BYTES + 3 * Long.BYTES;

    /** 解码器仅提供静态方法。 The decoder exposes only static methods. */
    private LendingActivityDecoder() {
    }

    /**
     * 仅解码已配置程序的顶层成功调用发出的受支持借贷事件。
     * Decodes supported lending events emitted by successful top-level calls to the configured program.
     *
     * @param programId 与待索引市场对应的借贷程序 Base58 公钥。 Base58 key of the lending program for indexed markets.
     * @param logs 来自已最终确认且成功的交易的完整有序日志。 Complete ordered logs from a finalized successful transaction.
     * @param signers 交易消息静态账户中已签名的钱包公钥。 Signing wallet keys from the transaction message's static accounts.
     * @return 按日志顺序排列的受支持事件，保留整笔交易原始日志行号。 Supported events in original log order, preserving transaction-wide line indexes.
     * @throws IllegalStateException 日志不完整，事件布局、金额或已知操作的签名人不一致。 Logs are incomplete or a known action has an invalid layout, amount, or signer.
     */
    static List<Event> decode(String programId, List<String> logs, Set<String> signers) {
        /** 在判断发出程序和调用深度之后，才检查候选项的 Borsh 数据。 Inspect candidate Borsh data only after verifying its emitter program and invocation depth. */
        List<RawEvent> candidates = AnchorTransactionLogs.scan(programId, logs, AnchorTransactionLogs.InvocationScope.TOP_LEVEL);
        List<Event> events = new ArrayList<>(candidates.size());
        for (RawEvent candidate : candidates) {
            /** 受支持的借贷事件。有其他数据时返回空并继续扫描。 A supported lending event, or null for unrelated data. */
            Event event = readEvent(candidate, signers);
            if (event != null) {
                events.add(event);
            }
        }
        return List.copyOf(events);
    }

    /**
     * 按 Anchor/Borsh 布局解码候选数据，保留 u64 金额全范围。
     * Decodes an Anchor/Borsh candidate while preserving the full u64 amount range.
     *
     * @param raw 目标程序的运行时数据及原始日志序号。 Target program data and its original log index.
     * @param signers 静态账户中的交易签名人。 Transaction signers from the static message accounts.
     * @return 受支持的借贷事件，数据标识或操作编号未使用时返回空。 Supported lending event, or null for an unrelated discriminator or unsupported action code.
     * @throws IllegalStateException 运行时数据无效，已知事件布局、金额或签名人不一致。 Invalid runtime data or a known event with invalid layout, amount, or signer.
     */
    private static Event readEvent(RawEvent raw, Set<String> signers) {
        // 运行时允许多字段数据，受支持的 Anchor 事件须由一段 Base64 组成。
        // Runtime data may contain multiple fields, but the supported Anchor events use one Base64 field.
        int separator = raw.encoded().indexOf(' ');
        String firstField = separator < 0 ? raw.encoded() : raw.encoded().substring(0, separator);
        byte[] data;
        try {
            data = Base64.getDecoder().decode(firstField);
        } catch (IllegalArgumentException malformed) {
            throw new IllegalStateException("Invalid Base64 lending data at log " + raw.logIndex(), malformed);
        }

        /** 识别支持的标识和对应布局长度，忽略其余程序数据。 Resolve accepted discriminators and layout lengths, ignoring other program data. */
        if (hasDiscriminator(data, BORROW_ACTION_DISCRIMINATOR)) {
            return readBorrowAction(raw.logIndex(), readBody(raw, data, separator, BORROW_ACTION_BYTES), signers);
        }
        if (hasDiscriminator(data, SUPPLY_DEPOSIT_DISCRIMINATOR)) {
            return readSupplyDeposit(raw.logIndex(), readBody(raw, data, separator, SUPPLY_DEPOSIT_BYTES), signers);
        }
        if (hasDiscriminator(data, SUPPLY_WITHDRAWAL_DISCRIMINATOR)) {
            return readSupplyWithdrawal(raw.logIndex(), readBody(raw, data, separator, SUPPLY_WITHDRAWAL_BYTES), signers);
        }
        if (hasDiscriminator(data, LIQUIDATION_DISCRIMINATOR)) {
            return readLiquidation(raw.logIndex(), readBody(raw, data, separator, LIQUIDATION_BYTES), signers);
        }
        return null;
    }

    /**
     * 核对已知事件的固定长度和字段数量，再定位 Borsh 主体。
     * Verifies a known event's fixed length and number of fields before locating the Borsh body.
     *
     * @param raw 保留日志行号的原始事件。 Raw event retaining its log index.
     * @param data 已进行 Base64 解码的原始数据。 Data decoded from Base64.
     * @param separator 第二段运行时数据的分隔位置，单字段时为 -1。 Second runtime data field separator, or -1 for a single field.
     * @param expectedBytes 对应事件的完整字节长度。 Exact byte length for the corresponding event.
     * @return 定位至小端 Borsh 主体的缓冲区。 Little-endian buffer positioned at the Borsh body.
     */
    private static ByteBuffer readBody(RawEvent raw, byte[] data, int separator, int expectedBytes) {
        if (separator >= 0 || data.length != expectedBytes) {
            throw new IllegalStateException("Invalid lending event layout at log " + raw.logIndex());
        }

        /** 事件标识均为八字节。公钥保持原始顺序，u64 金额按 Borsh 小端顺序读取。 All discriminators are eight bytes. Keys retain byte order and u64 amounts are little-endian. */
        int discriminatorBytes = BORROW_ACTION_DISCRIMINATOR.length;
        return ByteBuffer.wrap(data, discriminatorBytes, data.length - discriminatorBytes).order(ByteOrder.LITTLE_ENDIAN);
    }

    /**
     * 判断原始数据是否由指定的 Anchor 标识开头。
     * Checks whether the raw data starts with the given Anchor discriminator.
     *
     * @param data 解码后的原始运行时数据。 Decoded raw runtime data.
     * @param discriminator 事件定义对应的 Anchor 标识。 Anchor discriminator associated with the event definition.
     * @return 原始数据含该标识时为真。 True when the data starts with the discriminator.
     */
    private static boolean hasDiscriminator(byte[] data, byte[] discriminator) {
        return data.length >= discriminator.length
                && Arrays.equals(data, 0, discriminator.length, discriminator, 0, discriminator.length);
    }

    /**
     * 读取既有借款操作和执行后仓位。
     * Reads an existing borrowing action and its resulting position.
     *
     * @param logIndex 事件在原始交易日志中的零基序号。 Zero-based event position in the original transaction logs.
     * @param body 长度已核验的 Borsh 字段缓冲区。 Borsh field buffer with a verified length.
     * @param signers 静态账户中的交易签名人。 Transaction signers from the static message accounts.
     * @return 已知的借款操作或空值。 Known borrower action, or null for an unsupported action code.
     */
    private static BorrowerEvent readBorrowAction(int logIndex, ByteBuffer body, Set<String> signers) {
        /** 事件所属的市场和借款人公钥。 Market and borrower keys encoded in the event. */
        String market = readPublicKey(body);
        String borrower = readPublicKey(body);
        /** 链上借款事件中的单字节动作编号。 One-byte action code in the on-chain borrower event. */
        Action action = switch (Byte.toUnsignedInt(body.get())) {
            case 0 -> Action.DEPOSIT_COLLATERAL;
            case 1 -> Action.BORROW;
            case 2 -> Action.REPAY;
            case 3 -> Action.WITHDRAW_COLLATERAL;
            default -> null;
        };
        if (action == null) {
            return null;
        }

        requireSigner(logIndex, borrower, signers);
        /** 本次最小单位金额及操作后两项最小单位余额。 This transfer and both resulting balances in their respective base units. */
        BigInteger amountRaw = readUnsigned(body);
        BigInteger collateralRaw = readUnsigned(body);
        BigInteger debtRaw = readUnsigned(body);
        if (amountRaw.signum() == 0) {
            throw new IllegalStateException("Zero amount in lending event at log " + logIndex);
        }
        return new BorrowerEvent(logIndex, market, borrower, amountRaw, collateralRaw, debtRaw, action);
    }

    /**
     * 读取已转入资金池的代币和发给出借人的记账份额。
     * Reads tokens transferred into the pool and accounting shares credited to the supplier.
     *
     * @param logIndex 事件在原始交易日志中的零基序号。 Zero-based position in the original transaction logs.
     * @param body 长度已核验的 Borsh 字段缓冲区。 Borsh field buffer with a verified length.
     * @param signers 静态账户中的交易签名人。 Transaction signers from the static message accounts.
     * @return 已核对出借人签名和正数出借资产、份额的事件。 Event with a verified supplier signature and positive assets and shares.
     */
    private static SupplyDepositEvent readSupplyDeposit(int logIndex, ByteBuffer body, Set<String> signers) {
        /** 市场、签名出借人和入池代币 Mint 的链上公钥。 On-chain keys of the market, signing supplier, and deposited mint. */
        String market = readPublicKey(body);
        String supplier = readPublicKey(body);
        String debtMint = readPublicKey(body);
        requireSigner(logIndex, supplier, signers);

        /** 实际入池资产和新增出借份额使用各自的最小单位。 Actual deposit and issued shares in their respective base units. */
        BigInteger amountRaw = readUnsigned(body);
        BigInteger sharesIssuedRaw = readUnsigned(body);
        if (amountRaw.signum() == 0 || sharesIssuedRaw.signum() == 0) {
            throw new IllegalStateException("Zero assets or shares in lending deposit at log " + logIndex);
        }
        return new SupplyDepositEvent(logIndex, market, supplier, debtMint, amountRaw, sharesIssuedRaw);
    }

    /**
     * 读取出借人提取的份额、实际到账和剩余份额。
     * Reads burned shares, actual payout, and remaining shares for a supplier withdrawal.
     *
     * @param logIndex 事件在原始交易日志中的零基序号。 Zero-based event position in the original transaction logs.
     * @param body 长度已核验的 Borsh 字段缓冲区。 Borsh field buffer with a verified length.
     * @param signers 静态账户中的交易签名人。 Transaction signers from the static message accounts.
     * @return 已核对出借人签名和正数提取金额的事件。 Event with a verified supplier signature and positive withdrawal.
     */
    private static SupplyWithdrawalEvent readSupplyWithdrawal(int logIndex, ByteBuffer body, Set<String> signers) {
        /** 市场、签名出借人和付款代币 Mint 的链上公钥。 On-chain keys of the market, signing supplier, and payout mint. */
        String market = readPublicKey(body);
        String supplier = readPublicKey(body);
        String debtMint = readPublicKey(body);
        requireSigner(logIndex, supplier, signers);

        /** 份额扣减量、已支付资产和剩余份额分别使用各自的最小单位。 Burned shares, paid assets, and remaining shares in their respective base units. */
        BigInteger sharesBurnedRaw = readUnsigned(body);
        BigInteger amountRaw = readUnsigned(body);
        BigInteger remainingSharesRaw = readUnsigned(body);
        if (sharesBurnedRaw.signum() == 0 || amountRaw.signum() == 0) {
            throw new IllegalStateException("Zero shares or payout in lending withdrawal at log " + logIndex);
        }
        return new SupplyWithdrawalEvent(logIndex, market, supplier, debtMint, sharesBurnedRaw, amountRaw, remainingSharesRaw);
    }

    /**
     * 读取清算人代偿、抵押品划转及坏账核销的实际数量。
     * Reads the actual repayment, seized collateral, and bad debt written off.
     *
     * @param logIndex 整笔交易原始的零基日志行号。 Original zero-based log index in the full transaction.
     * @param body 长度已核验的 Borsh 字段缓冲区。 Borsh field buffer with verified length.
     * @param signers 静态账户中的交易签名人。 Transaction signers from the static message accounts.
     * @return 已核对清算角色、签名及金额关系的事件。 Event with validated liquidation roles, signer, and amount relationships.
     */
    private static LiquidationEvent readLiquidation(int logIndex, ByteBuffer body, Set<String> signers) {
        /** 依 Borsh 顺序读取市场、双方与两个 Mint 公钥。 Read market, participants, and mints in Borsh order. */
        String market = readPublicKey(body);
        String borrower = readPublicKey(body);
        String liquidator = readPublicKey(body);
        String debtMint = readPublicKey(body);
        String collateralMint = readPublicKey(body);
        requireSigner(logIndex, liquidator, signers);
        if (liquidator.equals(borrower) || debtMint.equals(collateralMint)) {
            throw new IllegalStateException("Identical participants or mints in lending liquidation at log " + logIndex);
        }

        /** 代偿和坏账按借款 Mint 最小单位计，划转抵押品按抵押 Mint 最小单位计。 Repayment and write-off use debt mint base units, and seized collateral uses collateral mint base units. */
        BigInteger repaidRaw = readUnsigned(body);
        BigInteger seizedCollateralRaw = readUnsigned(body);
        BigInteger badDebtRaw = readUnsigned(body);
        // 代偿与领回抵押品必须成对。两者皆零时仅接受有坏账核销的事件。
        // Repayment and collateral seizure must occur together. If both are zero, a positive bad debt write-off is required.
        boolean hasRepayment = repaidRaw.signum() > 0;
        if (hasRepayment != (seizedCollateralRaw.signum() > 0) || (!hasRepayment && badDebtRaw.signum() == 0)) {
            throw new IllegalStateException("Invalid amounts in lending liquidation at log " + logIndex);
        }
        return new LiquidationEvent(logIndex, market, borrower, liquidator, debtMint, collateralMint,
                repaidRaw, seizedCollateralRaw, badDebtRaw);
    }

    /**
     * 核对钱包属于交易静态签名账户，确保活动匹配实际操作者。
     * Verifies that the wallet is a static transaction signer so the activity identifies the actual actor.
     *
     * @param logIndex 事件在原始交易日志中的零基序号。 Zero-based event position in the original transaction logs.
     * @param wallet 发起链上操作的钱包。 Wallet authorizing the on-chain operation.
     * @param signers 静态账户中的交易签名人。 Transaction signers from the static message accounts.
     * @throws IllegalStateException 事件钱包未签名。 The event wallet did not sign.
     */
    private static void requireSigner(int logIndex, String wallet, Set<String> signers) {
        if (!signers.contains(wallet)) {
            throw new IllegalStateException("Lending event wallet did not sign at log " + logIndex);
        }
    }

    /**
     * 无损读取小端 Borsh u64。
     * Reads a little-endian Borsh u64 without losing precision.
     *
     * @param body 长度已核验的字段缓冲区。 Field buffer with a verified length.
     * @return 无符号最小单位数量。 Unsigned base-unit quantity.
     */
    private static BigInteger readUnsigned(ByteBuffer body) {
        return new BigInteger(Long.toUnsignedString(body.getLong()));
    }

    /**
     * 按当前 Borsh 读位置读取并编码 Solana 公钥。
     * Reads and encodes a Solana public key at the current Borsh position.
     *
     * @param body 长度已核验的 Borsh 字段缓冲区。 Borsh field buffer with a verified length.
     * @return 保留前导零的规范 Base58 公钥。 Canonical Base58 public key preserving leading zeros.
     */
    private static String readPublicKey(ByteBuffer body) {
        /** 原始 32 字节账户地址。 Raw 32-byte account key. */
        byte[] bytes = new byte[PUBLIC_KEY_BYTES];
        body.get(bytes);
        return SolanaAddressUtil.encodePublicKey(bytes);
    }

    /**
     * 借贷交易写入既有活动类型和资产动向使用的值。
     * Lending action values for the existing activity types and asset movements.
     */
    enum Action {
        /** 借款人将抵押品转入市场。 The borrower transfers collateral into the market. */
        DEPOSIT_COLLATERAL("LENDING_DEPOSIT_COLLATERAL", "ASSET_IN", true, "BORROWER"),
        /** 市场向借款人转出借款资产。 The market transfers loan assets to the borrower. */
        BORROW("LENDING_BORROW", "ASSET_OUT", false, "BORROWER"),
        /** 借款人偿还借款资产本金。 The borrower repays principal in the debt asset. */
        REPAY("LENDING_REPAY", "DEBT_REPAID", false, "BORROWER"),
        /** 市场将抵押品转回借款人。 The market returns collateral to the borrower. */
        WITHDRAW_COLLATERAL("LENDING_WITHDRAW_COLLATERAL", "ASSET_OUT", true, "BORROWER"),
        /** 出借人向池内转入借款资产，领取记账份额。 The supplier transfers debt assets into the pool and receives accounting shares. */
        SUPPLY("LENDING_SUPPLY", "ASSET_IN", false, "SUPPLIER"),
        /** 资金池把对应份额的借款资产支付给出借人。 The pool pays debt assets to the supplier for the withdrawn shares. */
        WITHDRAW_SUPPLY("LENDING_WITHDRAW_SUPPLY", "ASSET_OUT", false, "SUPPLIER");

        /** 交易活动列表和回执中的稳定类型代码。 Stable type code used in the activity list and receipt. */
        private final String eventType;
        /** 以借贷市场为参照的资产动向代码。 Asset leg code from the lending market's perspective. */
        private final String movement;
        /** 操作金额是否按市场的抵押 Mint 计。 Whether the action amount uses the market's collateral mint. */
        private final boolean usesCollateralMint;
        /** 经交易签名验证的钱包业务角色。 Role of the wallet verified against transaction signers. */
        private final String participantRole;

        /**
         * 绑定活动类型、资金方向和金额所属的 Mint 角色。
         * Binds the activity type, direction, and mint role for the transfer amount.
         *
         * @param eventType API 活动类型代码。 API activity type code.
         * @param movement 市场侧资产动向。 Asset movement from the market's perspective.
         * @param usesCollateralMint 为 true 时使用抵押 Mint，否则使用借款 Mint。 True for collateral mint, false for debt mint.
         * @param participantRole 交易活动中的借款人或出借人角色代码。 Borrower or supplier role code in transaction activity.
         */
        Action(String eventType, String movement, boolean usesCollateralMint, String participantRole) {
            this.eventType = eventType;
            this.movement = movement;
            this.usesCollateralMint = usesCollateralMint;
            this.participantRole = participantRole;
        }

        /** @return 活动列表和回执中的类型代码。 Type code used in the activity list and receipt. */
        String eventType() {
            return eventType;
        }

        /** @return 已有资产动向的数据库代码。 Existing database code for the asset movement. */
        String movement() {
            return movement;
        }

        /** @return 为 true 时金额使用抵押 Mint，否则使用借款 Mint。 True if the amount uses the collateral mint, false for the debt mint. */
        boolean usesCollateralMint() {
            return usesCollateralMint;
        }

        /** @return 业务参与方角色代码。 Business participant role code. */
        String participantRole() {
            return participantRole;
        }
    }

    /** 不同借贷链上事件共有的交易活动字段。 Transaction activity fields shared by on-chain lending events. */
    sealed interface Event permits SinglePartyEvent, LiquidationEvent {
        /** @return 整笔交易原始零基日志序号。 Original zero-based transaction log index. */
        int logIndex();

        /** @return 事件的市场状态账户公钥。 Market state account key from the event. */
        String market();
    }

    /** 单一钱包发起且只有一种实际转账的借款或出借事件。 Borrow or supply actions with a single wallet and one actual transfer. */
    sealed interface SinglePartyEvent extends Event permits BorrowerEvent, SupplyEvent {
        /** @return 已经核对交易签名的事件钱包公钥。 Event wallet key verified against transaction signers. */
        String wallet();

        /** @return 实际转账的代币最小单位数量。 Actual transfer amount in token base units. */
        BigInteger amountRaw();

        /** @return 事件对应的业务操作。 Business action corresponding to the event. */
        Action action();
    }

    /**
     * 已核对的链上借款人操作和执行后仓位。
     * Verified on-chain borrower action and the resulting position.
     *
     * @param logIndex 整笔交易原始零基日志序号，同一签名下稳定。 Original zero-based transaction-wide log index, stable within a signature.
     * @param market 事件中的市场状态账户 Base58 公钥，由持久化层核对登记。 Base58 market state account key from the event, to be matched against the registry by storage.
     * @param wallet 已验证为交易签名人的借款人 Base58 公钥。 Borrower's Base58 wallet key, verified as a transaction signer.
     * @param amountRaw 本次实际转移以相应 Mint 最小单位计的 u64 金额。 Actual u64 transfer amount in the relevant mint's base units.
     * @param collateralRaw 操作后锁定抵押品，以抵押 Mint 最小单位计。 Post-action collateral balance in collateral mint base units.
     * @param debtRaw 操作后未偿本金，以借款 Mint 最小单位计。 Post-action outstanding principal in debt mint base units.
     * @param action 借款人的业务操作。 Business action taken by the borrower.
     */
    record BorrowerEvent(
            int logIndex, String market, String wallet, BigInteger amountRaw, BigInteger collateralRaw,
            BigInteger debtRaw, Action action
    ) implements SinglePartyEvent {
    }

    /** 出借存入与提取明确记录实际转账的借款 Mint。 Both supply and withdrawal events identify the debt mint actually transferred. */
    sealed interface SupplyEvent extends SinglePartyEvent permits SupplyDepositEvent, SupplyWithdrawalEvent {
        /** @return 链上事件中的实际借款 Mint。 Actual debt mint recorded on-chain. */
        String debtMint();
    }

    /**
     * 已核对的链上出借存入。
     * Verified on-chain supply deposit.
     *
     * @param logIndex 整笔交易原始零基日志序号。 Original zero-based transaction log index.
     * @param market 事件的市场状态账户公钥。 Market state account key from the event.
     * @param wallet 已核对交易签名的出借人公钥。 Supplier key verified against transaction signers.
     * @param debtMint 实际存入的代币 Mint。 Mint of the tokens deposited into the pool.
     * @param amountRaw 实际存入的借款代币最小单位数。 Actual deposit amount in debt mint base units.
     * @param sharesIssuedRaw 发放的六位小数出借份额最小单位数。 Issued supply shares in six-decimal base units.
     */
    record SupplyDepositEvent(
            int logIndex, String market, String wallet, String debtMint, BigInteger amountRaw, BigInteger sharesIssuedRaw
    ) implements SupplyEvent {

        /** @return 对应的出借存入操作。 The supply deposit action. */
        @Override
        public Action action() {
            return Action.SUPPLY;
        }
    }

    /**
     * 已核对的链上出借资金提取。
     * Verified on-chain withdrawal of supplied funds.
     *
     * @param logIndex 整笔交易原始零基日志序号。 Original zero-based transaction log index.
     * @param market 事件的市场状态账户公钥。 Market state account key from the event.
     * @param wallet 已验证为交易签名人的出借人公钥。 Supplier wallet key verified as a transaction signer.
     * @param debtMint 实际付款使用的代币 Mint。 Token mint used for the actual payout.
     * @param sharesBurnedRaw 以六位小数份额最小单位计的实际扣减量。 Actual share amount burned in six-decimal share base units.
     * @param amountRaw 以付款代币最小单位计的实际到账量。 Actual payout amount in the debt mint's base units.
     * @param remainingSharesRaw 以六位小数份额最小单位计的剩余份额。 Remaining shares in six-decimal share base units.
     */
    record SupplyWithdrawalEvent(
            int logIndex, String market, String wallet, String debtMint, BigInteger sharesBurnedRaw,
            BigInteger amountRaw, BigInteger remainingSharesRaw
    ) implements SupplyEvent {

        /** @return 对应的资金提取操作。 The supplied-funds withdrawal action. */
        @Override
        public Action action() {
            return Action.WITHDRAW_SUPPLY;
        }
    }

    /**
     * 已核对的清算和坏账核销事件。
     * Verified liquidation and bad debt write-off.
     *
     * @param logIndex 原始的零基日志行号。 Original zero-based log index.
     * @param market 事件市场 PDA。 Market PDA from the event.
     * @param borrower 被清算的借款人，可不参与签名。 Borrower being liquidated, who need not sign.
     * @param liquidator 已核对交易签名的清算人。 Liquidator verified against transaction signers.
     * @param debtMint 代偿及坏账使用的借款 Mint。 Debt mint for repayment and write-off.
     * @param collateralMint 被划转的抵押品 Mint。 Mint of the collateral transferred.
     * @param repaidRaw 实际代偿的借款代币最小单位数。 Debt tokens actually repaid in base units.
     * @param seizedCollateralRaw 实际划转的抵押品最小单位数。 Collateral seized in base units.
     * @param badDebtRaw 已核销债务的借款代币最小单位数。 Debt written off in the debt mint's base units.
     */
    record LiquidationEvent(
            int logIndex, String market, String borrower, String liquidator, String debtMint, String collateralMint,
            BigInteger repaidRaw, BigInteger seizedCollateralRaw, BigInteger badDebtRaw
    ) implements Event {
    }
}

package io.ggboy.backend.indexer;

import io.ggboy.backend.indexer.LendingActivityDecoder.Action;
import io.ggboy.backend.indexer.LendingActivityDecoder.BorrowerEvent;
import io.ggboy.backend.indexer.LendingActivityDecoder.Event;
import io.ggboy.backend.indexer.LendingActivityDecoder.SupplyDepositEvent;
import io.ggboy.backend.indexer.LendingActivityDecoder.SupplyWithdrawalEvent;
import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * 使用 Devnet 已最终确认的数据和独立边界样例校验借贷日志解码。
 * Verifies lending log decoding with finalized Devnet data and independent boundary fixtures.
 */
class LendingActivityDecoderTest {

    /** 已部署借贷程序、测试市场、借款人，以及用于对照调用的 SPL Token 程序公钥。 Public keys of the deployed lending program, demo market, borrower, and SPL Token program used as the non-lending caller. */
    private static final String PROGRAM = "8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H";
    private static final String MARKET = "HzzMy19zYvQ6ZKfEgeMwuin3eMp8RFBWeRar9vzncUvE";
    private static final String BORROWER = "3NbZGiBAjEhif52ATFw7NovqBuU4oCUySQjWsZ9adqCw";
    private static final String EXTERNAL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    /** 从 Devnet 抵押、借款、部分还款和取回交易直接提取的真实事件数据。 Original event data from the confirmed Devnet collateral, borrow, partial repayment, and withdrawal transactions. */
    private static final String COLLATERAL = "beSfRNzfiNr8lfStEB1ermgiJTU7YDIBEs+0Lz2JHO068cKn9iyBAyM/pNV/WCtzgD0Hsxt7dEj7jV44LFOc0QzGBTGSnr0kAADKmjsAAAAAAMqaOwAAAAAAAAAAAAAAAA==";
    private static final String BORROW = "beSfRNzfiNr8lfStEB1ermgiJTU7YDIBEs+0Lz2JHO068cKn9iyBAyM/pNV/WCtzgD0Hsxt7dEj7jV44LFOc0QzGBTGSnr0kAUB4fQEAAAAAAMqaOwAAAABAeH0BAAAAAA==";
    private static final String REPAY = "beSfRNzfiNr8lfStEB1ermgiJTU7YDIBEs+0Lz2JHO068cKn9iyBAyM/pNV/WCtzgD0Hsxt7dEj7jV44LFOc0QzGBTGSnr0kAoCWmAAAAAAAAMqaOwAAAADA4eQAAAAAAA==";
    private static final String WITHDRAW = "beSfRNzfiNr8lfStEB1ermgiJTU7YDIBEs+0Lz2JHO068cKn9iyBAyM/pNV/WCtzgD0Hsxt7dEj7jV44LFOc0QzGBTGSnr0kAwDKmjsAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    /** 提取测试样例按新事件 Borsh 布局独立生成，使用真实市场的 mockUSDC Mint。 Withdrawal fixture generated independently from the new Borsh layout using the registered mockUSDC mint. */
    private static final String DEBT_MINT = "62vB22oh8fjXtitpKX3nLKyk9J7CVKb4ueKZcDGP1o1X";
    private static final String SUPPLY_WITHDRAWAL = "3FR8casB5Rn8lfStEB1ermgiJTU7YDIBEs+0Lz2JHO068cKn9iyBAyM/pNV/WCtzgD0Hsxt7dEj7jV44LFOc0QzGBTGSnr0kSsgjVcLp/NEmGWJiz4gHlIxRkD+sqwW2gOk5p+bf8taAhB4AAAAAAGDjFgAAAAAAQEtMAAAAAAA=";
    /** 与提取金额和份额顺序不同的出借存入样例。 Supply deposit fixture with a different amount and shares ordering than withdrawal. */
    private static final String SUPPLY_DEPOSIT = "haVXxSw0RoL8lfStEB1ermgiJTU7YDIBEs+0Lz2JHO068cKn9iyBAyM/pNV/WCtzgD0Hsxt7dEj7jV44LFOc0QzGBTGSnr0kSsgjVcLp/NEmGWJiz4gHlIxRkD+sqwW2gOk5p+bf8tZg4xYAAAAAAICEHgAAAAAA";
    /** 1 tSOL 对应 9 位小数的最小单位数。 One tSOL in base units with nine decimal places. */
    private static final long ONE_TSOL_RAW = 1_000_000_000L;

    /** 核验真实金额、余额、日志序号和既有数据库映射。 Verifies actual amounts, balances, log indexes, and existing database mappings. */
    @Test
    void decodesFinalizedDevnetBorrowerActions() {
        assertDevnetLog(COLLATERAL, 7, Action.DEPOSIT_COLLATERAL, ONE_TSOL_RAW, ONE_TSOL_RAW, 0);
        assertDevnetLog(BORROW, 24, Action.BORROW, 25_000_000L, ONE_TSOL_RAW, 25_000_000L);
        assertDevnetLog(REPAY, 5, Action.REPAY, 10_000_000L, ONE_TSOL_RAW, 15_000_000L);
        assertDevnetLog(WITHDRAW, 9, Action.WITHDRAW_COLLATERAL, ONE_TSOL_RAW, 0, 0);

        assertEquals("LENDING_DEPOSIT_COLLATERAL", Action.DEPOSIT_COLLATERAL.eventType());
        assertEquals("LENDING_BORROW", Action.BORROW.eventType());
        assertEquals("LENDING_REPAY", Action.REPAY.eventType());
        assertEquals("LENDING_WITHDRAW_COLLATERAL", Action.WITHDRAW_COLLATERAL.eventType());
        assertEquals(List.of("ASSET_IN", "ASSET_OUT", "DEBT_REPAID", "ASSET_OUT"),
                List.of(Action.DEPOSIT_COLLATERAL, Action.BORROW, Action.REPAY, Action.WITHDRAW_COLLATERAL)
                        .stream().map(Action::movement).toList());
        assertEquals(List.of(true, false, false, true),
                List.of(Action.DEPOSIT_COLLATERAL, Action.BORROW, Action.REPAY, Action.WITHDRAW_COLLATERAL)
                        .stream().map(Action::usesCollateralMint).toList());
    }

    /** 同一交易只接受目标程序成功顶层调用的原始数据，保留各动作区别。 Only accepts runtime data from the target program's successful top-level calls while keeping events distinct within one signature. */
    @Test
    void indexesOnlySuccessfulTopLevelBorrowerActions() {
        /** 依次放入其他程序、CPI、失败调用、普通文本、其他事件、未知操作，再放入两个有效事件。 Other programs, CPI, failure, ordinary text, unrelated events, and an unsupported action precede two valid events. */
        List<String> logs = List.of(
                "Program " + EXTERNAL + " invoke [1]",
                "Program data: " + COLLATERAL,
                "Program " + PROGRAM + " invoke [2]",
                "Program data: " + BORROW,
                "Program " + PROGRAM + " success",
                "Program " + EXTERNAL + " success",
                "Program " + PROGRAM + " invoke [1]",
                "Program data: " + REPAY,
                "Program " + PROGRAM + " failed: custom program error: 0x1",
                "Program " + PROGRAM + " invoke [1]",
                "Program log: Program data: " + WITHDRAW,
                "Program data: aGVsbG8= d29ybGQ=",
                "Program data: " + encodedFixture(4, 1),
                "Program data: " + COLLATERAL,
                "Program " + PROGRAM + " success",
                "Program " + PROGRAM + " invoke [1]",
                "Program data: " + BORROW,
                "Program " + PROGRAM + " success");
        assertEquals(List.of(13, 16), LendingActivityDecoder.decode(PROGRAM, logs, Set.of(BORROWER))
                .stream().map(Event::logIndex).toList());
    }

    /** 同笔交易中区分出借存入、提取和借款，保持回执序号稳定。 Distinguishes supply deposit, withdrawal, and borrowing within one transaction while preserving receipt indexes. */
    @Test
    void indexesSupplyDepositAndWithdrawalAlongsideBorrowing() {
        /** 一条交易依次触发三种不同活动。 One transaction emits three distinct activities. */
        List<String> logs = List.of(
                "Program " + PROGRAM + " invoke [1]",
                "Program data: " + SUPPLY_DEPOSIT,
                "Program " + PROGRAM + " success",
                "Program " + PROGRAM + " invoke [1]",
                "Program data: " + SUPPLY_WITHDRAWAL,
                "Program " + PROGRAM + " success",
                "Program " + PROGRAM + " invoke [1]",
                "Program data: " + BORROW,
                "Program " + PROGRAM + " success");
        /** 已核验的三条活动，按原始日志序号排列。 Three verified activities in their original log order. */
        List<Event> events = LendingActivityDecoder.decode(PROGRAM, logs, Set.of(BORROWER));
        assertEquals(List.of(1, 4, 7), events.stream().map(Event::logIndex).toList());
        /** 出借实际入池金额先于新增份额，方向为转入。 The actual deposit precedes credited shares and the movement flows into the pool. */
        SupplyDepositEvent deposit = assertInstanceOf(SupplyDepositEvent.class, events.getFirst());
        assertEquals(new SupplyDepositEvent(1, MARKET, BORROWER, DEBT_MINT, BigInteger.valueOf(1_500_000),
                BigInteger.valueOf(2_000_000)), deposit);
        assertEquals("LENDING_SUPPLY", deposit.action().eventType());
        assertEquals("SUPPLIER", deposit.action().participantRole());
        assertEquals("ASSET_IN", deposit.action().movement());
        assertEquals(false, deposit.action().usesCollateralMint());
        /** 同一签名者在不同事件中具有独立的业务角色。 A single signer can have different roles in separate events. */
        SupplyWithdrawalEvent withdrawal = assertInstanceOf(SupplyWithdrawalEvent.class, events.get(1));
        assertEquals(new SupplyWithdrawalEvent(4, MARKET, BORROWER, DEBT_MINT, BigInteger.valueOf(2_000_000),
                BigInteger.valueOf(1_500_000), BigInteger.valueOf(5_000_000)), withdrawal);
        assertEquals("LENDING_WITHDRAW_SUPPLY", withdrawal.action().eventType());
        assertEquals("SUPPLIER", withdrawal.action().participantRole());
        assertEquals("ASSET_OUT", withdrawal.action().movement());
        assertEquals(false, withdrawal.action().usesCollateralMint());
        assertEquals("BORROWER", assertInstanceOf(BorrowerEvent.class, events.getLast()).action().participantRole());
    }

    /** 金库 CPI 以及失败的出借不产生普通钱包的出借活动。 Vault CPI and reverted calls do not produce ordinary wallet supply activities. */
    @Test
    void skipsNestedAndRevertedSupplyDeposits() {
        /** 金库包裹一次 CPI 出借，随后模拟失败再成功的顶层调用。 A vault wraps one supply CPI, followed by failed and successful top-level fixtures. */
        List<String> logs = List.of(
                "Program " + EXTERNAL + " invoke [1]",
                "Program " + PROGRAM + " invoke [2]",
                "Program data: " + SUPPLY_DEPOSIT,
                "Program " + PROGRAM + " success",
                "Program " + EXTERNAL + " success",
                "Program " + PROGRAM + " invoke [1]",
                "Program data: " + SUPPLY_DEPOSIT,
                "Program " + PROGRAM + " failed: custom program error: 0x1",
                "Program " + PROGRAM + " invoke [1]",
                "Program data: " + SUPPLY_DEPOSIT,
                "Program " + PROGRAM + " success");
        assertEquals(List.of(9), LendingActivityDecoder.decode(PROGRAM, logs, Set.of(BORROWER))
                .stream().map(Event::logIndex).toList());
    }

    /** 存入事件严格验证签名、长度和非零数量，金额无符号读取。 Deposit verifies signer, exact length, and positive amounts while preserving unsigned values. */
    @Test
    void rejectsInvalidSupplyDepositsAndRetainsUnsignedAmount() {
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(SUPPLY_DEPOSIT), Set.of(EXTERNAL)));
        /** 固定布局中入池资产和新增份额位于 104 和 112 字节。 Deposit and credited shares start at byte offsets 104 and 112. */
        byte[] data = Base64.getDecoder().decode(SUPPLY_DEPOSIT);
        assertThrows(IllegalStateException.class, () -> LendingActivityDecoder.decode(PROGRAM,
                topLevelLogs(Base64.getEncoder().encodeToString(Arrays.copyOf(data, data.length - 1))), Set.of(BORROWER)));
        /** 分别测试零入池额、零份额及最大的有效 u64 入池额。 Test zero assets, zero shares, and the maximum valid u64 deposited amount. */
        ByteBuffer fields = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        fields.putLong(104, 0L);
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(Base64.getEncoder().encodeToString(data)), Set.of(BORROWER)));
        fields.putLong(104, -1L).putLong(112, 0L);
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(Base64.getEncoder().encodeToString(data)), Set.of(BORROWER)));
        fields.putLong(112, 1L);
        /** 最大 u64 保持为正十进制整数。 The maximum u64 remains an exact positive decimal integer. */
        SupplyDepositEvent event = assertInstanceOf(SupplyDepositEvent.class, LendingActivityDecoder.decode(PROGRAM,
                topLevelLogs(Base64.getEncoder().encodeToString(data)), Set.of(BORROWER)).getFirst());
        assertEquals(new BigInteger("18446744073709551615"), event.amountRaw());
    }

    /** 提取事件拒绝无签名、布局截断或零金额，并保留最大无符号到账量。 Withdrawal rejects unsigned, truncated, or zero-payout data and preserves the largest unsigned payout. */
    @Test
    void rejectsInvalidSupplyWithdrawalsAndRetainsUnsignedPayout() {
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(SUPPLY_WITHDRAWAL), Set.of(EXTERNAL)));
        /** 此提取样例的到账量位于第 112 个字节，紧随扣减份额。 The fixture's payout starts at byte offset 112, immediately after burned shares. */
        byte[] data = Base64.getDecoder().decode(SUPPLY_WITHDRAWAL);
        /** 保留标识但截断一个字节，用于校验对已知事件布局的严格检查。 Keep the discriminator and truncate one byte to exercise strict layout checks. */
        String shortened = Base64.getEncoder().encodeToString(Arrays.copyOf(data, data.length - 1));
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(shortened), Set.of(BORROWER)));

        /** 先写入零到账量，再写入全一位模式，覆盖无符号边界。 Write zero and then all bits set to exercise unsigned payout boundaries. */
        ByteBuffer payout = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        payout.putLong(112, 0L);
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(Base64.getEncoder().encodeToString(data)), Set.of(BORROWER)));
        payout.putLong(112, -1L);
        /** u64 最大值必须保持为正十进制整数。 The maximum u64 value remains a positive decimal integer. */
        SupplyWithdrawalEvent largest = assertInstanceOf(SupplyWithdrawalEvent.class, LendingActivityDecoder.decode(PROGRAM,
                topLevelLogs(Base64.getEncoder().encodeToString(data)), Set.of(BORROWER)).getFirst());
        assertEquals(new BigInteger("18446744073709551615"), largest.amountRaw());
    }

    /** Borsh u64 大金额保持整数精度。 Large Borsh u64 transfers retain exact precision. */
    @Test
    void retainsUnsignedAmountPrecision() {
        /** 用全 1 位模式模拟最大无符号 u64 最小单位金额。 An all-ones bit pattern encodes the largest u64 amount in base units. */
        BorrowerEvent event = assertInstanceOf(BorrowerEvent.class,
                LendingActivityDecoder.decode(PROGRAM, topLevelLogs(encodedFixture(0, -1L)), Set.of(BORROWER)).getFirst());
        assertEquals(new BigInteger("18446744073709551615"), event.amountRaw());
    }

    /** 拒绝截断日志、冲突的运行时栈、伪造借款人及错误的事件布局。 Rejects truncated logs, inconsistent runtime frames, forged borrowers, and bad event layouts. */
    @Test
    void rejectsIncompleteOrInvalidReceipts() {
        assertThrows(IllegalStateException.class, () -> LendingActivityDecoder.decode(PROGRAM, List.of(
                "Program " + PROGRAM + " invoke [1]", "Program data: " + COLLATERAL, "Log truncated"), Set.of(BORROWER)));
        assertThrows(IllegalStateException.class, () -> LendingActivityDecoder.decode(PROGRAM, List.of(
                "Program " + PROGRAM + " invoke [1]", "Program data: " + BORROW), Set.of(BORROWER)));
        assertThrows(IllegalStateException.class, () -> LendingActivityDecoder.decode(PROGRAM, List.of(
                "Program " + PROGRAM + " invoke [2]", "Program " + PROGRAM + " success"), Set.of(BORROWER)));
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(COLLATERAL), Set.of(EXTERNAL)));
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs("beSfRNzfiNo="), Set.of(BORROWER)));
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(COLLATERAL + " aGVsbG8="), Set.of(BORROWER)));
        assertThrows(IllegalStateException.class,
                () -> LendingActivityDecoder.decode(PROGRAM, topLevelLogs(encodedFixture(0, 0)), Set.of(BORROWER)));
    }

    /**
     * 将真实事件数据放在原始事件行号，省略与解码无关的运行时日志。
     * Places original event data at its actual line index, using placeholders for unrelated runtime logs.
     *
     * @param encoded Devnet 的 Base64 事件数据。 Base64 event data reported by Devnet.
     * @param logIndex 整笔交易原始日志行号，从零开始。 Original zero-based transaction log index.
     * @param action 预期业务操作。 Expected business action.
     * @param amount 实际转账最小单位。 Actual transfer in base units.
     * @param collateral 执行后抵押品最小单位。 Resulting collateral in base units.
     * @param debt 执行后债务最小单位。 Resulting debt in base units.
     */
    private static void assertDevnetLog(String encoded, int logIndex, Action action, long amount, long collateral, long debt) {
        /** 保留 RPC 给出的事件位置，非事件行仅用于填充。 Preserve the RPC event index and pad non-event lines. */
        List<String> logs = new ArrayList<>();
        logs.add("Program " + PROGRAM + " invoke [1]");
        logs.addAll(Collections.nCopies(logIndex - 1, "Program log: non-event fixture line"));
        logs.add("Program data: " + encoded);
        logs.add("Program " + PROGRAM + " success");
        assertEquals(List.of(new BorrowerEvent(logIndex, MARKET, BORROWER, BigInteger.valueOf(amount),
                BigInteger.valueOf(collateral), BigInteger.valueOf(debt), action)),
                LendingActivityDecoder.decode(PROGRAM, logs, Set.of(BORROWER)));
    }

    /**
     * 为一个事件建立成功的顶层调用样例。
     * Creates a successful top-level call fixture for one event.
     *
     * @param encoded 待解码的 Base64 事件文本。 Base64 event text to decode.
     * @return 按 Solana RPC 形式排列的调用日志。 Invocation logs matching the Solana RPC format.
     */
    private static List<String> topLevelLogs(String encoded) {
        return List.of("Program " + PROGRAM + " invoke [1]", "Program data: " + encoded,
                "Program " + PROGRAM + " success");
    }

    /**
     * 保留真实市场和借款人字段，只替换编号和金额以测试边界。
     * Keeps the actual market and borrower fields while replacing the action code and amount for boundary tests.
     *
     * @param kind 无符号 8 位借贷操作编号。 Unsigned eight-bit lending action code.
     * @param amount 实际转账最小单位的 64 位原始数据。 Raw 64-bit executed amount in base units.
     * @return 替换字段后的 Base64 事件文本。 Base64 event data with replacement fields.
     */
    private static String encodedFixture(int kind, long amount) {
        /** Borsh 固定偏移 72 为操作类型，73 为紧接着的 u64 金额。 Borsh fixed offsets 72 and 73 contain the action and adjacent u64 amount. */
        ByteBuffer buffer = ByteBuffer.wrap(Base64.getDecoder().decode(COLLATERAL)).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put(72, (byte) kind).putLong(73, amount);
        return Base64.getEncoder().encodeToString(buffer.array());
    }
}

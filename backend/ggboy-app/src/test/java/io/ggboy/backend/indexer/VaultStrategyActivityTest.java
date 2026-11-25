package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.entity.ChainEventKey;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.backend.indexer.VaultActivityData.Signature;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.mapper.ChainEventAssetMapper;
import io.ggboy.backend.mapper.ChainEventMapper;
import io.ggboy.backend.mapper.ChainEventParticipantMapper;
import io.ggboy.backend.mapper.VaultMapper;
import io.ggboy.common.utils.SolanaAddressUtil;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.function.BiFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 覆盖策略日志及活动入库的业务契约。 Covers the strategy log and persisted activity contract. */
class VaultStrategyActivityTest {

    /** 测试使用的网络、程序公钥及交易签名。 Fixture network, program key, and transaction signature. */
    private static final String NETWORK = "devnet";
    private static final String PROGRAM = "FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75";
    private static final Signature SIGNATURE = new Signature("test-finalized-signature", BigInteger.valueOf(42), false);
    /** 独立固定的公钥字节，序号使每组测试地址可区分。 Fixed independent public-key bytes distinguished by the last byte. */
    private static final byte[] VAULT_KEY = testKey(1);
    private static final byte[] MANAGER_KEY = testKey(2);
    private static final byte[] QUOTE_KEY = testKey(3);
    private static final byte[] STRATEGY_KEY = testKey(4);
    private static final byte[] SHARE_KEY = testKey(5);
    /** 同一组测试公钥的 Base58 地址。 Base58 keys matching the binary fixtures. */
    private static final String VAULT = SolanaAddressUtil.encodePublicKey(VAULT_KEY);
    private static final String MANAGER = SolanaAddressUtil.encodePublicKey(MANAGER_KEY);
    private static final String QUOTE = SolanaAddressUtil.encodePublicKey(QUOTE_KEY);
    private static final String STRATEGY = SolanaAddressUtil.encodePublicKey(STRATEGY_KEY);
    private static final String SHARES = SolanaAddressUtil.encodePublicKey(SHARE_KEY);
    /** 策略日志的 Anchor 标识及结算、策略资产登记。 Strategy event discriminator and settlement/strategy mint registrations. */
    private static final byte[] DISCRIMINATOR = HexFormat.of().parseHex("cd30736231643c24");
    private static final AssetMintDO QUOTE_MINT = new AssetMintDO(NETWORK, QUOTE, "mockUSDC", (short) 6, PROGRAM);
    private static final AssetMintDO STRATEGY_MINT = new AssetMintDO(NETWORK, STRATEGY, "tSOL", (short) 9, PROGRAM);

    /** 真实日志序号、策略参与者、资产方向和计价精度贯穿事件解析及持久化。 Original log indexes, strategy participants, directions and decimals survive decoding and storage. */
    @Test
    void writesEachStrategyActionAndDeduplicatesByOriginalLogIndex() {
        /** 交易中的三笔策略动作，以及用于区分原始行号的普通日志。 Three strategy actions and an ordinary log preserving the original indexes. */
        var events = VaultActivityDecoder.decode(PROGRAM, successfulLogs(
                actionLog(0, QUOTE_KEY, STRATEGY_KEY, -1, 500),
                "Program log: Executed strategy swap",
                actionLog(1, QUOTE_KEY, QUOTE_KEY, 100, 100),
                actionLog(2, QUOTE_KEY, QUOTE_KEY, 50, 50)));
        /** 内存 Mapper 记录索引器准备持久化的结果。 In-memory mappers capture the rows the indexer attempts to persist. */
        var fixture = new Fixture(STRATEGY);

        assertTrue(fixture.store.commit(PROGRAM, null, SIGNATURE, null, events));
        assertTrue(fixture.store.commit(PROGRAM, null, SIGNATURE, null, events));

        assertEquals(List.of(
                new ChainEventDO(NETWORK, SIGNATURE.value(), 1, PROGRAM, "VAULT", "STRATEGY_SWAP", VAULT),
                new ChainEventDO(NETWORK, SIGNATURE.value(), 3, PROGRAM, "VAULT", "STRATEGY_LEND", VAULT),
                new ChainEventDO(NETWORK, SIGNATURE.value(), 4, PROGRAM, "VAULT", "STRATEGY_RECALL", VAULT)), fixture.events);
        assertEquals(List.of(
                participant(1, MANAGER, "MANAGER"), participant(1, VAULT, "BENEFICIARY"),
                participant(3, MANAGER, "MANAGER"), participant(3, VAULT, "BENEFICIARY"),
                participant(4, MANAGER, "MANAGER"), participant(4, VAULT, "BENEFICIARY")), fixture.participants);
        assertEquals(List.of(
                new ChainEventAssetDO(NETWORK, SIGNATURE.value(), 1, 0, QUOTE, (short) 6,
                        new BigInteger("18446744073709551615"), "ASSET_OUT"),
                new ChainEventAssetDO(NETWORK, SIGNATURE.value(), 1, 1, STRATEGY, (short) 9,
                        BigInteger.valueOf(500), "ASSET_IN"),
                new ChainEventAssetDO(NETWORK, SIGNATURE.value(), 3, 0, QUOTE, (short) 6,
                        BigInteger.valueOf(100), "ASSET_OUT"),
                new ChainEventAssetDO(NETWORK, SIGNATURE.value(), 4, 0, QUOTE, (short) 6,
                        BigInteger.valueOf(50), "ASSET_IN")), fixture.assets);
    }

    /** 回滚动作不产生回执，未知动作或不匹配的实际金额也不能被解码。 Reverted actions leave no receipt. Unknown tags and inconsistent quantities are rejected. */
    @Test
    void rejectsInvalidStrategyPayloadsAndIgnoresRolledBackInvocations() {
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(PROGRAM,
                successfulLogs(actionLog(3, QUOTE_KEY, QUOTE_KEY, 1, 1))));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(PROGRAM,
                successfulLogs(actionLog(0, QUOTE_KEY, QUOTE_KEY, 1, 1))));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(PROGRAM,
                successfulLogs(actionLog(1, QUOTE_KEY, STRATEGY_KEY, 1, 1))));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(PROGRAM,
                successfulLogs(actionLog(2, QUOTE_KEY, QUOTE_KEY, 1, 2))));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(PROGRAM,
                successfulLogs(actionLog(0, QUOTE_KEY, STRATEGY_KEY, 1, 0))));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(PROGRAM,
                successfulLogs("Program data: " + Base64.getEncoder().encodeToString(DISCRIMINATOR))));
        assertEquals(List.of(), VaultActivityDecoder.decode(PROGRAM, List.of(
                "Program " + PROGRAM + " invoke [1]", actionLog(0, QUOTE_KEY, STRATEGY_KEY, 1, 1),
                "Program " + PROGRAM + " failed: custom program error: 0x1")));
    }

    /** 未登记或登记为其他 Mint 时拒绝策略回执，避免用错误的资产精度索引。 Reject swaps for unregistered or mismatched strategy mints rather than indexing the wrong asset. */
    @Test
    void requiresTheRegisteredStrategyPairInEitherDirection() {
        /** 兑换方向与首个测试相反，验证报价资产可位于任一侧。 Reverse the swap to verify the settlement mint may appear on either side. */
        var events = VaultActivityDecoder.decode(PROGRAM, successfulLogs(actionLog(0, STRATEGY_KEY, QUOTE_KEY, 4, 9)));
        var configured = new Fixture(STRATEGY);
        assertTrue(configured.store.commit(PROGRAM, null, SIGNATURE, null, events));
        assertEquals("STRATEGY_SWAP", configured.events.getFirst().eventType());

        var unconfigured = new Fixture(null);
        assertThrows(IllegalStateException.class,
                () -> unconfigured.store.commit(PROGRAM, null, SIGNATURE, null, events));
        assertEquals(List.of(), unconfigured.events);
        assertEquals(List.of(), unconfigured.assets);

        var mismatched = new Fixture(SHARES);
        assertThrows(IllegalStateException.class,
                () -> mismatched.store.commit(PROGRAM, null, SIGNATURE, null, events));
        assertEquals(List.of(), mismatched.events);
    }

    /**
     * 创建可独立辨别的固定 32 字节测试公钥。
     * Creates a distinguishable 32-byte fixture public key.
     *
     * @param ordinal 写入最后一个字节的样本编号。 Fixture identifier written to the last byte.
     * @return 同一编号始终得到相同字节。 Stable fixture key bytes for this identifier.
     */
    private static byte[] testKey(int ordinal) {
        /** 公钥固定为 32 字节，其余位保持零。 A 32-byte public key with all other bytes left zero. */
        var key = new byte[32];
        key[31] = (byte) ordinal;
        return key;
    }

    /**
     * 将内部日志包裹在一个成功的金库调用中。
     * Wraps inner fixture logs in a successful vault invocation.
     *
     * @param inner 按链上顺序发出的日志。 Fixture logs in on-chain order.
     * @return 与 RPC 格式一致的完整日志。 Complete logs in RPC format.
     */
    private static List<String> successfulLogs(String... inner) {
        /** 完整运行栈，保留事件原始位置。 Full invocation stack preserving the original log indexes. */
        var logs = new ArrayList<String>();
        logs.add("Program " + PROGRAM + " invoke [1]");
        logs.addAll(List.of(inner));
        logs.add("Program " + PROGRAM + " success");
        return logs;
    }

    /**
     * 根据固定 Anchor/Borsh 布局生成策略事件日志。
     * Produces a strategy event log using the fixed Anchor/Borsh layout.
     *
     * @param tag 动作的 u8 值。 u8 action tag.
     * @param inputMint 输入资产的原始公钥。 Raw input asset key.
     * @param outputMint 输出资产的原始公钥。 Raw output asset key.
     * @param input 输入资产实际最小单位数的 u64 位模式。 u64 bits of the executed input in base units.
     * @param output 输出资产实际最小单位数的 u64 位模式。 u64 bits of the executed output in base units.
     * @return RPC Program data 日志行。 RPC Program data log line.
     */
    private static String actionLog(int tag, byte[] inputMint, byte[] outputMint, long input, long output) {
        /** 153 字节包括 Anchor 标识和小端金额。 153 bytes include the Anchor discriminator and little-endian amounts. */
        var event = ByteBuffer.allocate(153).order(ByteOrder.LITTLE_ENDIAN);
        event.put(DISCRIMINATOR).put(VAULT_KEY).put(MANAGER_KEY).put((byte) tag);
        event.put(inputMint).put(outputMint).putLong(input).putLong(output);
        return "Program data: " + Base64.getEncoder().encodeToString(event.array());
    }

    /**
     * 创建待核对的参与方行。
     * Creates an expected participant row.
     *
     * @param index 原始日志行号。 Original log index.
     * @param wallet 参与地址。 Participant key.
     * @param role 参与业务角色。 Participant business role.
     * @return 该交易和事件的参与方记录。 Participant row for this transaction and event.
     */
    private static ChainEventParticipantDO participant(int index, String wallet, String role) {
        return new ChainEventParticipantDO(NETWORK, SIGNATURE.value(), index, wallet, role);
    }

    /**
     * 为集成索引测试创建内存 Mapper 替身，不连接生产数据库。
     * Supplies an in-memory mapper double for indexer tests without connecting to a database.
     *
     * @param type MyBatis Mapper 接口。 MyBatis mapper interface.
     * @param calls 按接口方法名和入参模拟调用。 Handles each invocation by method and arguments.
     * @return 仅实现此测试所用调用的 Mapper。 Mapper double handling only calls relevant to this fixture.
     */
    private static <T> T mapper(Class<T> type, BiFunction<String, Object[], Object> calls) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
                (proxy, method, args) -> calls.apply(method.getName(), args)));
    }

    /** 内存登记与活动表，跨调用保留已保存的事件。 In-memory registry and activity tables preserving written events across calls. */
    private static final class Fixture {
        /** 三个已写入表中的父事件、参与者与资产明细。 Parent events, participants and asset movements written to the fixture tables. */
        private final List<ChainEventDO> events = new ArrayList<>();
        private final List<ChainEventParticipantDO> participants = new ArrayList<>();
        private final List<ChainEventAssetDO> assets = new ArrayList<>();

        /** 用真实业务方法配合内存 Mapper 写入的索引存储服务。 Production storage logic connected to in-memory mapper doubles. */
        private final VaultActivityStore store;

        /**
         * 注入金库的策略 Mint 和与实际实现相同的事件去重接口。
         * Injects the vault's configured strategy mint and the same deduplication APIs used by storage.
         *
         * @param strategyMint 已登记策略 Mint，可为空以模拟纯现金金库。 Registered strategy mint, nullable for a cash-only vault.
         */
        private Fixture(String strategyMint) {
            /** 拦截检查点和父交易访问，测试关注活动数据映射。 Intercept checkpoints and parent transaction access to focus on row mapping. */
            var checkpoints = new ActivityIndexStore(null, null) {
                /** 此测试允许写入，单独验证事件级去重。 Allow writes to exercise event-level deduplication independently. */
                @Override
                boolean advanceCheckpoint(String programId, Signature expected, Signature current, OffsetDateTime indexedAt) {
                    return true;
                }

                /** 无数据库父交易行，仅核对事件级写入。 No database parent row is needed for this event-level assertion. */
                @Override
                void ensureParent(Signature signature, OffsetDateTime blockTime, OffsetDateTime indexedAt) {
                }
            };
            store = new VaultActivityStore(checkpoints,
                    mapper(VaultMapper.class, (method, args) -> {
                        assertEquals("selectByNetworkAndAddress", method);
                        assertEquals(VAULT, args[1]);
                        return new VaultDO(NETWORK, VAULT, PROGRAM, QUOTE, SHARES, strategyMint, null);
                    }),
                    mapper(AssetMintMapper.class, (method, args) -> {
                        assertEquals("selectByNetworkAndMintAddresses", method);
                        return List.of(QUOTE_MINT, STRATEGY_MINT);
                    }),
                    mapper(ChainEventMapper.class, (method, args) -> switch (method) {
                        case "selectByEventKey" -> {
                            /** 匹配同一交易及日志序号，用于验证一个签名可包含多笔活动。 Match the transaction and log index so one signature can contain multiple actions. */
                            var key = (ChainEventKey) args[1];
                            yield events.stream().filter(row -> row.signature().equals(key.signature())
                                    && row.eventIndex() == key.eventIndex()).findFirst().orElse(null);
                        }
                        case "insert" -> events.add((ChainEventDO) args[0]) ? 1 : 0;
                        default -> throw new AssertionError(method);
                    }),
                    mapper(ChainEventParticipantMapper.class, (method, args) -> {
                        assertEquals("insert", method);
                        return participants.add((ChainEventParticipantDO) args[0]) ? 1 : 0;
                    }),
                    mapper(ChainEventAssetMapper.class, (method, args) -> {
                        assertEquals("insert", method);
                        return assets.add((ChainEventAssetDO) args[0]) ? 1 : 0;
                    }));
        }
    }
}

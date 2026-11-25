package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.entity.ChainEventKey;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.indexer.LendingActivityDecoder.Event;
import io.ggboy.backend.indexer.LendingActivityDecoder.LiquidationEvent;
import io.ggboy.backend.indexer.VaultActivityData.Signature;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.mapper.ChainEventAssetMapper;
import io.ggboy.backend.mapper.ChainEventMapper;
import io.ggboy.backend.mapper.ChainEventParticipantMapper;
import io.ggboy.backend.mapper.LendingMarketMapper;
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
import java.util.Set;
import java.util.function.BiFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 覆盖清算事件的 Anchor 解析、市场登记核对和交易回执。 Covers Anchor liquidation decoding, market verification and receipt storage. */
class LendingLiquidationActivityTest {

    /** 测试网络、目标程序、上游调用者和已确认签名。 Fixture network, target program, outer caller and finalized signature. */
    private static final String NETWORK = "devnet";
    private static final String PROGRAM = "8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H";
    private static final String EXTERNAL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    private static final Signature SIGNATURE = new Signature("liquidation-signature", BigInteger.valueOf(42), false);

    /** 不同序号对应不同的二进制公钥及 Base58 地址。 Separate ordinals identify binary keys and their Base58 addresses. */
    private static final int MARKET_KEY = 1;
    private static final int BORROWER_KEY = 2;
    private static final int LIQUIDATOR_KEY = 3;
    private static final int DEBT_KEY = 4;
    private static final int COLLATERAL_KEY = 5;
    private static final String MARKET = address(MARKET_KEY);
    private static final String BORROWER = address(BORROWER_KEY);
    private static final String LIQUIDATOR = address(LIQUIDATOR_KEY);
    private static final String DEBT = address(DEBT_KEY);
    private static final String COLLATERAL = address(COLLATERAL_KEY);

    /** Anchor 事件标识与市场中使用不同精度的两个 Mint。 Anchor event discriminator and the market's two differently scaled mints. */
    private static final byte[] DISCRIMINATOR = HexFormat.of().parseHex("7118b671721ebfc3");
    private static final AssetMintDO DEBT_MINT = new AssetMintDO(NETWORK, DEBT, "mockUSDC", (short) 6, EXTERNAL);
    private static final AssetMintDO COLLATERAL_MINT = new AssetMintDO(NETWORK, COLLATERAL, "tSOL", (short) 9, EXTERNAL);

    /** 保留原始日志索引和双参与者，按两个 Mint 写入三项回执并去重。 Preserves original log index and both participants, writes three receipt legs with their mints, and deduplicates. */
    @Test
    void indexesLiquidationTransfersAndBadDebtOnce() {
        /** 同一个事件同时发生代偿、抵押品划转和坏账。 The event combines repayment, collateral seizure and a write-off. */
        var events = decode(payload(LIQUIDATOR_KEY, DEBT_KEY, COLLATERAL_KEY, -1, 23, 7), Set.of(LIQUIDATOR));
        var event = assertInstanceOf(LiquidationEvent.class, events.getFirst());
        assertEquals(new LiquidationEvent(2, MARKET, BORROWER, LIQUIDATOR, DEBT, COLLATERAL,
                new BigInteger("18446744073709551615"), BigInteger.valueOf(23), BigInteger.valueOf(7)), event);

        /** 两次提交同一签名和原始行号，只需保存一次业务事件。 Repeated submissions of the same signature and log index only produce one event. */
        var fixture = new Fixture();
        assertTrue(fixture.store.commit(PROGRAM, null, SIGNATURE, null, events));
        assertTrue(fixture.store.commit(PROGRAM, null, SIGNATURE, null, events));
        assertEquals(List.of(new ChainEventDO(NETWORK, SIGNATURE.value(), 2, PROGRAM, "LENDING",
                "LENDING_LIQUIDATION", MARKET)), fixture.events);
        assertEquals(List.of(
                new ChainEventParticipantDO(NETWORK, SIGNATURE.value(), 2, BORROWER, "BORROWER"),
                new ChainEventParticipantDO(NETWORK, SIGNATURE.value(), 2, LIQUIDATOR, "LIQUIDATOR")), fixture.participants);
        assertEquals(List.of(
                new ChainEventAssetDO(NETWORK, SIGNATURE.value(), 2, 0, DEBT, (short) 6, event.repaidRaw(), "DEBT_REPAID"),
                new ChainEventAssetDO(NETWORK, SIGNATURE.value(), 2, 1, COLLATERAL, (short) 9, event.seizedCollateralRaw(), "COLLATERAL_SEIZED"),
                new ChainEventAssetDO(NETWORK, SIGNATURE.value(), 2, 2, DEBT, (short) 6, event.badDebtRaw(), "BAD_DEBT")), fixture.assets);
    }

    /** 单独核销的回执只记录坏账，并核对借款与抵押 Mint 不可互换。 Write-off alone only records bad debt, and swapped market mints are rejected. */
    @Test
    void writesOnlyBookLossForDustAndRequiresRegisteredMintOrder() {
        /** 异常 Mint 的事件在正常核销前尝试入库，验证不会落活动行。 Attempt a wrong mint pair before a legitimate write-off to verify no activity row is stored for it. */
        var fixture = new Fixture();
        var swapped = decode(payload(LIQUIDATOR_KEY, COLLATERAL_KEY, DEBT_KEY, 0, 0, 5), Set.of(LIQUIDATOR));
        assertThrows(IllegalStateException.class, () -> fixture.store.commit(PROGRAM, null, SIGNATURE, null, swapped));
        assertEquals(List.of(), fixture.events);

        /** 此时只有以借款 Mint 计量的核销发生。 Only a write-off in the debt mint occurs. */
        var events = decode(payload(LIQUIDATOR_KEY, DEBT_KEY, COLLATERAL_KEY, 0, 0, 5), Set.of(LIQUIDATOR));
        assertTrue(fixture.store.commit(PROGRAM, null, SIGNATURE, null, events));
        assertEquals(List.of(new ChainEventAssetDO(NETWORK, SIGNATURE.value(), 2, 0, DEBT, (short) 6,
                BigInteger.valueOf(5), "BAD_DEBT")), fixture.assets);
    }

    /** 拒绝错误签名、同一参与人或不成对的代偿与抵押品。 Rejects wrong signers, identical parties, or unpaired repayment and collateral. */
    @Test
    void rejectsInvalidSignerAndAmountPairs() {
        /** 有效数据只在清算人实际签名时可解码。 Valid data requires the actual liquidator's signature. */
        String valid = payload(LIQUIDATOR_KEY, DEBT_KEY, COLLATERAL_KEY, 1, 1, 0);
        assertThrows(IllegalStateException.class, () -> decode(valid, Set.of(BORROWER)));
        assertThrows(IllegalStateException.class, () -> decode(payload(BORROWER_KEY, DEBT_KEY, COLLATERAL_KEY, 1, 1, 0), Set.of(BORROWER)));

        /** 代偿和抵押品须同时非零，没有转账的事件必须报告坏账。 Repayment and collateral must both be nonzero, or the event must report a write-off. */
        assertThrows(IllegalStateException.class, () -> decode(payload(LIQUIDATOR_KEY, DEBT_KEY, COLLATERAL_KEY, 1, 0, 1), Set.of(LIQUIDATOR)));
        assertThrows(IllegalStateException.class, () -> decode(payload(LIQUIDATOR_KEY, DEBT_KEY, COLLATERAL_KEY, 0, 1, 1), Set.of(LIQUIDATOR)));
        assertThrows(IllegalStateException.class, () -> decode(payload(LIQUIDATOR_KEY, DEBT_KEY, COLLATERAL_KEY, 0, 0, 0), Set.of(LIQUIDATOR)));
        assertThrows(IllegalStateException.class, () -> decode(valid + " AA==", Set.of(LIQUIDATOR)));
    }

    /** 已知清算标识在嵌套或失败调用中不进入活动。 Nested or failed invocations never create liquidation activity for the known discriminator. */
    @Test
    void skipsNestedAndFailedLiquidations() {
        /** 同一个带签名的清算样例出现在两个不能入库的调用中。 The same signer-matched liquidation appears in two ineligible invocations. */
        String event = "Program data: " + payload(LIQUIDATOR_KEY, DEBT_KEY, COLLATERAL_KEY, 1, 1, 0);
        assertEquals(List.of(), LendingActivityDecoder.decode(PROGRAM, List.of(
                "Program " + EXTERNAL + " invoke [1]", "Program " + PROGRAM + " invoke [2]", event,
                "Program " + PROGRAM + " success", "Program " + EXTERNAL + " success",
                "Program " + PROGRAM + " invoke [1]", event, "Program " + PROGRAM + " failed: error"), Set.of(LIQUIDATOR)));
    }

    /**
     * 使用固定顶层成功交易解码一条事件。
     * Decodes one event wrapped in a successful top-level transaction.
     *
     * @param encoded Anchor 数据的 Base64 字符串。 Base64 Anchor payload.
     * @param signers 模拟的签名钱包地址。 Fixture signing wallet keys.
     * @return 已接受的事件序列。 Accepted event sequence.
     */
    private static List<Event> decode(String encoded, Set<String> signers) {
        return LendingActivityDecoder.decode(PROGRAM, List.of(
                "Program " + PROGRAM + " invoke [1]", "Program log: Instruction: Liquidate",
                "Program data: " + encoded, "Program " + PROGRAM + " success"), signers);
    }

    /**
     * 按 Rust 中的字段顺序独立写入清算 Borsh 数据。
     * Serializes a liquidation fixture independently in the Rust field order.
     *
     * @param liquidator 清算人公钥编号。 Liquidator key ordinal.
     * @param debt 借款 Mint 公钥编号。 Debt mint key ordinal.
     * @param collateral 抵押 Mint 公钥编号。 Collateral mint key ordinal.
     * @param repaid 代偿量的 u64 位模式。 u64 bits of actual repayment.
     * @param seized 划转抵押品的 u64 位模式。 u64 bits of collateral seized.
     * @param badDebt 坏账量的 u64 位模式。 u64 bits of bad debt.
     * @return 事件字节的 Base64 编码。 Base64 event bytes.
     */
    private static String payload(int liquidator, int debt, int collateral, long repaid, long seized, long badDebt) {
        /** Anchor 标识、五个原始公钥及三个小端 u64 占 192 字节。 Anchor discriminator, five raw keys and three little-endian u64 values occupy 192 bytes. */
        var data = ByteBuffer.allocate(192).order(ByteOrder.LITTLE_ENDIAN);
        data.put(DISCRIMINATOR).put(key(MARKET_KEY)).put(key(BORROWER_KEY)).put(key(liquidator))
                .put(key(debt)).put(key(collateral)).putLong(repaid).putLong(seized).putLong(badDebt);
        return Base64.getEncoder().encodeToString(data.array());
    }

    /**
     * 根据编号生成原始公钥。
     * Builds a raw fixture key from its ordinal.
     *
     * @param ordinal 末字节的公钥编号。 Key ordinal stored in the last byte.
     * @return 32 字节公钥。 32-byte public key.
     */
    private static byte[] key(int ordinal) {
        /** 只有末字节区分样本。 Only the last byte distinguishes fixtures. */
        var bytes = new byte[32];
        bytes[31] = (byte) ordinal;
        return bytes;
    }

    /**
     * 将同一编号的原始公钥编码为地址。
     * Encodes the matching raw key as an address.
     *
     * @param ordinal 公钥编号。 Key ordinal.
     * @return Base58 地址。 Base58 address.
     */
    private static String address(int ordinal) {
        return SolanaAddressUtil.encodePublicKey(key(ordinal));
    }

    /**
     * 建立只处理当前测试相关调用的 Mapper。
     * Creates a test mapper that handles only relevant calls.
     *
     * @param type Mapper 接口。 Mapper interface.
     * @param calls 依据方法名和参数返回的测试实现。 Stub returning values by method name and arguments.
     * @param <T> Mapper 类型。 Mapper type.
     * @return 模拟 Mapper。 Mapper double.
     */
    private static <T> T mapper(Class<T> type, BiFunction<String, Object[], Object> calls) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
                (proxy, method, args) -> calls.apply(method.getName(), args)));
    }

    /** 用内存表检查事件入库结果和去重约束。 Inspects persisted rows and deduplication using in-memory tables. */
    private static final class Fixture {
        /** 待校验的活动、参与者及回执明细数据行。 Captured event, participant and receipt rows. */
        private final List<ChainEventDO> events = new ArrayList<>();
        private final List<ChainEventParticipantDO> participants = new ArrayList<>();
        private final List<ChainEventAssetDO> assets = new ArrayList<>();

        /** 使用真实索引方法和模拟 Mapper 的存储服务。 Real storage logic with mapper doubles. */
        private final LendingActivityStore store;

        /** 注册固定市场和 Mint，按签名及日志序号模拟事件查找。 Registers the fixture market and mints and emulates lookup by signature and log index. */
        private Fixture() {
            /** 让同一签名多次抵达活动入库层，独立验证事件去重。 Let the same signature reach event storage repeatedly to exercise deduplication. */
            var checkpoints = new ActivityIndexStore(null, null) {
                /** 测试中始终允许进度推进。 Always permit advancing in this fixture. */
                @Override
                boolean advanceCheckpoint(String programId, Signature expected, Signature current, OffsetDateTime indexedAt) {
                    return true;
                }

                /** 本测试直接检查事件与明细行。 This fixture asserts event and detail rows directly. */
                @Override
                void ensureParent(Signature signature, OffsetDateTime blockTime, OffsetDateTime indexedAt) {
                }
            };
            store = new LendingActivityStore(checkpoints,
                    mapper(LendingMarketMapper.class, (method, args) -> {
                        assertEquals("selectByNetworkAndAddress", method);
                        assertEquals(MARKET, args[1]);
                        return new LendingMarketDO(NETWORK, MARKET, PROGRAM, DEBT, COLLATERAL, null, null);
                    }),
                    mapper(AssetMintMapper.class, (method, args) -> {
                        assertEquals("selectByNetworkAndMintAddresses", method);
                        assertEquals(List.of(DEBT, COLLATERAL), args[1]);
                        // 用与请求相反的顺序返回，验证按地址绑定精度。 Reverse the fetch order to verify decimals are matched by mint address.
                        return List.of(COLLATERAL_MINT, DEBT_MINT);
                    }),
                    mapper(ChainEventMapper.class, (method, args) -> switch (method) {
                        case "selectByEventKey" -> {
                            /** 与生产查询相同，按签名及原始行号查找事件。 As in production, match events by signature and original log index. */
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

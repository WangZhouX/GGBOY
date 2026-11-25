package io.ggboy.backend.indexer;

import com.sun.net.httpserver.HttpServer;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.common.utils.SolanaAddressUtil;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.NullNode;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 验证金库两阶段读取、同批次校验以及原始金额全精度。
 * Verifies two-stage observation, same-batch account validation and exact base units.
 */
class VaultSnapshotRpcTest {

    /** 模拟 RPC 的 JSON 编解码器。 JSON codec for the mock RPC service. */
    private static final JsonMapper JSON = JsonMapper.builder().build();
    /** 用于测试的公钥及其规范编码。 Fixture public keys and their canonical encodings. */
    private static final String PROGRAM = "FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75";
    private static final byte[] VAULT_KEY = fixtureKey(11);
    private static final byte[] CUSTODY_KEY = fixtureKey(12);
    private static final byte[] QUOTE_KEY = fixtureKey(13);
    private static final byte[] SHARE_KEY = fixtureKey(14);
    private static final String CUSTODY_ADDRESS = SolanaAddressUtil.encodePublicKey(CUSTODY_KEY);
    /** 两个已登记的金库 Mint 及金库地址。 Registered vault address and both mint keys. */
    private static final VaultDO VAULT = new VaultDO("devnet", SolanaAddressUtil.encodePublicKey(VAULT_KEY), PROGRAM,
            SolanaAddressUtil.encodePublicKey(QUOTE_KEY), SolanaAddressUtil.encodePublicKey(SHARE_KEY), null, null);
    /** 策略 Mint、规范借贷市场及其现金 PDA。 Fixture strategy mint, canonical lending market and cash PDA. */
    private static final byte[] SPOT_KEY = fixtureKey(15);
    private static final String LENDING_PROGRAM = "8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H";
    private static final VaultSnapshotProgramAddress.Address MARKET =
            VaultSnapshotProgramAddress.derive(LENDING_PROGRAM, "lending_market");
    /** 启用策略的金库沿用原地址，登记策略 Mint 和借贷市场。 Strategy-enabled vault keeps its address and registers a strategy mint and lending market. */
    private static final VaultDO ACTIVE_VAULT = new VaultDO("devnet", VAULT.vaultAddress(), PROGRAM, VAULT.quoteMint(),
            VAULT.shareMint(), SolanaAddressUtil.encodePublicKey(SPOT_KEY), MARKET.publicKey());
    /** 只用于同槽测试的链上 Unix 时间（秒）。 On-chain Unix timestamp in seconds for same-slot fixtures. */
    private static final long CLOCK_TIME = 1_800_000_000L;

    /** 远超安全浮点范围的有效最终确认 slot。 Valid finalized slots beyond the range of exact floating-point integers. */
    private static final BigInteger DISCOVERY_SLOT = new BigInteger("18446744073709551614");
    private static final BigInteger FINAL_SLOT = DISCOVERY_SLOT.add(BigInteger.ONE);

    /**
     * 现金与份额必须来自第二次同批次读取，且 u64 不能转为有符号值。
     * Cash and shares must come from the second batch and preserve unsigned u64 values.
     *
     * @throws IOException 本机测试服务无法打开。 The local test server cannot open.
     */
    @Test
    void readsExactAmountsAtOneFinalizedSlot() throws IOException {
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY)), batch(FINAL_SLOT, VAULT_KEY))) {
            assertEquals(new VaultSnapshotRpc.Observation(FINAL_SLOT, FINAL_SLOT, BigInteger.ONE.shiftLeft(63)),
                    new VaultSnapshotRpc(fixture.rpc()).observe(VAULT));

            /** 初次请求仅用于发现托管地址，最终请求包包含全部估值输入。 Discovery requests only the vault, while valuation requests all inputs together. */
            JsonNode discovery = fixture.requests().get(0);
            JsonNode finalRequest = fixture.requests().get(1);
            assertEquals("getMultipleAccounts", discovery.path("method").textValue());
            assertEquals("getMultipleAccounts", finalRequest.path("method").textValue());
            assertEquals("[\"" + VAULT.vaultAddress() + "\"]", discovery.at("/params/0").toString());
            assertTrue(discovery.at("/params/1/minContextSlot").isMissingNode());
            assertEquals(JSON.valueToTree(List.of(VAULT.vaultAddress(), CUSTODY_ADDRESS, VAULT.quoteMint(), VAULT.shareMint())),
                    finalRequest.at("/params/0"));
            assertEquals("finalized", finalRequest.at("/params/1/commitment").textValue());
            assertEquals("base64", finalRequest.at("/params/1/encoding").textValue());
            assertEquals(DISCOVERY_SLOT, finalRequest.at("/params/1/minContextSlot").bigIntegerValue());
        }
    }

    /**
     * 拒绝使用比发现阶段更早的上下文进行估值。
     * Rejects valuation from a context older than the discovery stage.
     *
     * @throws IOException 本机测试服务无法打开。 The local test server cannot open.
     */
    @Test
    void rejectsRegressedContext() throws IOException {
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY)),
                batch(DISCOVERY_SLOT.subtract(BigInteger.ONE), VAULT_KEY))) {
            assertThrows(IllegalStateException.class, () -> new VaultSnapshotRpc(fixture.rpc()).observe(VAULT));
        }
    }

    /**
     * 拒绝以别的钱包作为份额 Mint 的铸造权限。
     * Rejects share mint authority belonging to a different wallet.
     *
     * @throws IOException 本机测试服务无法打开。 The local test server cannot open.
     */
    @Test
    void rejectsUnexpectedShareAuthority() throws IOException {
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY)),
                batch(FINAL_SLOT, fixtureKey(44)))) {
            /** 验证拒绝发生在份额权限阶段。 Confirms that rejection is caused by the share authority check. */
            var failure = assertThrows(IllegalStateException.class, () -> new VaultSnapshotRpc(fixture.rpc()).observe(VAULT));
            assertEquals("Invalid Devnet vault snapshot share mint authority", failure.getMessage());
        }
    }

    /**
     * 金库的现金绑定以最终批次的状态为准，前后不一致时拒绝快照。
     * Treats the final batch's custody binding as authoritative and rejects mismatches with discovery.
     *
     * @throws IOException 本机测试服务无法打开。 The local test server cannot open.
     */
    @Test
    void rejectsChangedCustodyBinding() throws IOException {
        /** 最终观测的金库状态绑定了另一个托管账户。 Vault state in the final read binds a different custody address. */
        ObjectNode changedBatch = response(FINAL_SLOT, vaultState(fixtureKey(29)),
                custodyAccount(), mintAccount(null, 0), mintAccount(VAULT_KEY, Long.MIN_VALUE));
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY)), changedBatch)) {
            assertThrows(IllegalStateException.class, () -> new VaultSnapshotRpc(fixture.rpc()).observe(VAULT));
        }
    }

    /**
     * 检查策略资产向下取整、出借份额估值和池中本刻实际可收回额。
     * Checks floored strategy value, supply share value and currently recallable pool cash.
     */
    @Test
    void valuesStrategyAndLendingInOneFinalizedBatch() throws IOException {
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY, true)),
                strategyBatch(CLOCK_TIME - 604_800, 1_500_000_000L))) {
            /** 策略估值既包括未偿借款本金形成的债权，也将本刻流动性单独记录。 Strategy valuation includes outstanding borrower principal and records currently available recall liquidity separately. */
            VaultSnapshotRpc.Observation observation = new VaultSnapshotRpc(fixture.rpc()).observe(ACTIVE_VAULT);
            assertEquals(FINAL_SLOT, observation.slot());
            assertEquals(BigInteger.valueOf(1_500_000_000), observation.strategyAmountRaw());
            assertEquals(BigInteger.valueOf(4_500_001), observation.strategyValueRaw());
            assertEquals(BigInteger.valueOf(55), observation.lendValueRaw());
            assertEquals(BigInteger.valueOf(20), observation.recallableRaw());
            assertEquals(BigInteger.valueOf(4_500_256), observation.navRaw());
            assertEquals(false, observation.autoRecallEnabled());
            assertEquals(true, observation.lendingPositionOpen());

            /** 估值账户与链上 Clock 均在最终请求中，且最低 slot 来自先前状态发现。 Valuation accounts and Clock are in the final request with the discovery slot floor. */
            JsonNode request = fixture.requests().get(1);
            assertEquals("finalized", request.at("/params/1/commitment").textValue());
            assertEquals(DISCOVERY_SLOT, request.at("/params/1/minContextSlot").bigIntegerValue());
            assertEquals("SysvarC1ock11111111111111111111111111111111", request.at("/params/0/13").textValue());
            assertEquals(14, request.at("/params/0").size());
        }
    }

    /**
     * 从最终确认的 Vault 和 Clock 同时读取自动收回标志并计入出借利息。
     * Uses the finalized Vault and Clock to capture recall activation and accrued supply value together.
     */
    @Test
    void captureAutoRecallAndProjectLendingInterestAtFinalizedClock() throws IOException {
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY, true, true)),
                strategyBatch(0, 0, true, true))) {
            /** 六十秒计息使债务从 80 向上到 81。资产总计 102，入账现金仍为 21。 One minute increases debt from 80 to 81. Assets are 102 and tracked cash remains 21. */
            VaultSnapshotRpc.Observation observation = new VaultSnapshotRpc(fixture.rpc()).observe(ACTIVE_VAULT);
            assertEquals(true, observation.autoRecallEnabled());
            assertEquals(true, observation.lendingPositionOpen());
            assertEquals(BigInteger.valueOf(56), observation.lendValueRaw());
            assertEquals(BigInteger.valueOf(20), observation.recallableRaw());
            assertEquals(BigInteger.valueOf(256), observation.navRaw());
        }
    }

    /**
     * 价格过期时保留策略数量和可收回出借资金，净值为空。
     * Preserves the strategy amount and recallable lending liquidity when price expiration makes NAV unavailable.
     */
    @Test
    void keepsRecallLiquidityWhenStrategyPriceExpires() throws IOException {
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY, true)),
                strategyBatch(CLOCK_TIME - 604_801, 1_500_000_000L))) {
            /** 持有非零策略代币但测试价格超时。 Nonzero strategy holdings with expired test pricing. */
            VaultSnapshotRpc.Observation observation = new VaultSnapshotRpc(fixture.rpc()).observe(ACTIVE_VAULT);
            assertNull(observation.strategyValueRaw());
            assertNull(observation.navRaw());
            assertEquals(BigInteger.valueOf(20), observation.recallableRaw());
        }
    }

    /**
     * 零策略持仓不需要预言机，估值仍计入现金和金库出借份额。
     * Needs no oracle for zero strategy holdings and retains cash and supply share value.
     */
    @Test
    void valuesCashAndLendingWithoutAnOracleWhileSpotIsZero() throws IOException {
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY, true)), strategyBatch(0, 0))) {
            /** 预言机尚不存在且金库未持有策略代币。 Oracle not initialized and vault holds no strategy tokens. */
            VaultSnapshotRpc.Observation observation = new VaultSnapshotRpc(fixture.rpc()).observe(ACTIVE_VAULT);
            assertEquals(BigInteger.ZERO, observation.strategyValueRaw());
            assertEquals(BigInteger.valueOf(255), observation.navRaw());
        }
    }

    /**
     * 首次启用策略与采集并发时不能按纯现金结算。
     * Rejects a cash-only observation racing strategy activation.
     */
    @Test
    void rejectsStrategyActivationBetweenBothBatches() throws IOException {
        try (var fixture = fixture(response(DISCOVERY_SLOT, vaultState(CUSTODY_KEY)),
                response(FINAL_SLOT, vaultState(CUSTODY_KEY, true), custodyAccount(), mintAccount(null, 0),
                        mintAccount(VAULT_KEY, Long.MIN_VALUE)))) {
            assertThrows(IllegalStateException.class, () -> new VaultSnapshotRpc(fixture.rpc()).observe(VAULT));
        }
    }

    /**
     * 与 Solana Web3.js 交叉核验 PDA，覆盖跳过曲线候选的多个 bump。
     * Verifies PDAs against Solana Web3.js and exercises skipping multiple on-curve bumps.
     */
    @Test
    void derivesTheKnownMarketAndOraclePdas() {
        assertEquals("HzzMy19zYvQ6ZKfEgeMwuin3eMp8RFBWeRar9vzncUvE", MARKET.publicKey());
        assertEquals(new VaultSnapshotProgramAddress.Address("4NeM7WfjHBxwFzScEeGX7TAUc7FeMDrvKBf1f6iN9znw", 252),
                VaultSnapshotProgramAddress.derive(LENDING_PROGRAM, "mock_collateral_price", MARKET.publicKey()));
    }

    /**
     * 构造包含策略账户、借贷市场和同槽 Clock 的完整估值响应。
     * Builds a complete valuation response with strategy, lending and Clock accounts from the same slot.
     *
     * @param published 测试价格发布的 Unix 秒。零表示账户尚未建立。 Quote publication Unix seconds, or zero for a missing account.
     * @param spotRaw tSOL 最小单位数量。 Quantity in tSOL base units.
     * @return 模拟最终确认的账户批次。 Simulated finalized account batch.
     */
    private static ObjectNode strategyBatch(long published, long spotRaw) {
        return strategyBatch(published, spotRaw, false, false);
    }

    /**
     * 构造同时对应 Vault 自动收回标志和池计息模式的最终批次。
     * Builds a finalized batch with the requested Vault recall capability and pool interest mode.
     *
     * @param published 测试价格发布秒，零表示缺少价格账户。 Quote publication time, or zero for a missing account.
     * @param spotRaw tSOL 最小单位数量。 Quantity in tSOL base units.
     * @param autoRecallEnabled Vault 是否已开启自动收回。 Whether the Vault has enabled auto recall.
     * @param interestEnabled 出借池是否已启用计息后缀。 Whether the supply pool uses its interest extension.
     * @return 模拟最终确认的账户批次。 Simulated finalized account batch.
     */
    private static ObjectNode strategyBatch(long published, long spotRaw, boolean autoRecallEnabled, boolean interestEnabled) {
        /** 规范市场公钥的链上 32 字节形式。 On-chain 32-byte canonical market key. */
        byte[] marketKey = HexFormat.of().parseHex("fc95f4ad101d5eae682225353b60320112cfb42f3d891ced3af1c2a7f62c8103");
        /** 用真实 PDA bump 组装当前程序版本的定长账户。 Assemble current fixed layouts with realistic PDA bumps. */
        int strategyBump = VaultSnapshotProgramAddress.derive(PROGRAM, "strategy", VAULT.vaultAddress()).bump();
        ByteBuffer config = borsh(143, "7409492549c03fd7").put(8, VAULT_KEY)
                .put(72, SPOT_KEY).put(104, marketKey).put(142, (byte) strategyBump);
        ByteBuffer market = borsh(169, "f6723262489d1c78").put(40, QUOTE_KEY).put(72, SPOT_KEY)
                .put(104, HexFormat.of().parseHex("5ae638d62cc43c9416b455b15f014fec5b9e60bc2ed0c53be5ccd6bb9a89df16"))
                .put(168, (byte) MARKET.bump());
        ByteBuffer oracle = borsh(56, "153ff545db01090e").put(8, marketKey)
                .putLong(40, 3_000_001).putLong(48, published);
        ByteBuffer pool = borsh(interestEnabled ? 88 : 56, "ee5be59835d5a599")
                .put(8, marketKey).putLong(40, 101).putLong(48, 20);
        if (interestEnabled) {
            pool.putLong(56, CLOCK_TIME - 60).putLong(64, 21).putLong(72, 80_000_000);
        }
        ByteBuffer position = borsh(80, "f8ddfade25a740d1").put(8, marketKey)
                .put(40, VAULT_KEY).putLong(72, 11);
        ByteBuffer debt = borsh(48, "948512f2f8429c63").put(8, marketKey).putLong(40, 80);
        ByteBuffer clock = ByteBuffer.allocate(40).order(ByteOrder.LITTLE_ENDIAN).putLong(32, CLOCK_TIME);

        return response(FINAL_SLOT, vaultState(CUSTODY_KEY, true, autoRecallEnabled), tokenAccount(QUOTE_KEY, VAULT_KEY, 200),
                mintAccount(null, 0), mintAccount(VAULT_KEY, 100), account(PROGRAM, config.array()),
                mintAccount(null, 0, 9), tokenAccount(SPOT_KEY, VAULT_KEY, spotRaw),
                account(LENDING_PROGRAM, market.array()),
                published == 0 ? NullNode.getInstance() : account(LENDING_PROGRAM, oracle.array()),
                account(LENDING_PROGRAM, pool.array()), account(LENDING_PROGRAM, position.array()),
                tokenAccount(QUOTE_KEY, marketKey, 99), account(LENDING_PROGRAM, debt.array()),
                account("Sysvar1111111111111111111111111111111111111", clock.array()));
    }

    /**
     * 为指定判别字节和长度分配小端布局。
     * Allocates a little-endian layout with the given discriminator and length.
     *
     * @param length 总字节数。 Total byte count.
     * @param discriminatorHex Anchor 判别字节的十六进制编码。 Hex-encoded Anchor discriminator.
     * @return 带 Anchor 判别字节前缀的布局。 Layout prefixed with the Anchor discriminator.
     */
    private static ByteBuffer borsh(int length, String discriminatorHex) {
        return ByteBuffer.allocate(length).order(ByteOrder.LITTLE_ENDIAN)
                .put(0, HexFormat.of().parseHex(discriminatorHex));
    }

    /**
     * 用不同的末位字节产生可区分的 32 字节测试公钥，覆盖前导零。
     * Produces distinct 32-byte test keys with leading zeros and varying final bytes.
     *
     * @param last 最末字节的测试值。 Fixture value for the last byte.
     * @return 原始公钥字节。 Raw key bytes.
     */
    private static byte[] fixtureKey(int last) {
        /** 测试公钥原始字节。 Raw test public key. */
        byte[] key = new byte[32];
        key[key.length - 1] = (byte) last;
        return key;
    }

    /**
     * 组装已确认的金库状态、两个 Mint 及现金账户响应。
     * Builds a finalized batch with the vault, custody and both mints.
     *
     * @param slot 响应的观测 slot。 Observation slot returned in the response.
     * @param shareAuthority 份额 Mint 内存储的铸造权公钥字节。 Raw mint authority key stored in the share mint.
     * @return 包含四个账户的 RPC 响应。 RPC response containing four accounts.
     */
    private static ObjectNode batch(BigInteger slot, byte[] shareAuthority) {
        return response(slot, vaultState(CUSTODY_KEY), custodyAccount(), mintAccount(null, 0),
                mintAccount(shareAuthority, Long.MIN_VALUE));
    }

    /**
     * 组装经典 SPL Token 托管账户。
     * Builds the classic SPL custody account.
     *
     * @return 持有最大 u64 现金的托管账户。 Custody account holding the maximum u64 cash balance.
     */
    private static ObjectNode custodyAccount() {
        return tokenAccount(QUOTE_KEY, VAULT_KEY, -1);
    }

    /**
     * 用指定 Mint、托管授权和余额构造经典 SPL Token 账户。
     * Builds a classic SPL Token account with the specified mint, authority and balance.
     *
     * @param mint 代币 Mint 字节。 Raw token mint key.
     * @param authority 托管授权公钥字节。 Raw custody authority key.
     * @param balance 最小单位金额的 u64 位模式。 u64 amount bits in token base units.
     * @return SPL Token 账户的 RPC 数据。 RPC data for the SPL Token account.
     */
    private static ObjectNode tokenAccount(byte[] mint, byte[] authority, long balance) {
        /** 已初始化账户的原始定长布局。 Fixed-size raw layout of an initialized account. */
        ByteBuffer data = ByteBuffer.allocate(165).order(ByteOrder.LITTLE_ENDIAN);
        data.put(0, mint).put(32, authority).putLong(64, balance).put(108, (byte) 1);
        return account(VaultSnapshotRpc.TOKEN_PROGRAM_ID, data.array());
    }

    /**
     * 组装含账户判别字节与两种 Mint 绑定的 Anchor 状态。
     * Builds Anchor state with its discriminator and both mint bindings.
     *
     * @param custodyKey 将写入状态的现金托管账户公钥。 Custody public key to write into state.
     * @return 包含金库状态的 RPC 账户对象。 RPC account object containing vault state.
     */
    private static ObjectNode vaultState(byte[] custodyKey) {
        return vaultState(custodyKey, false);
    }

    /**
     * 构造纯现金或首次启用策略后的金库账户。
     * Builds a cash-only or strategy-activated vault account.
     *
     * @param custodyKey 现金托管账户字节。 Raw cash custody key.
     * @param strategy 金库是否已在链上启用策略。 Whether strategy is active on-chain.
     * @return 金库状态的 RPC 账户对象。 RPC account object containing vault state.
     */
    private static ObjectNode vaultState(byte[] custodyKey, boolean strategy) {
        return vaultState(custodyKey, strategy, false);
    }

    /**
     * 按需设置已启用策略的第 0 个能力位。
     * Sets capability bit zero for a strategy-enabled fixture as requested.
     *
     * @param custodyKey 现金托管账户原始字节。 Raw cash custody key.
     * @param strategy 金库是否已在链上启用策略。 Whether strategy is active on-chain.
     * @param autoRecallEnabled 第 0 位是否允许自动收回。 Whether bit zero enables automatic recall.
     * @return 金库状态的 RPC 账户对象。 RPC account object containing vault state.
     */
    private static ObjectNode vaultState(byte[] custodyKey, boolean strategy, boolean autoRecallEnabled) {
        /** 已部署的纯现金版本为 137 字节，启用策略后追加一个字节。 The deployed cash-only layout is 137 bytes and adds a byte on strategy activation. */
        ByteBuffer data = ByteBuffer.allocate(strategy ? 138 : 137);
        data.put(0, HexFormat.of().parseHex("d308e82b02987577"))
                .put(40, QUOTE_KEY).put(72, custodyKey).put(104, SHARE_KEY);
        if (strategy && autoRecallEnabled) {
            data.put(137, (byte) 1);
        }
        return account(PROGRAM, data.array());
    }

    /**
     * 组装初始化完成的六位小数经典 SPL Mint。
     * Builds an initialized classic SPL mint with six decimals.
     *
     * @param authority 铸造权公钥原始字节；空值代表无铸造权。 Raw mint authority key, or null for no authority.
     * @param supply 供给以 u64 小端位模式传入，单位是最小代币单位。 Supply supplied as u64 bits, in token base units.
     * @return Mint 的 RPC 账户对象。 RPC account object for the mint.
     */
    private static ObjectNode mintAccount(byte[] authority, long supply) {
        return mintAccount(authority, supply, 6);
    }

    /**
     * 构造给定精度的经典 SPL Mint。
     * Builds a classic SPL mint of the given decimal precision.
     *
     * @param authority 铸造权公钥字节，允许为空。 Raw mint authority key, or null.
     * @param supply u64 位模式的总供给最小单位数。 u64 bits of the supply in base units.
     * @param decimals Mint 的小数位数。 Mint decimal places.
     * @return Mint 的 RPC 账户对象。 RPC account object containing the mint.
     */
    private static ObjectNode mintAccount(byte[] authority, long supply, int decimals) {
        /** Mint 的固定布局。 Fixed mint layout. */
        ByteBuffer data = ByteBuffer.allocate(82).order(ByteOrder.LITTLE_ENDIAN);
        if (authority != null) {
            data.putInt(0, 1).put(4, authority);
        }
        data.putLong(36, supply).put(44, (byte) decimals).put(45, (byte) 1);
        return account(VaultSnapshotRpc.TOKEN_PROGRAM_ID, data.array());
    }

    /**
     * 将原始账户字节包装为 RPC 的 Base64 账户对象。
     * Wraps raw account bytes in a base64 RPC account object.
     *
     * @param owner 所有者程序公钥。 Owner program public key.
     * @param data 原始链上布局。 Raw on-chain layout.
     * @return RPC 账户元数据。 RPC account metadata.
     */
    private static ObjectNode account(String owner, byte[] data) {
        /** 具有归属信息和 Base64 布局的账户元数据。 Account metadata with owner and base64 layout. */
        ObjectNode info = JSON.createObjectNode().put("owner", owner).put("executable", false);
        info.putArray("data").add(Base64.getEncoder().encodeToString(data)).add("base64");
        return info;
    }

    /**
     * 组装一个按位置返回账户的 JSON-RPC 成功响应。
     * Builds a successful JSON-RPC response with positional accounts.
     *
     * @param slot 链上最终确认的 RPC 观测 slot。 Finalized on-chain RPC observation slot.
     * @param accounts 账户数组，按请求中的地址顺序。 Accounts in the order of requested addresses.
     * @return 完整的 JSON-RPC 响应信封。 Complete JSON-RPC response envelope.
     */
    private static ObjectNode response(BigInteger slot, JsonNode... accounts) {
        /** RPC 信封及带上下文的结果。 RPC envelope and result with context. */
        ObjectNode envelope = JSON.createObjectNode().put("jsonrpc", "2.0").put("id", 1);
        ObjectNode result = envelope.putObject("result");
        result.putObject("context").put("slot", slot);
        result.putArray("value").addAll(List.of(accounts));
        return envelope;
    }

    /**
     * 在回环接口开启本地 RPC 测试端点，并保留请求以供断言。
     * Opens a local loopback RPC endpoint and retains requests for assertions.
     *
     * @param responses 按请求顺序发送的 RPC 响应。 RPC responses to serve in request order.
     * @return 提供客户端及请求记录的测试夹具。 Fixture containing the client and captured requests.
     * @throws IOException 无法打开本地监听端口。 Cannot open a local listening port.
     */
    private static Fixture fixture(ObjectNode... responses) throws IOException {
        /** 本机临时 HTTP 服务及其接收的请求。 Temporary loopback HTTP server and its received requests. */
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        List<JsonNode> requests = new ArrayList<>();
        server.createContext("/", exchange -> {
            try (exchange) {
                /** 当前 HTTP 请求在调用序列中的位置和相应的模拟响应。 Position of this request and its scripted response. */
                int index = requests.size();
                requests.add(JSON.readTree(exchange.getRequestBody()));
                byte[] response = JSON.writeValueAsString(responses[index]).getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, response.length);
                exchange.getResponseBody().write(response);
            }
        });
        server.start();
        return new Fixture(server, new VaultActivityRpc("http://127.0.0.1:" + server.getAddress().getPort(), JSON), requests);
    }

    /**
     * 管理本地 RPC 测试资源。
     * Manages local RPC test resources.
     *
     * @param server 回环 HTTP 服务。 Loopback HTTP server.
     * @param rpc 测试共享 RPC 客户端。 Shared RPC client for the test.
     * @param requests 实际接收到的 RPC 请求。 Received RPC requests.
     */
    private record Fixture(HttpServer server, VaultActivityRpc rpc, List<JsonNode> requests) implements AutoCloseable {
        /** 释放本地端口及客户端资源。 Releases the local port and client resources. */
        @Override
        public void close() {
            server.stop(0);
            rpc.close();
        }
    }
}

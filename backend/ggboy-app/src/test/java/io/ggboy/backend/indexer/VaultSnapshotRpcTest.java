package io.ggboy.backend.indexer;

import com.sun.net.httpserver.HttpServer;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.common.utils.SolanaAddressUtil;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
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
        /** 已初始化账户的原始定长布局。 Fixed-size raw layout of an initialized account. */
        ByteBuffer data = ByteBuffer.allocate(165).order(ByteOrder.LITTLE_ENDIAN);
        data.put(0, QUOTE_KEY).put(32, VAULT_KEY).putLong(64, -1).put(108, (byte) 1);
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
        /** 已部署的 Vault 账户布局。 Deployed Vault account layout. */
        ByteBuffer data = ByteBuffer.allocate(137);
        data.put(0, HexFormat.of().parseHex("d308e82b02987577"))
                .put(40, QUOTE_KEY).put(72, custodyKey).put(104, SHARE_KEY);
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
        /** Mint 的固定布局。 Fixed mint layout. */
        ByteBuffer data = ByteBuffer.allocate(82).order(ByteOrder.LITTLE_ENDIAN);
        if (authority != null) {
            data.putInt(0, 1).put(4, authority);
        }
        data.putLong(36, supply).put(44, (byte) 6).put(45, (byte) 1);
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
    private static ObjectNode response(BigInteger slot, ObjectNode... accounts) {
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

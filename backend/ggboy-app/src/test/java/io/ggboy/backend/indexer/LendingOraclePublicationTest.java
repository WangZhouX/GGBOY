package io.ggboy.backend.indexer;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** 验证旧版测试价格的发布历史取证。 Verifies legacy test oracle publication evidence. */
class LendingOraclePublicationTest {

    /** Devnet 借贷部署的公开地址与固定测试时间。 Public Devnet lending deployment keys and fixed fixture time. */
    private static final String PROGRAM = "8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H";
    private static final String ADMIN = "8a6tkp7G5SKjXwQncu8vykXPGz7qyKgwGkEZB9MuKKaY";
    private static final String MARKET = "HzzMy19zYvQ6ZKfEgeMwuin3eMp8RFBWeRar9vzncUvE";
    private static final String ORACLE = "4NeM7WfjHBxwFzScEeGX7TAUc7FeMDrvKBf1f6iN9znw";
    private static final String SYSTEM = "11111111111111111111111111111111";
    private static final long PUBLISHED_AT = 1_795_437_548;
    /** 已核实 Devnet 指令里的 100,000,000 报价，以及独立编码的 u64 上限。 Verified Devnet data for price 100,000,000 and independently encoded u64 maximum. */
    private static final String SET_ONE_HUNDRED = "ScVupHSGWh4vNWgrR2gnk7";
    private static final String SET_UINT64_MAX = "ScVupHSGWh5f3UFHWRSbfL";
    /** 用于构造模拟 RPC 的 JSON 编解码器。 JSON codec for building RPC fixtures. */
    private static final JsonMapper JSON = JsonMapper.builder().build();

    /** 跳过观测后的签名、已回滚的交易与只读引用后，证明发布 slot。 Proves publication after skipping future signatures, failed transactions, and read-only references. */
    @Test
    void resolvesFinalizedPublisherWithoutLosingUnsignedPrice() {
        try (var rpc = new StubRpc(
                List.of(entry("future", 51, false), entry("failed", 48, true),
                        entry("readonly", 46, false), entry("setter", 45, false)),
                Map.of("readonly", transaction(SET_UINT64_MAX, false, true, PUBLISHED_AT + 30),
                        "setter", transaction(SET_UINT64_MAX, true, true, PUBLISHED_AT))
        )) {
            assertEquals(BigInteger.valueOf(45), resolve(rpc, BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE)));
        }
    }

    /** 最新写入的报价或时间不同，不允许历史同值报价替代。 A latest write with a different quote or timestamp cannot fall back to an older matching write. */
    @Test
    void rejectsConflictingNewerWrite() {
        for (ObjectNode invalid : List.of(transaction(SET_UINT64_MAX, true, true, PUBLISHED_AT),
                transaction(SET_ONE_HUNDRED, true, true, PUBLISHED_AT + 1),
                transaction(SET_ONE_HUNDRED, true, false, PUBLISHED_AT))) {
            try (var rpc = new StubRpc(List.of(entry("latest", 47, false), entry("older", 45, false)),
                    Map.of("latest", invalid, "older", transaction(SET_ONE_HUNDRED, true, true, PUBLISHED_AT)))) {
                assertNull(resolve(rpc, BigInteger.valueOf(100_000_000)));
            }
        }
    }

    /** 交易成功不足以证明后续内部调用成功。 Transaction success does not prove a later inner invocation succeeded. */
    @Test
    void rejectsOpaqueInnerWriteAfterVerifiedSetter() {
        /** 在同笔顶层发布后添加一次可能修改预言机的内部调用。 Adds an inner call that may alter the oracle after the top-level setter. */
        ObjectNode possibleMutation = transaction(SET_ONE_HUNDRED, true, true, PUBLISHED_AT);
        ObjectNode group = possibleMutation.withObjectProperty("meta").withArrayProperty("innerInstructions")
                .addObject().put("index", 0);
        group.putArray("instructions").add(instruction(SET_ONE_HUNDRED));
        try (var rpc = new StubRpc(List.of(entry("cpi", 46, false)), Map.of("cpi", possibleMutation))) {
            assertNull(resolve(rpc, BigInteger.valueOf(100_000_000)));
        }
    }

    /** 复用已证实的写入及只读记录，每次仍需查询最新的签名顺序。 Reuses conclusive writes and reads while discovering current signature order on every pass. */
    @Test
    void reusesConclusiveEvidenceWhileRefreshingSignatureHistory() {
        try (var rpc = new StubRpc(List.of(entry("readonly", 46, false), entry("setter", 45, false)),
                Map.of("readonly", transaction(SET_ONE_HUNDRED, false, true, PUBLISHED_AT),
                        "setter", transaction(SET_ONE_HUNDRED, true, true, PUBLISHED_AT)))) {
            var oracle = new LendingOraclePublication(rpc);
            BigInteger price = BigInteger.valueOf(100_000_000);

            assertEquals(BigInteger.valueOf(45), resolve(oracle, price));
            rpc.unavailable = Set.of("readonly", "setter");
            assertEquals(BigInteger.valueOf(45), resolve(oracle, price));
            assertEquals(2, rpc.signatureRequests);
            assertEquals(2, rpc.transactionRequests);

            // 当前报价改变时以前的发布不能复用，但同一 PDA 的只读证明仍可用。
            // A changed quote cannot reuse the setter, but can reuse the same oracle's no-write evidence.
            assertNull(resolve(oracle, price.add(BigInteger.ONE)));
            assertEquals(3, rpc.transactionRequests);
        }
    }

    /** 新出现的潜在写入读不到时停止，旧证据不能替代；后续恢复时重新读取新交易。 An unreadable newer potential write blocks older evidence and is fetched again when RPC recovers. */
    @Test
    void doesNotFallBackToCachedSetterWhenNewerTransactionIsUnknown() {
        try (var rpc = new StubRpc(List.of(entry("older", 45, false)),
                Map.of("older", transaction(SET_ONE_HUNDRED, true, true, PUBLISHED_AT),
                        "newer", transaction(SET_ONE_HUNDRED, true, true, PUBLISHED_AT)))) {
            var oracle = new LendingOraclePublication(rpc);
            BigInteger price = BigInteger.valueOf(100_000_000);
            assertEquals(BigInteger.valueOf(45), resolve(oracle, price));

            rpc.signatures = List.of(entry("newer", 49, false), entry("older", 45, false));
            rpc.unavailable = Set.of("newer", "older");
            assertNull(resolve(oracle, price));

            rpc.unavailable = Set.of("older");
            assertEquals(BigInteger.valueOf(49), resolve(oracle, price));
            assertEquals(3, rpc.signatureRequests);
            assertEquals(3, rpc.transactionRequests);
        }
    }

    /** 使用固定观察点调用发布证明。 Resolves a publication using the fixed observation context. */
    private static BigInteger resolve(VaultActivityRpc rpc, BigInteger priceRaw) {
        return resolve(new LendingOraclePublication(rpc), priceRaw);
    }

    /** 使用可复用的证明器读取固定观察点。 Resolves at the fixed observation context with a reusable verifier. */
    private static BigInteger resolve(LendingOraclePublication publication, BigInteger priceRaw) {
        return publication.resolve(PROGRAM, ADMIN, MARKET, ORACLE, priceRaw, PUBLISHED_AT, BigInteger.valueOf(50));
    }

    /** 构造单条已最终确认签名摘要。 Builds one finalized history entry. */
    private static VaultActivityData.Signature entry(String name, long slot, boolean failed) {
        return new VaultActivityData.Signature(name, BigInteger.valueOf(slot), failed);
    }

    /** 构造模拟的执行成功交易，调换账户顺序以表示管理员未签名。 Builds a successful fixture transaction, reordering keys to represent an unsigned administrator. */
    private static ObjectNode transaction(String data, boolean oracleWritable, boolean adminSigned, long timestamp) {
        /** 公钥顺序和消息头共同控制签名者与可写性。 Key order and the header determine signer status and writability. */
        ObjectNode result = JSON.createObjectNode().put("blockTime", timestamp);
        ObjectNode tx = result.putObject("transaction");
        tx.putArray("signatures").add("fixture");
        ObjectNode message = tx.putObject("message");
        message.putArray("accountKeys").add(adminSigned ? ADMIN : MARKET).add(ORACLE).add(SYSTEM)
                .add(PROGRAM).add(adminSigned ? MARKET : ADMIN);
        message.putObject("header").put("numRequiredSignatures", 1).put("numReadonlySignedAccounts", 0)
                .put("numReadonlyUnsignedAccounts", oracleWritable ? 3 : 4);
        message.putArray("instructions").add(instruction(data));
        result.putObject("meta").putArray("innerInstructions");
        return result;
    }

    /** 按已部署 Anchor IDL 构造价格发布指令。 Builds a price setter instruction using the deployed Anchor IDL. */
    private static ObjectNode instruction(String data) {
        /** 账户依次为管理员、市场、预言机和系统程序。 Accounts are administrator, market, oracle, and system program. */
        ObjectNode instruction = JSON.createObjectNode().put("programIdIndex", 3).put("data", data);
        instruction.putArray("accounts").add(0).add(4).add(1).add(2);
        return instruction;
    }

    /** 不发起网络请求的 RPC 替身，保留真实的调用契约。 RPC test double that keeps the real method contract without network requests. */
    private static final class StubRpc extends VaultActivityRpc {

        /** 每种测试场景的历史页和交易回包。 History page and transaction responses for each fixture case. */
        private List<VaultActivityData.Signature> signatures;
        private final Map<String, JsonNode> transactions;
        /** 模拟交易端点限流及核对实际调用次数。 Simulated transaction endpoint rate limits and request counters. */
        private Set<String> unavailable = Set.of();
        private int signatureRequests;
        private int transactionRequests;

        /** 注入需模拟的历史页和交易数据。 Supplies the fixture history page and transaction data. */
        StubRpc(List<VaultActivityData.Signature> signatures, Map<String, JsonNode> transactions) {
            super("http://127.0.0.1", JSON);
            this.signatures = signatures;
            this.transactions = transactions;
        }

        /** 核对查的是目标价格账户且达到观察槽。 Verifies the query targets the oracle and reaches the observation slot. */
        @Override
        List<VaultActivityData.Signature> listSignatures(String address, String before, BigInteger minContextSlot) {
            assertEquals(ORACLE, address);
            assertNull(before);
            assertEquals(BigInteger.valueOf(50), minContextSlot);
            signatureRequests++;
            return signatures;
        }

        /** 仅允许读取在观察范围内且执行成功的交易。 Allows lookups only for successful transactions in observation range. */
        @Override
        JsonNode getSuccessfulTransaction(VaultActivityData.Signature signature) {
            transactionRequests++;
            if (unavailable.contains(signature.value())) {
                throw new IllegalStateException("Fixture transaction endpoint rate limit");
            }
            if (!transactions.containsKey(signature.value())) {
                throw new AssertionError("Unexpected transaction read: " + signature.value());
            }
            return transactions.get(signature.value());
        }
    }
}

package io.ggboy.backend.indexer;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * 验证索引器使用最终确认读取、保留精度与日志顺序，遇到不完整历史时停止推进。
 * Verifies finalized reads, exact values, ordered logs, and rejection of incomplete history.
 */
class VaultActivityRpcTest {

    /** 可解码为 32 字节的测试程序公钥。 Fixture program public key encoding 32 bytes. */
    private static final String PROGRAM = "FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75";

    /** 两个可解码为 64 字节的签名，用于验证分页和详情关联。 Two 64-byte fixture signatures for pagination and detail correlation. */
    private static final String NEW_SIGNATURE = "1".repeat(64);
    private static final String OLD_SIGNATURE = "1".repeat(63) + "2";

    /** 作为响应中的最大 u64 slot，超过有符号 long。 Maximal u64 slot for the response, exceeding a signed long. */
    private static final BigInteger MAX_SLOT = new BigInteger("18446744073709551615");

    /**
     * 验证分页请求保留 before，解析成功、失败和历史状态为空的签名。
     * Verifies the paging request preserves its before cursor and decodes successful, failed, and archived signatures.
     *
     * @throws IOException 无法绑定本机测试端口。 The local test port cannot be bound.
     */
    @Test
    void listsFinalizedSignaturesInRpcOrder() throws IOException {
        /** 模拟两条最终确认的签名，较早一条已执行失败。 Two finalized signatures with a failed older transaction. */
        String result = """
                [{"signature":"%s","slot":%s,"err":null,"confirmationStatus":"finalized"},
                 {"signature":"%s","slot":123,"err":{"InstructionError":[0,"InvalidArgument"]},"confirmationStatus":null}]
                """.formatted(NEW_SIGNATURE, MAX_SLOT, OLD_SIGNATURE);
        try (var fixture = fixture(200, success(result))) {
            assertEquals(List.of(
                    new VaultActivityData.Signature(NEW_SIGNATURE, MAX_SLOT, false),
                    new VaultActivityData.Signature(OLD_SIGNATURE, BigInteger.valueOf(123), true)
            ), fixture.rpc().listSignatures(PROGRAM, OLD_SIGNATURE));

            /** 发往本地测试服务器的实际 JSON-RPC 请求。 JSON-RPC request received by the local fixture server. */
            JsonNode request = fixture.request().get();
            assertEquals("getSignaturesForAddress", request.path("method").textValue());
            assertEquals(PROGRAM, request.at("/params/0").textValue());
            assertEquals("finalized", request.at("/params/1/commitment").textValue());
            assertEquals(100, request.at("/params/1/limit").intValue());
            assertEquals(OLD_SIGNATURE, request.at("/params/1/before").textValue());
        }
    }

    /**
     * 验证详情请求支持 v1 且不会重排事件前的日志。
     * Verifies v1 support and preservation of the original log order before an event.
     *
     * @throws IOException 无法绑定本机测试端口。 The local test port cannot be bound.
     */
    @Test
    void readsMatchingTransactionAndPreservesLogOrder() throws IOException {
        /** 已在签名页确认的签名和 slot。 Signature and slot already discovered in the finalized page. */
        var signature = new VaultActivityData.Signature(NEW_SIGNATURE, BigInteger.valueOf(123), false);
        /** 已最终确认的交易详情，区块时间为 Unix 秒。 Finalized transaction detail with its timestamp expressed in Unix seconds. */
        String result = """
                {"slot":123,"blockTime":1704067200,"transaction":{"signatures":["%s","%s"]},
                 "version":1,"meta":{"err":null,"logMessages":["before","Program data: event","after"]}}
                """.formatted(NEW_SIGNATURE, OLD_SIGNATURE);
        try (var fixture = fixture(200, success(result))) {
            assertEquals(new VaultActivityData.Transaction(signature, OffsetDateTime.parse("2024-01-01T00:00:00Z"),
                    List.of("before", "Program data: event", "after")), fixture.rpc().getTransaction(signature));

            /** 请求中的交易详情配置。 Transaction detail settings received in the request. */
            JsonNode request = fixture.request().get();
            assertEquals("getTransaction", request.path("method").textValue());
            assertEquals(NEW_SIGNATURE, request.at("/params/0").textValue());
            assertEquals("finalized", request.at("/params/1/commitment").textValue());
            assertEquals("json", request.at("/params/1/encoding").textValue());
            assertEquals(1, request.at("/params/1/maxSupportedTransactionVersion").intValue());
        }
    }

    /**
     * 借贷日志的签名者从静态消息账户读取，只接受消息头声明的签名数量。
     * Lending logs use signers from the static message keys and only accept the count declared by the message header.
     *
     * @throws IOException 无法绑定本机测试端口。 The local test port cannot be bound.
     */
    @Test
    void readsOnlyDeclaredLendingSigners() throws IOException {
        /** 当前响应所在的签名和 slot。 Signature and slot selected for this response. */
        var signature = new VaultActivityData.Signature(NEW_SIGNATURE, BigInteger.valueOf(123), false);
        /** 模拟同时存有签名者和非签名者账户的版本化交易。 Versioned transaction with a signer and a non-signer. */
        String result = """
                {"slot":123,"blockTime":null,"transaction":{"signatures":["%s"],"message":{
                  "header":{"numRequiredSignatures":%d},"accountKeys":["%s","11111111111111111111111111111111"]}},
                 "version":0,"meta":{"err":null,"logMessages":["Program data: event"]}}
                """;
        try (var fixture = fixture(200, success(result.formatted(NEW_SIGNATURE, 1, PROGRAM)))) {
            /** 只有第一个静态账户与签名数组中的一项对应。 Only the first static key corresponds to the signature array. */
            var transaction = fixture.rpc().getLendingTransaction(signature);
            assertEquals(Set.of(PROGRAM), transaction.signers());
            assertEquals(List.of("Program data: event"), transaction.transaction().logs());
        }
        try (var fixture = fixture(200, success(result.formatted(NEW_SIGNATURE, 2, PROGRAM)))) {
            assertThrows(IllegalStateException.class, () -> fixture.rpc().getLendingTransaction(signature));
        }
    }

    /**
     * 交易查不到、slot 对不上或日志缺失时抛错，供上层重试。
     * Throws for missing transactions, mismatched slots, or absent logs so the caller can retry.
     *
     * @throws IOException 无法绑定本机测试端口。 The local test port cannot be bound.
     */
    @Test
    void rejectsIncompleteOrMismatchedHistory() throws IOException {
        /** 已在签名页确认的签名和 slot。 Signature and slot already discovered in the finalized page. */
        var signature = new VaultActivityData.Signature(NEW_SIGNATURE, BigInteger.valueOf(123), false);
        /** 未提供日志的交易详情，slot 单独传入以覆盖确认不一致。 Transaction detail without logs, with a variable slot to exercise disagreement. */
        String noLogs = """
                {"slot":%d,"blockTime":null,"transaction":{"signatures":["%s"]},"meta":{"err":null,"logMessages":null}}
                """;
        // result 是会导致该轮停止的具体响应。 result is one response that must stop processing.
        for (String result : List.of("null", noLogs.formatted(124, NEW_SIGNATURE), noLogs.formatted(123, NEW_SIGNATURE))) {
            try (var fixture = fixture(200, success(result))) {
                assertThrows(IllegalStateException.class, () -> fixture.rpc().getTransaction(signature));
            }
        }
    }

    /**
     * 限流与 JSON-RPC 错误只保留诊断码，路径参数和响应密钥不会进异常消息。
     * Retains diagnostic codes for rate limits and JSON-RPC errors without leaking request or response credentials.
     *
     * @throws IOException 无法绑定本机测试端口。 The local test port cannot be bound.
     */
    @Test
    void reportsRateLimitAndRpcErrorsWithoutCredentials() throws IOException {
        try (var fixture = fixture(429, "private-response")) {
            /** HTTP 限流错误的最终消息。 Message for the HTTP rate limit. */
            var error = assertThrows(IllegalStateException.class, () -> fixture.rpc().listSignatures(PROGRAM, null));
            assertEquals("Devnet RPC getSignaturesForAddress returned HTTP 429", error.getMessage());
        }
        try (var fixture = fixture(200, """
                {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"private-response"}}
                """)) {
            /** JSON-RPC 协议错误的最终消息。 Message for the JSON-RPC protocol error. */
            var error = assertThrows(IllegalStateException.class, () -> fixture.rpc().listSignatures(PROGRAM, null));
            assertEquals("Devnet RPC getSignaturesForAddress rejected the request (code -32001)", error.getMessage());
            assertFalse(error.toString().contains("private"));
        }
    }

    /**
     * 将测试结果包装为与实际 JSON-RPC 成功请求同样的信封。
     * Wraps the fixture result in a valid JSON-RPC success envelope.
     *
     * @param result 序列化为 JSON 的方法结果。 Method result serialized as JSON.
     * @return 完整 JSON-RPC 响应。 Complete JSON-RPC response.
     */
    private static String success(String result) {
        return "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" + result + '}';
    }

    /**
     * 在环回地址模拟一个只返回固定响应的 JSON-RPC 服务。
     * Hosts a fixed JSON-RPC response on a loopback interface.
     *
     * @param status 返回的 HTTP 状态码。 Returned HTTP status.
     * @param body 返回的 UTF-8 响应正文。 Returned UTF-8 response body.
     * @return HTTP 客户端、记录的请求和服务关闭句柄。 HTTP client, captured request, and server cleanup handle.
     * @throws IOException 无法绑定本机测试端口。 The local test port cannot be bound.
     */
    private static Fixture fixture(int status, String body) throws IOException {
        /** 测试的 JSON 编解码器与收到的请求。 Test JSON codec and the captured request. */
        JsonMapper json = JsonMapper.builder().build();
        var request = new AtomicReference<JsonNode>();
        /** 只对本机开放、自动分配端口的测试服务器。 Local-only test server with an automatically allocated port. */
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        /** 以 UTF-8 编码的固定响应正文。 Fixed response body encoded as UTF-8. */
        byte[] response = body.getBytes(StandardCharsets.UTF_8);
        // exchange 是测试客户端的一次请求与响应。 exchange is one request and response from the fixture client.
        server.createContext("/", exchange -> {
            try (exchange) {
                request.set(json.readTree(exchange.getRequestBody()));
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(status, response.length);
                exchange.getResponseBody().write(response);
            }
        });
        server.start();
        return new Fixture(server,
                new VaultActivityRpc("http://127.0.0.1:" + server.getAddress().getPort() + "/?token=private-url", json), request);
    }

    /**
     * 维护临时 HTTP 服务和待断言的请求。
     * Owns the temporary HTTP server and captured request.
     *
     * @param server 测试 HTTP 服务。 Test HTTP server.
     * @param rpc 被测 RPC 客户端。 RPC client being tested.
     * @param request HTTP 服务记录的最新请求体。 Latest request body captured by the HTTP server.
     */
    private record Fixture(HttpServer server, VaultActivityRpc rpc, AtomicReference<JsonNode> request)
            implements AutoCloseable {

        /** 释放测试客户端和服务端连接。 Releases test connections on the client and server. */
        @Override
        public void close() {
            server.stop(0);
            rpc.close();
        }
    }
}

package io.ggboy.backend.indexer;

import io.ggboy.common.utils.SolanaAddressUtil;
import io.ggboy.common.utils.UnsignedIntegerUtil;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 只读访问 Devnet 的最终确认签名、交易日志与账户。调用者负责重试。
 * Reads finalized Devnet signatures, transaction logs and accounts. Callers own retries.
 */
@Component
class VaultActivityRpc implements AutoCloseable {

    /** 每次请求最多读取的签名数，按从新到旧的顺序。 Maximum signatures per request, newest first. */
    static final int PAGE_SIZE = 100;

    /** 建立 HTTP 连接和等待单次 RPC 响应的时限。 Time limits for opening a connection and awaiting one RPC response. */
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(12);

    /** 请求始终读取已经最终确认的数据。 All requests read at finalized commitment. */
    private static final String COMMITMENT = "finalized";

    /** 支持使用相同日志和签名字段的 legacy、v0 和 v1 交易。 Accepts legacy, v0, and v1 transactions with common log and signature fields. */
    private static final int MAX_TRANSACTION_VERSION = 1;

    /** 服务端配置的 RPC 地址，路径或查询参数可含访问凭据。 Configured RPC endpoint whose path or query may contain credentials. */
    private final URI endpoint;

    /** 复用的 JDK HTTP 客户端，禁用跨地址重定向。 Reusable JDK HTTP client with redirects disabled. */
    private final HttpClient http;

    /** Spring 注入的 Jackson JSON 编解码器。 Spring-injected Jackson JSON codec. */
    private final ObjectMapper json;

    /**
     * 初始化连接配置，收到索引任务前不发送 RPC 请求。
     * Prepares connection settings without sending RPC requests until an indexing task runs.
     *
     * @param endpointUrl Devnet HTTP 或 HTTPS JSON-RPC 地址。 Devnet HTTP or HTTPS JSON-RPC endpoint.
     * @param json Spring 管理的 JSON 编解码器。 Spring-managed JSON codec.
     */
    VaultActivityRpc(
            @Value("${ggboy.devnet-vault-indexer.rpc-url:https://api.devnet.solana.com}") String endpointUrl,
            ObjectMapper json
    ) {
        // 配置错误时只描述要求，避免把含访问凭据的 URI 带入异常。
        // Describe invalid configuration without including the URI, which may contain credentials.
        try {
            this.endpoint = URI.create(endpointUrl);
        } catch (IllegalArgumentException ignored) {
            throw new IllegalArgumentException("Invalid Devnet RPC endpoint URI");
        }
        if (!("https".equalsIgnoreCase(endpoint.getScheme()) || "http".equalsIgnoreCase(endpoint.getScheme()))
                || endpoint.getHost() == null || endpoint.getFragment() != null || endpoint.getUserInfo() != null
                || endpoint.getPort() == 0 || endpoint.getPort() > 65_535) {
            throw new IllegalArgumentException("Devnet RPC endpoint must be an absolute HTTP(S) URI without a fragment or user info");
        }
        this.json = json;
        this.http = HttpClient.newBuilder()
                .connectTimeout(CONNECT_TIMEOUT)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /**
     * 按从新到旧的顺序读取一页程序相关的最终确认签名。
     * Fetches one newest-first page of finalized signatures referencing the program.
     *
     * @param programId 待索引的 GGBOY 程序公钥。 Public key of the indexed GGBOY program.
     * @param before 排除的上一页末尾签名，首页为空。 Exclusive oldest signature from the prior page, or null for the first page.
     * @return 最多 100 条已验证的签名及执行结果。 At most 100 validated signatures and execution statuses.
     * @throws IllegalStateException RPC 请求失败或返回无效页。 The RPC call fails or returns an invalid page.
     */
    List<VaultActivityData.Signature> listSignatures(String programId, String before) {
        return listSignatures(programId, before, null);
    }

    /**
     * 在不早于指定账户观测的最终确认上下文中读取历史签名页。
     * Reads signature history from a finalized context at least as new as the specified account observation.
     *
     * @param address 查询交易消息中引用的公钥。 Public key referenced by the transaction message.
     * @param before 排除的上一页签名，首页为空。 Exclusive last signature of the previous page, or null.
     * @param minContextSlot 最低可接受的 finalized 观测 slot，为空则不限制。 Minimum acceptable finalized context slot, or null for no bound.
     * @return 最多一百条经过校验的签名。 Up to one hundred verified signatures.
     */
    List<VaultActivityData.Signature> listSignatures(String address, String before, BigInteger minContextSlot) {
        SolanaAddressUtil.requirePublicKey(address, "address");

        /** 签名查询选项，包含最终确认级别、页大小和观测下限。 Signature query options with finalized commitment, page size and optional observation floor. */
        ObjectNode options = json.createObjectNode().put("commitment", COMMITMENT).put("limit", PAGE_SIZE);
        if (minContextSlot != null) {
            options.put("minContextSlot", UnsignedIntegerUtil.requireUint64(minContextSlot));
        }
        if (before != null) {
            SolanaAddressUtil.requireSignature(before, "before");
            options.put("before", before);
        }

        /** RPC 签名页，保持原有从新到旧的顺序。 RPC signature page in its original newest-first order. */
        JsonNode result = call("getSignaturesForAddress", json.getNodeFactory().stringNode(address), options);
        if (!result.isArray() || result.size() > PAGE_SIZE) {
            throw new IllegalStateException("Devnet RPC returned an invalid signature page");
        }

        /** 校验后供补扫任务使用的签名。 Validated signatures for the backfill task. */
        List<VaultActivityData.Signature> signatures = new ArrayList<>(result.size());
        // entry 为当前签名的链上确认摘要。 entry is the on-chain confirmation summary for this signature.
        for (JsonNode entry : result) {
            signatures.add(readSignature(entry));
        }
        return List.copyOf(signatures);
    }

    /**
     * 读取签名、slot 与发现结果一致的最终确认成功交易及原始日志。
     * Reads a successful finalized transaction whose primary signature and slot match discovery, preserving its raw log order.
     *
     * @param signature 来自签名页、执行成功的签名及 slot。 Successful signature and slot from a discovery page.
     * @return 已校验的交易，包括可为空的 UTC 区块时间和完整的有序日志行。 Verified transaction including optional UTC block time and ordered log lines.
     * @throws IllegalArgumentException 签名页标识这笔交易失败。 The signature page reports this transaction as failed.
     * @throws IllegalStateException 交易暂不可读、RPC 失败或返回的交易详情无效。 The transaction is unavailable, the RPC call fails, or transaction details are invalid.
     */
    VaultActivityData.Transaction getTransaction(VaultActivityData.Signature signature) {
        return readTransaction(signature, getSuccessfulTransaction(signature));
    }

    /**
     * 为借贷事件同时读取日志和交易消息中实际签名的静态公钥。
     * Fetches logs and the static public keys that signed the message for lending event verification.
     *
     * @param signature 已最终确认并执行成功的交易。 Successful finalized transaction to verify.
     * @return 经过 RPC 结构校验的交易与消息签名者。 RPC-validated transaction and message signers.
     */
    LendingTransaction getLendingTransaction(VaultActivityData.Signature signature) {
        /** 同一最终确认的响应同时用于校验事件日志与签名者。 One finalized response supplies both logs and signers. */
        JsonNode result = getSuccessfulTransaction(signature);
        /** 消息头只把静态账户列表前 numRequiredSignatures 项标为签名者。 Only the first numRequiredSignatures static message keys are signers. */
        JsonNode message = result.path("transaction").path("message");
        JsonNode count = message.path("header").path("numRequiredSignatures");
        JsonNode keys = message.path("accountKeys");
        /** 消息静态签名者数量需与交易签名数组完全一致。 The message's static signer count must match the transaction signature array. */
        int signerCount = result.path("transaction").path("signatures").size();
        if (!count.isInt() || count.intValue() != signerCount || signerCount < 1
                || !keys.isArray() || signerCount > keys.size()) {
            throw new IllegalStateException("Devnet RPC returned invalid message signer counts");
        }

        /** 已校验并去重的交易签名者公钥。 Validated distinct transaction signer keys. */
        Set<String> signers = new HashSet<>();
        for (int index = 0; index < signerCount; index++) {
            /** 不将地址表加载项或消息中的其他只读账户误认为签名者。 Do not treat loaded or other read-only accounts as signers. */
            String key = keys.path(index).textValue();
            String transactionSignature = result.path("transaction").path("signatures").path(index).textValue();
            if (key == null || transactionSignature == null || !signers.add(key)) {
                throw new IllegalStateException("Devnet RPC returned invalid or duplicate message signer keys");
            }
            SolanaAddressUtil.requirePublicKey(key, "signer key");
            SolanaAddressUtil.requireSignature(transactionSignature, "transaction signature");
        }
        return new LendingTransaction(readTransaction(signature, result), Set.copyOf(signers));
    }

    /**
     * 借贷索引使用的日志及消息签名证明。
     * Logs and message signer evidence for lending activity indexing.
     *
     * @param transaction 最终确认成功的交易和区块时间。 Successful finalized transaction and block time.
     * @param signers 交易消息中已签名的公钥。 Public keys that signed the transaction message.
     */
    record LendingTransaction(VaultActivityData.Transaction transaction, Set<String> signers) {
    }

    /**
     * 验证读取结果与签名发现中记录的成功交易、主签名和 slot 相同。
     * Verifies the response matches the successful transaction, primary signature, and slot from signature discovery.
     *
     * @param signature 从最终确认签名页发现的记录。 Entry from finalized signature discovery.
     * @return 通过匹配校验的原始 RPC 结果。 Raw RPC result after identity and status verification.
     */
    JsonNode getSuccessfulTransaction(VaultActivityData.Signature signature) {
        if (signature.failed()) {
            throw new IllegalArgumentException("Only successful finalized transactions can be fetched for activity indexing");
        }
        SolanaAddressUtil.requireSignature(signature.value(), "signature");

        /** 请求 JSON 交易结构及全部常见版本的元数据。 Requests the JSON transaction shape and metadata for supported transaction versions. */
        ObjectNode options = json.createObjectNode()
                .put("commitment", COMMITMENT)
                .put("encoding", "json")
                .put("maxSupportedTransactionVersion", MAX_TRANSACTION_VERSION);
        /** 已最终确认的交易详情，RPC 尚未提供时返回 null。 Finalized transaction details, or null when unavailable from RPC. */
        JsonNode result = call("getTransaction", json.getNodeFactory().stringNode(signature.value()), options);
        if (result.isNull()) {
            // 不把 RPC 历史缺失当作已处理，外层稍后从同一个检查点重试。
            // Leave unavailable history unprocessed so the caller can retry from the same checkpoint.
            throw new IllegalStateException("Devnet RPC could not read finalized transaction " + signature.value());
        }

        /** 第一项签名是交易主签名，元数据的 err 必须明确为 null。 The first signature is primary, and the metadata must explicitly report null err. */
        JsonNode transactionSignatures = result.path("transaction").path("signatures");
        JsonNode metadata = result.path("meta");
        if (!transactionSignatures.isArray() || !signature.value().equals(transactionSignatures.path(0).textValue())
                || !signature.slot().equals(readSlot(result.path("slot"))) || !metadata.path("err").isNull()) {
            throw new IllegalStateException("Devnet RPC returned mismatched or unsuccessful transaction " + signature.value());
        }
        return result;
    }

    /**
     * 读取已经验证的交易日志及链上区块时间。
     * Parses the original logs and on-chain block time of a verified transaction.
     *
     * @param signature 与 RPC 详情一致的最终确认签名。 Finalized signature matching the RPC details.
     * @param result 已核对签名、slot 和成功状态的 RPC 数据。 RPC response with verified signature, slot, and success status.
     * @return 保留日志顺序和带时区时间的交易数据。 Transaction preserving log order and UTC time.
     */
    private VaultActivityData.Transaction readTransaction(VaultActivityData.Signature signature, JsonNode result) {
        /** 原始交易日志，保留全部下标用于得到稳定事件序号。 Raw logs with all positions preserved for stable event indexes. */
        JsonNode logMessages = result.path("meta").path("logMessages");
        if (!logMessages.isArray()) {
            throw new IllegalStateException("Devnet RPC returned no log array for transaction " + signature.value());
        }
        /** 逐行校验后的日志。 Logs validated line by line. */
        List<String> logs = new ArrayList<>(logMessages.size());
        // line 为原始日志序列中当前位置的值。 line is the value at the current raw log position.
        for (JsonNode line : logMessages) {
            if (!line.isTextual()) {
                throw new IllegalStateException("Devnet RPC returned a non-text log for transaction " + signature.value());
            }
            logs.add(line.textValue());
        }
        return new VaultActivityData.Transaction(signature, readBlockTime(result.path("blockTime")), List.copyOf(logs));
    }

    /**
     * 在同一最终确认上下文读取多个账户的原始数据，保持请求顺序。
     * Reads raw account data in request order from one finalized context.
     *
     * @param addresses 所读账户的 Solana 公钥，最多 100 个。 Public keys of up to 100 accounts to read.
     * @param minContextSlot RPC 观测 slot 的最小值，允许为空。 Minimum acceptable RPC observation slot, or null.
     * @return 原始的上下文及账户元数据，供账户读取器校验。 Raw context and account metadata for the account reader to validate.
     */
    JsonNode getMultipleAccounts(List<String> addresses, BigInteger minContextSlot) {
        if (addresses.isEmpty() || addresses.size() > 100) {
            throw new IllegalArgumentException("Devnet account batch must contain between 1 and 100 addresses");
        }

        /** 向 RPC 发送的已校验账户地址数组。 Validated account address array sent to RPC. */
        var keys = json.createArrayNode();
        // 逐个验证公钥，这样读取配置出错时不会向 RPC 发送无效地址。
        // Validate each key so a bad registry entry never sends an invalid address to RPC.
        for (String address : addresses) {
            SolanaAddressUtil.requirePublicKey(address, "account address");
            keys.add(address);
        }

        /** 指定最终确认与 Base64 二进制数据，保留原始数值的全精度。 Select finalized base64 account data to preserve exact on-chain values. */
        ObjectNode options = json.createObjectNode().put("commitment", COMMITMENT).put("encoding", "base64");
        if (minContextSlot != null) {
            options.put("minContextSlot", UnsignedIntegerUtil.requireUint64(minContextSlot));
        }
        return call("getMultipleAccounts", keys, options);
    }

    /**
     * 按借贷账户首字段的市场公钥读取同一最终确认 slot 的市场明细。
     * Reads market detail accounts at one finalized slot by matching the first field of lending accounts.
     *
     * @param programId 拥有明细账户的借贷程序公钥。 Lending program public key owning the detail accounts.
     * @param market 账户 Anchor 标识之后保存的市场公钥。 Market public key stored directly after each account discriminator.
     * @param minContextSlot 不允许落后于该 slot，允许为空。 Minimum allowed slot, or null.
     * @return 含上下文及原始账户数组的 RPC 结果。 RPC result with context and raw accounts.
     */
    JsonNode getLendingMarketAccounts(String programId, String market, BigInteger minContextSlot) {
        SolanaAddressUtil.requirePublicKey(programId, "lending program");
        SolanaAddressUtil.requirePublicKey(market, "lending market");

        // 市场公钥紧随常规 Anchor 账户的 8 字节判别符，RPC 端先排除其他市场。
        // The market key follows the standard eight-byte Anchor discriminator, filtering other markets at the node.
        ObjectNode options = json.createObjectNode()
                .put("commitment", COMMITMENT).put("encoding", "base64").put("withContext", true);
        options.putArray("filters").addObject().putObject("memcmp").put("offset", 8).put("bytes", market);
        if (minContextSlot != null) {
            options.put("minContextSlot", UnsignedIntegerUtil.requireUint64(minContextSlot));
        }
        return call("getProgramAccounts", json.getNodeFactory().stringNode(programId), options);
    }

    /**
     * 校验签名、无符号 slot 和执行状态，拒绝 RPC 端把未最终确认的数据混入签名页。
     * Validates the signature, unsigned slot, and execution status, rejecting non-finalized rows from the RPC page.
     *
     * @param entry 单条 RPC 签名摘要。 One RPC signature summary.
     * @return 最终确认签名摘要，包含执行失败标记。 Finalized signature summary with its execution failure flag.
     */
    private VaultActivityData.Signature readSignature(JsonNode entry) {
        /** 从签名页读取的签名、最终确认状态和执行错误。 Signature, commitment status, and execution error from the discovery page. */
        JsonNode signature = entry.path("signature");
        JsonNode confirmation = entry.path("confirmationStatus");
        JsonNode error = entry.path("err");
        // 历史记录允许 confirmationStatus 为 null。查询级别已明确要求 finalized。
        // Archived rows may have null confirmationStatus. The request already requires finalized commitment.
        if (!signature.isTextual() || (!confirmation.isNull() && !COMMITMENT.equals(confirmation.textValue()))
                || !(error.isNull() || error.isObject() || error.isTextual())) {
            throw new IllegalStateException("Devnet RPC returned an invalid finalized signature entry");
        }
        try {
            SolanaAddressUtil.requireSignature(signature.textValue(), "signature");
        } catch (IllegalArgumentException ignored) {
            throw new IllegalStateException("Devnet RPC returned a malformed transaction signature");
        }
        return new VaultActivityData.Signature(signature.textValue(), readSlot(entry.path("slot")), !error.isNull());
    }

    /**
     * 读取不损失精度的链上 u64 slot。
     * Reads the chain slot as a u64 without losing precision.
     *
     * @param value RPC 返回的 JSON 整数值。 JSON integer returned by RPC.
     * @return 链上 slot。 On-chain slot.
     */
    private BigInteger readSlot(JsonNode value) {
        if (!value.isIntegralNumber()) {
            throw new IllegalStateException("Devnet RPC returned a non-integer transaction slot");
        }
        try {
            return UnsignedIntegerUtil.requireUint64(value.bigIntegerValue());
        } catch (IllegalArgumentException ignored) {
            throw new IllegalStateException("Devnet RPC returned a transaction slot outside the u64 range");
        }
    }

    /**
     * 将 RPC 的 Unix 秒转换为 UTC，保留链上未知时间为空的语义。
     * Converts RPC Unix seconds to UTC, preserving null when chain time is unavailable.
     *
     * @param value JSON 整数秒或 null。 JSON integer seconds or null.
     * @return UTC 区块时间，缺失时为空。 UTC block time, or null when unavailable.
     */
    private OffsetDateTime readBlockTime(JsonNode value) {
        if (value.isNull()) {
            return null;
        }
        if (!value.isIntegralNumber() || !value.canConvertToLong()) {
            throw new IllegalStateException("Devnet RPC returned an invalid transaction block time");
        }
        try {
            return Instant.ofEpochSecond(value.longValue()).atOffset(ZoneOffset.UTC);
        } catch (DateTimeException ignored) {
            throw new IllegalStateException("Devnet RPC returned a transaction block time outside the UTC timestamp range");
        }
    }

    /**
     * 发送只读 JSON-RPC 调用并验证响应信封。
     * Sends a read-only JSON-RPC call and validates its response envelope.
     *
     * @param method Solana HTTP RPC 方法。 Solana HTTP RPC method.
     * @param subject 第一位置参数，为公钥、签名或公钥数组。 First positional parameter, a key, signature or array of keys.
     * @param options 第二位置参数，包含读取配置。 Second positional parameter with read settings.
     * @return 已通过协议验证的结果字段，可为 JSON null。 Protocol-validated result field, which may be JSON null.
     */
    private JsonNode call(String method, JsonNode subject, ObjectNode options) {
        /** 每笔 HTTP 请求独立对应 JSON-RPC 数字 ID 1。 Each HTTP request independently uses JSON-RPC numeric ID 1. */
        ObjectNode payload = json.createObjectNode().put("jsonrpc", "2.0").put("id", 1).put("method", method);
        payload.putArray("params").add(subject).add(options);

        /** 发送到已配置端点的单次请求。 A single request to the configured endpoint. */
        HttpRequest request = HttpRequest.newBuilder(endpoint)
                .timeout(REQUEST_TIMEOUT)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(payload)))
                .build();

        /** RPC 的 HTTP 状态和 JSON 文本。 RPC HTTP status and JSON text. */
        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Devnet RPC " + method + " was interrupted");
        } catch (IOException error) {
            // HTTP 异常或响应可能含 RPC 凭据。调度日志只记录方法、错误类型或状态码。
            // HTTP exceptions or responses may contain RPC credentials. Log only the method and error type or status.
            throw new IllegalStateException("Devnet RPC " + method + " failed (" + error.getClass().getSimpleName() + ")");
        }
        if (response.statusCode() != 200) {
            throw new IllegalStateException("Devnet RPC " + method + " returned HTTP " + response.statusCode());
        }

        /** JSON-RPC 信封，未通过协议验证时禁止继续处理。 JSON-RPC envelope, which must pass protocol checks before processing. */
        JsonNode envelope;
        try {
            envelope = json.readTree(response.body());
        } catch (JacksonException ignored) {
            throw new IllegalStateException("Devnet RPC " + method + " returned invalid JSON");
        }
        if (envelope == null || !envelope.isObject() || !"2.0".equals(envelope.path("jsonrpc").textValue())
                || !envelope.path("id").isInt() || envelope.path("id").intValue() != 1) {
            throw new IllegalStateException("Devnet RPC " + method + " returned an invalid response envelope");
        }

        /** 若 RPC 返回错误，仅记录数字错误码，避免把响应正文输出到日志。 When RPC reports an error, retain only its numeric code so the response body is absent from logs. */
        JsonNode rpcError = envelope.path("error");
        if (!rpcError.isMissingNode()) {
            /** RPC 错误码，格式异常时使用固定文本。 RPC error code, with fixed text for an invalid code. */
            JsonNode code = rpcError.path("code");
            throw new IllegalStateException("Devnet RPC " + method + " rejected the request (code "
                    + (code.isIntegralNumber() ? code.asText() : "unknown") + ")");
        }

        /** 本次方法的实际返回值，字段缺失与 JSON null 不同。 Result of this method, where a missing field differs from JSON null. */
        JsonNode result = envelope.path("result");
        if (result.isMissingNode()) {
            throw new IllegalStateException("Devnet RPC " + method + " returned no result field");
        }
        return result;
    }

    /**
     * Spring 上下文关闭时释放 HTTP 客户端。
     * Releases the HTTP client when the Spring context closes.
     */
    @Override
    @PreDestroy
    public void close() {
        http.close();
    }
}

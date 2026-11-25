package io.ggboy.backend.indexer;

import tools.jackson.databind.JsonNode;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 从最终确认历史核对旧版测试预言机缺失的发布 slot。
 * Proves the publication slot omitted by the legacy test oracle account using finalized history.
 */
final class LendingOraclePublication {

    /** 链上 set_mock_collateral_price 的八字节 Anchor 判别符。 Eight-byte Anchor discriminator for set_mock_collateral_price. */
    private static final byte[] SET_PRICE = HexFormat.of().parseHex("cf6950b3de99b1aa");
    /** 价格发布指令要求的系统程序。 System program required by the publication instruction. */
    private static final String SYSTEM_PROGRAM = "11111111111111111111111111111111";
    /** RPC 指令数据使用规范 Solana Base58。 RPC instruction data uses canonical Solana Base58. */
    private static final String BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static final BigInteger RADIX = BigInteger.valueOf(BASE58.length());

    /** 单实例最多保存 128 笔已证实的最终确认交易。 One instance retains at most 128 conclusive finalized transactions. */
    private static final int MAX_CACHED_EVIDENCE = 128;
    /** 每次观测都通过 RPC 刷新签名发现页。 The RPC client refreshes signature discovery for each observation. */
    private final VaultActivityRpc rpc;
    /** 仅缓存已核实的发布或无写入证据，最近使用的条目保留在末尾。 Caches conclusive publication or no-write evidence in access order. */
    private final LinkedHashMap<String, CachedEvidence> evidenceBySignature = new LinkedHashMap<>(16, 0.75f, true);

    /**
     * 为同一个 RPC 客户端复用最终确认交易证据。
     * Reuses finalized transaction evidence for the same RPC client.
     *
     * @param rpc 读取最终确认 Devnet 历史的客户端。 RPC client for finalized Devnet history.
     */
    LendingOraclePublication(VaultActivityRpc rpc) {
        this.rpc = rpc;
    }

    /**
     * 读取不晚于观测 slot 的最新可验证价格发布。历史超出单页上限或无法证实时返回空值。
     * Reads the latest provable publication no later than the observation. Returns null when a single page cannot prove it.
     *
     * @param program 拥有价格 PDA 的借贷程序地址。 Lending program owning the oracle PDA.
     * @param administrator 可信市场账户记载的管理员公钥。 Administrator public key recorded in the verified market account.
     * @param market 已校验的市场 PDA。 Verified market PDA.
     * @param oracle 已校验的价格 PDA。 Verified oracle PDA.
     * @param priceRaw 一整单位抵押品的债务代币最小单位报价。 Debt base units per whole collateral token.
     * @param publishedAt 价格账户存储的链上 Unix 秒。 On-chain Unix seconds stored in the oracle account.
     * @param observedSlot 读取价格账户的最终确认 slot。 Finalized slot at which the oracle account was observed.
     * @return 发布 slot，或空值。 Publication slot, or null.
     */
    BigInteger resolve(
            String program, String administrator, String market, String oracle,
            BigInteger priceRaw, long publishedAt, BigInteger observedSlot
    ) {
        if (priceRaw.signum() <= 0 || priceRaw.bitLength() > Long.SIZE || publishedAt <= 0
                || observedSlot.signum() < 0 || observedSlot.bitLength() > Long.SIZE) {
            return null;
        }

        /** 构建待验证的完整报价，指令数据保持 u64 位模式。 Builds the complete quote to verify and preserves all u64 bits in instruction data. */
        var expected = new ExpectedPublication(program, administrator, market, oracle, encodeInstruction(priceRaw), publishedAt);
        /** 用于拒绝非从新到旧排序的签名页。 Used to reject history out of chronological order. */
        BigInteger priorSlot = null;
        try {
            // 请求覆盖已读取的最终确认观测槽，避免较旧 RPC 节点漏掉已经生效的价格发布。
            // Require RPC history at least as recent as the finalized observation so a lagging node cannot omit the latest publication.
            for (VaultActivityData.Signature signature : rpc.listSignatures(oracle, null, observedSlot)) {
                if (priorSlot != null && signature.slot().compareTo(priorSlot) > 0) {
                    return null;
                }
                priorSlot = signature.slot();
                if (signature.failed() || signature.slot().compareTo(observedSlot) > 0) {
                    continue;
                }
                /** 最新潜在写入优先，无法验证时不回退到旧报价。 Latest potential write wins, without falling back to an older quote. */
                Evidence evidence = evidenceFor(signature, expected);
                if (evidence != Evidence.NO_WRITE) {
                    return evidence == Evidence.PROVEN ? signature.slot() : null;
                }
            }
        } catch (IllegalStateException unavailable) {
            // 历史裁剪、限流或不完整交易均不能作为验真的依据。
            // Pruned history, rate limits and incomplete transactions cannot prove the quote.
            return null;
        }
        return null;
    }

    /**
     * 按刚发现的签名、slot 和报价身份查找已核实证据。仅证实的结果进入缓存。
     * Looks up conclusive evidence for the freshly discovered signature, slot and quote identity.
     *
     * @param signature 本轮签名页中的最终确认签名。 Finalized signature from the current discovery page.
     * @param expected 已读价格 PDA 决定的完整报价。 Quote identified by the observed price PDA.
     * @return 已核实的写入、已核实的无写入或无法确认。 Verified write, verified non-write, or unverified evidence.
     */
    private Evidence evidenceFor(VaultActivityData.Signature signature, ExpectedPublication expected) {
        synchronized (evidenceBySignature) {
            CachedEvidence cached = evidenceBySignature.get(signature.value());
            if (cached != null && cached.matches(signature.slot(), expected)) {
                return cached.evidence();
            }
        }

        /** RPC 会核对交易成功、主签名和最终确认 slot。 The RPC client verifies success, primary signature and finalized slot. */
        JsonNode transaction = rpc.getSuccessfulTransaction(signature);
        Evidence checked = classify(transaction, expected);
        if (checked != Evidence.UNVERIFIED) {
            synchronized (evidenceBySignature) {
                evidenceBySignature.put(signature.value(), new CachedEvidence(signature.slot(), expected, checked));
                if (evidenceBySignature.size() > MAX_CACHED_EVIDENCE) {
                    evidenceBySignature.pollFirstEntry();
                }
            }
        }
        return checked;
    }

    /**
     * 分类一笔交易对指定价格账户的最新写入。
     * Classifies one transaction's latest write to the specified oracle.
     *
     * @param result 已核对的成功交易 JSON。 Verified successful transaction JSON.
     * @param expected 用于校验发布的程序、签名者、市场、预言机、指令数据及时间。 Program, signer, market, oracle, instruction data and time required for publication.
     * @return 无潜在写入、已证实或无法证实。 No potential write, proven write, or unverified write.
     */
    private static Evidence classify(JsonNode result, ExpectedPublication expected) {
        /** 静态消息头确定实际签名位置和静态账户可写边界。 The static message header determines signer and writable bounds. */
        JsonNode transaction = result.path("transaction");
        JsonNode message = transaction.path("message");
        JsonNode header = message.path("header");
        JsonNode staticKeys = message.path("accountKeys");
        int signerCount = accountIndex(header.path("numRequiredSignatures"));
        int readonlySignedCount = accountIndex(header.path("numReadonlySignedAccounts"));
        int readonlyUnsignedCount = accountIndex(header.path("numReadonlyUnsignedAccounts"));
        if (!staticKeys.isArray() || !transaction.path("signatures").isArray()
                || signerCount < 1 || transaction.path("signatures").size() != signerCount
                || signerCount > staticKeys.size() || readonlySignedCount < 0 || readonlySignedCount > signerCount
                || readonlyUnsignedCount < 0 || readonlyUnsignedCount > staticKeys.size() - signerCount) {
            return Evidence.UNVERIFIED;
        }

        /** v0 地址表加载项在静态账户之后按可写、只读顺序排布。 v0 lookup addresses follow static keys, writable entries first. */
        JsonNode metadata = result.path("meta");
        JsonNode loaded = metadata.path("loadedAddresses");
        JsonNode loadedWritable = loaded.path("writable");
        JsonNode loadedReadonly = loaded.path("readonly");
        List<String> keys = new ArrayList<>();
        if (!appendKeys(keys, staticKeys) || loaded.isObject()
                && (!appendKeys(keys, loadedWritable) || !appendKeys(keys, loadedReadonly))) {
            return Evidence.UNVERIFIED;
        }

        /** 价格、程序与管理员在交易合并账户列表中的下标。 Indexes of the oracle, program and administrator in the combined key list. */
        int oracleIndex = keys.indexOf(expected.oracle());
        int programIndex = keys.indexOf(expected.program());
        int adminIndex = keys.indexOf(expected.administrator());
        if (oracleIndex < 0) {
            return Evidence.UNVERIFIED;
        }
        if (!isWritable(oracleIndex, signerCount, readonlySignedCount, readonlyUnsignedCount,
                staticKeys.size(), loadedWritable.size()) || programIndex < 0) {
            return Evidence.NO_WRITE;
        }

        /** 内部调用可能修改价格。成功的整个交易并不证明调用方捕获的 CPI 也成功。 Inner calls can write prices, but transaction success does not prove a CPI whose failure was caught. */
        JsonNode instructions = message.path("instructions");
        JsonNode inner = metadata.path("innerInstructions");
        if (!instructions.isArray() || !inner.isArray()) {
            return Evidence.UNVERIFIED;
        }
        Map<Integer, JsonNode> innerByParent = new HashMap<>();
        for (JsonNode group : inner) {
            int parent = accountIndex(group.path("index"));
            JsonNode calls = group.path("instructions");
            if (parent < 0 || parent >= instructions.size() || !calls.isArray() || innerByParent.put(parent, calls) != null) {
                return Evidence.UNVERIFIED;
            }
        }

        /** 交易的 RPC 区块时间必须与价格账户记录的链上 Clock 秒数精确相同。 RPC block time must exactly match the oracle's stored on-chain Clock seconds. */
        JsonNode blockTime = result.path("blockTime");
        boolean matchingTime = blockTime.isIntegralNumber() && blockTime.canConvertToLong()
                && blockTime.longValue() == expected.publishedAt();
        Evidence evidence = Evidence.NO_WRITE;
        for (int index = 0; index < instructions.size(); index++) {
            /** 只有已确认的顶层成功价格指令可以作为发布证明。 Only a finalized, successful top-level setter proves publication. */
            JsonNode instruction = instructions.get(index);
            if (referencesOracle(instruction, programIndex, oracleIndex)) {
                evidence = matchingTime && adminIndex >= 0 && adminIndex < signerCount
                        && matchesSetter(instruction, keys, expected)
                        ? Evidence.PROVEN : Evidence.UNVERIFIED;
            }
            JsonNode nestedCalls = innerByParent.get(index);
            if (nestedCalls != null) {
                for (JsonNode call : nestedCalls) {
                    if (referencesOracle(call, programIndex, oracleIndex)) {
                        evidence = Evidence.UNVERIFIED;
                    }
                }
            }
        }
        return evidence;
    }

    /** 把消息中连续的公钥列表加入合并列表。 Appends a contiguous public-key list to the merged message list. */
    private static boolean appendKeys(List<String> target, JsonNode source) {
        if (!source.isArray()) {
            return false;
        }
        for (JsonNode key : source) {
            if (!key.isTextual()) {
                return false;
            }
            target.add(key.textValue());
        }
        return true;
    }

    /** 按消息头及地址表顺序推导账户是否可写。 Derives account writability from the message header and lookup ordering. */
    private static boolean isWritable(int index, int signers, int readonlySigned, int readonlyUnsigned,
                                      int staticCount, int loadedWritable) {
        if (index < signers) {
            return index < signers - readonlySigned;
        }
        return index < staticCount ? index < staticCount - readonlyUnsigned : index < staticCount + loadedWritable;
    }

    /** 仅当借贷程序收到该价格账户时，才视为可能修改价格。 Only a lending instruction receiving this oracle may write its data. */
    private static boolean referencesOracle(JsonNode instruction, int programIndex, int oracleIndex) {
        if (accountIndex(instruction.path("programIdIndex")) != programIndex) {
            return false;
        }
        JsonNode accounts = instruction.path("accounts");
        if (!accounts.isArray()) {
            return true;
        }
        for (JsonNode account : accounts) {
            if (accountIndex(account) == oracleIndex) {
                return true;
            }
        }
        return false;
    }

    /** 检查发布指令的完整字段顺序和预期数据。 Checks the setter's full account order and expected instruction bytes. */
    private static boolean matchesSetter(JsonNode instruction, List<String> keys, ExpectedPublication expected) {
        /** 旧版指令账户顺序由已部署 Anchor IDL 定义。 Account order for the legacy instruction comes from the deployed Anchor IDL. */
        List<String> expectedKeys = List.of(expected.administrator(), expected.market(), expected.oracle(), SYSTEM_PROGRAM);
        JsonNode accounts = instruction.path("accounts");
        if (!accounts.isArray() || accounts.size() != expectedKeys.size()
                || !expected.data().equals(instruction.path("data").textValue())) {
            return false;
        }
        for (int index = 0; index < expectedKeys.size(); index++) {
            int account = accountIndex(accounts.get(index));
            if (account < 0 || account >= keys.size() || !expectedKeys.get(index).equals(keys.get(account))) {
                return false;
            }
        }
        return true;
    }

    /** 只接收消息中的整数下标，缺失或溢出用 -1 表示。 Accepts integral message indexes only, mapping missing or overflowed values to -1. */
    private static int accountIndex(JsonNode node) {
        return node.isIntegralNumber() && node.canConvertToInt() ? node.intValue() : -1;
    }

    /** 编码 8 字节判别符及小端 u64，得到 JSON RPC 的规范指令数据。 Encodes the eight-byte discriminator and little-endian u64 as canonical RPC instruction data. */
    private static String encodeInstruction(BigInteger price) {
        /** BigInteger 的最低 64 位保持无符号报价的线格式。 The low 64 bits of BigInteger preserve the unsigned quote on the wire. */
        byte[] payload = ByteBuffer.allocate(SET_PRICE.length + Long.BYTES).order(ByteOrder.LITTLE_ENDIAN)
                .put(SET_PRICE).putLong(price.longValue()).array();
        BigInteger value = new BigInteger(1, payload);
        StringBuilder reversed = new StringBuilder();
        while (value.signum() > 0) {
            BigInteger[] digits = value.divideAndRemainder(RADIX);
            value = digits[0];
            reversed.append(BASE58.charAt(digits[1].intValueExact()));
        }
        for (byte first : payload) {
            if (first != 0) {
                break;
            }
            reversed.append('1');
        }
        return reversed.reverse().toString();
    }

    /**
     * 由当前价格账户决定的预期写入。
     * Expected write derived from the current oracle account.
     *
     * @param program 借贷程序公钥。 Lending program public key.
     * @param administrator 预期签名者。 Expected signing administrator.
     * @param market 规范市场 PDA。 Canonical market PDA.
     * @param oracle 规范预言机 PDA。 Canonical oracle PDA.
     * @param data Base58 编码的精确写入指令。 Exact write instruction encoded in Base58.
     * @param publishedAt 账户内报价发布时间。 Quote publication time stored in the account.
     */
    private record ExpectedPublication(
            String program, String administrator, String market, String oracle, String data, long publishedAt
    ) {
    }

    /**
     * 由最终确认交易证明的不变事实。
     * An immutable fact proven by a finalized transaction.
     *
     * @param slot 已核实的交易所在 slot。 Verified transaction slot.
     * @param expected 已核实的价格科目和值。 Verified price feed and expected values.
     * @param evidence 已证实的写入或无写入。 Conclusive write or no-write evidence.
     */
    private record CachedEvidence(BigInteger slot, ExpectedPublication expected, Evidence evidence) {

        /** 价格发布必须匹配完整元组。同一程序和 PDA 的无写入证据与价格值无关。 A publication must match the full tuple; no-write evidence for a program and oracle does not depend on price. */
        private boolean matches(BigInteger candidateSlot, ExpectedPublication candidate) {
            return slot.equals(candidateSlot)
                    && (evidence == Evidence.NO_WRITE
                    ? expected.program().equals(candidate.program()) && expected.oracle().equals(candidate.oracle())
                    : expected.equals(candidate));
        }
    }

    /** 历史交易对价格数据的取证结果。 Historical transaction evidence about oracle data. */
    private enum Evidence {
        /** 已确定本交易没有潜在写入。 The transaction could not write this oracle. */
        NO_WRITE,
        /** 发布内容与已观测账户精确一致。 The publication exactly matches the observed account. */
        PROVEN,
        /** 存在潜在写入，但无法确认其对应当前账户。 A possible write cannot be tied to the observed account. */
        UNVERIFIED
    }
}

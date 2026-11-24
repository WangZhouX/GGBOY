package io.ggboy.backend.indexer;

import io.ggboy.backend.indexer.VaultActivityData.Action;
import io.ggboy.backend.indexer.VaultActivityData.Event;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 验证金库存赎的真实 Anchor 布局、调用来源及回滚规则。 Verifies the real Anchor layout, emission source, and rollback rules for vault events. */
class VaultActivityDecoderTest {

    /** 金库程序与外部 CPI 测试程序公钥。 The vault program and an external CPI fixture program public key. */
    private static final String VAULT_PROGRAM = "FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75";
    private static final String EXTERNAL_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    /** Rust 事件类型的八字节 Anchor IDL 标识，按大端十六进制文本记录。 Eight-byte Anchor IDL discriminators of the Rust events, written as hexadecimal text. */
    private static final String DEPOSIT = "04f8eaa363ee8c2d";
    private static final String REDEEM = "082094952ded5294";

    /** 存入和赎回保留不同金额顺序、完整 u64 和原始日志序号。 Both actions preserve their amount order, full u64 values, and original log indexes. */
    @Test
    void decodesBothEventLayoutsAndPreservesFullPrecision() {
        /** 同笔成功交易在外部 CPI 前后产生两种金库事件。 The successful transaction emits both vault event types around an external CPI. */
        List<String> logs = List.of(
                "Program " + VAULT_PROGRAM + " invoke [1]",
                "Program log: Instruction: Deposit",
                dataLog(DEPOSIT, -1, Long.MIN_VALUE),
                "Program " + EXTERNAL_PROGRAM + " invoke [2]",
                dataLog(REDEEM, 1, 1),
                "Program " + EXTERNAL_PROGRAM + " success",
                "Program log: " + dataLog(DEPOSIT, 1, 1),
                "Program data: aGVsbG8= d29ybGQ=",
                dataLog(REDEEM, 300, 240),
                "Program " + VAULT_PROGRAM + " success");

        /** 四个独立测试公钥及两组对应的最小单位数量。 Four independent fixture keys with their corresponding base-unit amounts. */
        String vault = "1".repeat(31) + "2";
        String investor = "1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE";
        String assetMint = "JARrYp7rTsXGiwyvaowWwtbrh2WAZtbxtrdgP73EYXxA";
        String shareMint = "1".repeat(32);
        assertEquals(List.of(
                new Event(2, vault, investor, assetMint, shareMint, new BigInteger("18446744073709551615"),
                        new BigInteger("9223372036854775808"), Action.DEPOSIT),
                new Event(8, vault, investor, assetMint, shareMint, BigInteger.valueOf(240), BigInteger.valueOf(300),
                        Action.REDEEM)),
                VaultActivityDecoder.decode(VAULT_PROGRAM, logs));
    }

    /** 失败的金库帧及失败祖先下成功的金库帧不会产生活动。 A failed vault frame and a successful vault frame beneath a failed ancestor both leave no activity. */
    @Test
    void ignoresEventsWithinRolledBackInvocationPaths() {
        /** 外层成功返回，但两次内层路径各有失败。 The top-level invocation succeeds while each inner path contains a failure. */
        List<String> logs = List.of(
                "Program " + EXTERNAL_PROGRAM + " invoke [1]",
                "Program " + VAULT_PROGRAM + " invoke [2]",
                dataLog(DEPOSIT, 1, 1),
                "Program " + VAULT_PROGRAM + " failed: custom program error: 0x1",
                "Program " + EXTERNAL_PROGRAM + " invoke [2]",
                "Program " + VAULT_PROGRAM + " invoke [3]",
                dataLog(REDEEM, 1, 1),
                "Program " + VAULT_PROGRAM + " success",
                "Program " + EXTERNAL_PROGRAM + " failed: custom program error: 0x1",
                "Program " + EXTERNAL_PROGRAM + " success");
        assertEquals(List.of(), VaultActivityDecoder.decode(VAULT_PROGRAM, logs));
    }

    /** 公共 RPC 日志不完整时暂停同步，等待安全重试。 Incomplete public RPC logs stop indexing so the transaction can safely be retried. */
    @Test
    void rejectsTruncationAndAnInconsistentInvocationStack() {
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(VAULT_PROGRAM, List.of(
                "Program " + VAULT_PROGRAM + " invoke [1]", dataLog(DEPOSIT, 1, 1), "Log truncated")));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(VAULT_PROGRAM, List.of(
                "Program " + VAULT_PROGRAM + " invoke [1]", dataLog(DEPOSIT, 1, 1))));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(VAULT_PROGRAM, List.of(
                "Program " + VAULT_PROGRAM + " invoke [2]", "Program " + VAULT_PROGRAM + " success")));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(VAULT_PROGRAM, List.of(
                "Program " + VAULT_PROGRAM + " invoke [1]", "Program " + EXTERNAL_PROGRAM + " success")));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(VAULT_PROGRAM, List.of(
                dataLog(DEPOSIT, 1, 1))));
    }

    /** 已知标识的数据若长度不符或金额为零，不能写入成交记录。 A recognized discriminator with a malformed length or zero amount cannot produce a receipt. */
    @Test
    void rejectsRecognizedInvalidPayloads() {
        /** 只含存入标识、没有任何事件字段的数据。 Payload containing just the deposit discriminator without event fields. */
        String discriminatorOnly = Base64.getEncoder().encodeToString(HexFormat.of().parseHex(DEPOSIT));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(VAULT_PROGRAM, List.of(
                "Program " + VAULT_PROGRAM + " invoke [1]", "Program data: " + discriminatorOnly,
                "Program " + VAULT_PROGRAM + " success")));
        assertThrows(IllegalStateException.class, () -> VaultActivityDecoder.decode(VAULT_PROGRAM, List.of(
                "Program " + VAULT_PROGRAM + " invoke [1]", dataLog(REDEEM, 1, 0),
                "Program " + VAULT_PROGRAM + " success")));
    }

    /**
     * 按 Anchor IDL 编排可独立校验的固定公钥和两个小端金额。
     * Assembles fixed verifiable keys and two little-endian amounts according to the Anchor IDL.
     *
     * @param discriminator 已知事件标识的十六进制文本。 Hexadecimal text for the known event discriminator.
     * @param input 指令实际输入的无符号 64 位最小单位位模式。 Unsigned 64-bit bit pattern of the executed input in base units.
     * @param output 指令实际输出的无符号 64 位最小单位位模式。 Unsigned 64-bit bit pattern of the executed output in base units.
     * @return 与 Solana RPC 格式相同的数据日志行。 Data log line in the Solana RPC format.
     */
    private static String dataLog(String discriminator, long input, long output) {
        /** 固定大小的事件字节和独立样本公钥的十六进制表示。 Fixed event buffer and hexadecimal representation of independent sample keys. */
        ByteBuffer event = ByteBuffer.allocate(152).order(ByteOrder.LITTLE_ENDIAN);
        HexFormat hex = HexFormat.of();
        event.put(hex.parseHex(discriminator));
        event.put(hex.parseHex("00".repeat(31) + "01"));
        event.put(hex.parseHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"));
        event.put(hex.parseHex("ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"));
        event.put(new byte[32]);
        event.putLong(input).putLong(output);
        return "Program data: " + Base64.getEncoder().encodeToString(event.array());
    }
}

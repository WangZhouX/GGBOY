package io.ggboy.backend.indexer;

import io.ggboy.backend.indexer.AnchorTransactionLogs.RawEvent;
import io.ggboy.backend.indexer.VaultActivityData.Action;
import io.ggboy.backend.indexer.VaultActivityData.Event;
import io.ggboy.common.utils.SolanaAddressUtil;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;

/**
 * 从最终确认且执行成功的 Solana 交易日志提取 Anchor 金库存赎事件。
 * Extracts Anchor vault deposits and redemptions from finalized, successful Solana transaction logs.
 */
final class VaultActivityDecoder {

    /** 来自程序 IDL 的 VaultDeposit 八字节标识。 Eight-byte VaultDeposit discriminator from the program IDL. */
    private static final byte[] DEPOSIT_DISCRIMINATOR = HexFormat.of().parseHex("04f8eaa363ee8c2d");
    /** 来自程序 IDL 的 VaultRedeem 八字节标识。 Eight-byte VaultRedeem discriminator from the program IDL. */
    private static final byte[] REDEEM_DISCRIMINATOR = HexFormat.of().parseHex("082094952ded5294");
    /** 每个事件开头的 Anchor 标识字节数。 Length of each event's leading Anchor discriminator. */
    private static final int DISCRIMINATOR_BYTES = 8;
    /** 一个 Solana 公钥的固定字节数。 Fixed byte length of a Solana public key. */
    private static final int KEY_BYTES = 32;
    /** 两类事件均含四个公钥和两个 u64 金额。 Both events contain four keys and two u64 amounts. */
    private static final int EVENT_BYTES = DISCRIMINATOR_BYTES + 4 * KEY_BYTES + 2 * Long.BYTES;

    /** 解析器仅提供静态方法。 The decoder exposes static methods only. */
    private VaultActivityDecoder() {
    }

    /**
     * 仅返回由金库程序发出且整条调用路径成功的已知事件，保留原始日志位置。
     * Returns known events emitted by the vault program along a successful invocation path, preserving original positions.
     *
     * @param programId 已配置金库程序的 Base58 公钥。 Base58 public key of the configured vault program.
     * @param logs 已最终确认且成功交易的完整 RPC 日志。 Complete RPC logs for a finalized and successful transaction.
     * @return 按原始日志顺序排列的存赎事件。 Deposit and redemption events in original log order.
     * @throws IllegalStateException 日志不完整，或已知事件布局和金额无效。 The logs are incomplete or a known event has invalid layout or amounts.
     */
    static List<Event> decode(String programId, List<String> logs) {
        /** 复用运行日志校验，金库事件依然允许由成功的 CPI 指令产生。 Reuse runtime validation while still accepting vault events from successful CPI calls. */
        List<RawEvent> committed = AnchorTransactionLogs.scan(programId, logs, AnchorTransactionLogs.InvocationScope.ANY);
        /** 解码后的存赎事件，跳过当前版本未知的 Anchor 事件。 Decoded deposit and redemption events, excluding unknown Anchor types. */
        List<Event> events = new ArrayList<>(committed.size());
        for (RawEvent raw : committed) {
            /** 空值表示该数据的事件标识不属于金库存赎。 Null means that the payload does not identify a deposit or redemption. */
            Event event = decodeEvent(raw);
            if (event != null) {
                events.add(event);
            }
        }
        return List.copyOf(events);
    }

    /**
     * 按 Anchor/Borsh 的固定布局解码已退出的事件，统一金额在返回值中的顺序。
     * Decodes an exited event using the fixed Anchor/Borsh layout and normalizes the returned amount order.
     *
     * @param raw 带原始日志序号的 Base64 数据。 Base64 data with its original log index.
     * @return 已知的存入或赎回事件，未知数据返回空。 A known deposit or redemption event, or null for unknown data.
     * @throws IllegalStateException 数据无法解码，或已知事件的布局及金额与定义不一致。 The data cannot be decoded or a known event violates its layout and amount constraints.
     */
    private static Event decodeEvent(RawEvent raw) {
        // 运行时数据允许多段，Anchor emit! 只有一段。先读首段可跳过其他用途的有效数据。
        // Runtime data supports multiple fields, while Anchor emit! uses one. Check the first field to ignore unrelated valid data.
        int separator = raw.encoded().indexOf(' ');
        String firstField = separator < 0 ? raw.encoded() : raw.encoded().substring(0, separator);
        byte[] data;
        try {
            data = Base64.getDecoder().decode(firstField);
        } catch (IllegalArgumentException malformed) {
            throw new IllegalStateException("Invalid Base64 vault data at log " + raw.logIndex(), malformed);
        }
        if (data.length < DISCRIMINATOR_BYTES) {
            return null;
        }

        /** Anchor 标识决定业务类型和随后的两个金额字段顺序。 The Anchor discriminator determines the action and order of the two trailing amounts. */
        Action action;
        if (Arrays.equals(data, 0, DISCRIMINATOR_BYTES, DEPOSIT_DISCRIMINATOR, 0, DISCRIMINATOR_BYTES)) {
            action = Action.DEPOSIT;
        } else if (Arrays.equals(data, 0, DISCRIMINATOR_BYTES, REDEEM_DISCRIMINATOR, 0, DISCRIMINATOR_BYTES)) {
            action = Action.REDEEM;
        } else {
            return null;
        }

        if (separator >= 0 || data.length != EVENT_BYTES) {
            throw new IllegalStateException("Invalid vault event layout at log " + raw.logIndex());
        }

        /** 两种事件中的四个公钥顺序相同，金额按各自指令的输入和输出排列。 Both events share the four key fields, followed by that instruction's input and output amounts. */
        ByteBuffer body = ByteBuffer.wrap(data, DISCRIMINATOR_BYTES, data.length - DISCRIMINATOR_BYTES)
                .order(ByteOrder.LITTLE_ENDIAN);
        String vault = readPublicKey(body);
        String investor = readPublicKey(body);
        String assetMint = readPublicKey(body);
        String shareMint = readPublicKey(body);
        /** 指令实际输入和输出的 u64 最小单位金额，保留无符号全范围。 Executed input and output in base units, preserving the full unsigned u64 range. */
        BigInteger inputAmount = new BigInteger(Long.toUnsignedString(body.getLong()));
        BigInteger outputAmount = new BigInteger(Long.toUnsignedString(body.getLong()));
        if (inputAmount.signum() == 0 || outputAmount.signum() == 0) {
            throw new IllegalStateException("Zero amount in vault event at log " + raw.logIndex());
        }

        return switch (action) {
            case DEPOSIT -> new Event(raw.logIndex(), vault, investor, assetMint, shareMint, inputAmount, outputAmount, action);
            case REDEEM -> new Event(raw.logIndex(), vault, investor, assetMint, shareMint, outputAmount, inputAmount, action);
        };
    }

    /**
     * 从当前 Borsh 读位置读取 32 字节公钥，编码为 Solana Base58 文本。
     * Reads a 32-byte public key at the current Borsh position and encodes it as Solana Base58 text.
     *
     * @param body 已校验长度的事件字段缓冲区。 Event field buffer with a validated length.
     * @return 含原始前导零的规范 Base58 公钥。 Canonical Base58 public key preserving leading zero bytes.
     */
    private static String readPublicKey(ByteBuffer body) {
        /** 待编码的公钥原始 32 字节。 Original 32 bytes of the public key to encode. */
        byte[] key = new byte[KEY_BYTES];
        body.get(key);
        return SolanaAddressUtil.encodePublicKey(key);
    }

}

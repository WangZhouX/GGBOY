package io.ggboy.backend.indexer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 从完整 Solana 运行日志提取目标程序的 Anchor 事件候选项。
 * Extracts candidate Anchor events for a target program from complete Solana runtime logs.
 */
final class AnchorTransactionLogs {

    /** Solana 日志中 32 字节公钥的 Base58 文本范围。 Base58 text range for a 32-byte key in Solana logs. */
    private static final String PROGRAM_KEY = "[1-9A-HJ-NP-Za-km-z]{32,44}";
    /** 运行时为每次调用记录的程序公钥和调用深度。 Program key and invocation depth logged by the runtime. */
    private static final Pattern INVOKE = Pattern.compile("Program (" + PROGRAM_KEY + ") invoke \\[([0-9]+)]");
    /** 运行时记录的程序退出结果，包含成功或失败原因。 Runtime exit result containing success or a failure reason. */
    private static final Pattern EXIT = Pattern.compile("Program (" + PROGRAM_KEY + ") (success|failed: .*|failed)",
            Pattern.DOTALL);
    /** Anchor emit! 使用的运行时数据前缀。 Runtime data prefix used by Anchor emit!. */
    private static final String DATA_PREFIX = "Program data: ";

    /**
     * 允许从目标程序的哪些运行时调用层级取事件候选项。
     * Selects the invocation depths at which target-program events qualify.
     */
    enum InvocationScope {
        /** 接受顶层和 CPI 调用，但要求整个调用路径成功。 Accepts top-level and CPI calls only when the full invocation path succeeds. */
        ANY,
        /** 仅接受交易的顶层指令，忽略 CPI 发出的数据。 Accepts top-level instructions only, excluding data emitted during CPI. */
        TOP_LEVEL
    }

    /** 日志扫描器仅提供静态方法。 The log scanner exposes only static methods. */
    private AnchorTransactionLogs() {
    }

    /**
     * 在完整的成功调用路径内识别目标程序发出的运行时数据，保留原始日志行号。
     * Finds target-program data on complete, successful invocation paths, retaining original log positions.
     *
     * @param programId 目标程序的 Base58 公钥。 Base58 public key of the target program.
     * @param logs 成功且最终确认的交易的完整有序日志。 Complete ordered logs of a finalized successful transaction.
     * @param scope 允许的事件发出层级。 Allowed emitter invocation depths.
     * @return 按原始顺序返回成功调用发出的候选数据。 Candidate data from successful invocations, in original order.
     * @throws IllegalStateException 日志缺失、截断或调用栈不一致。 Logs are missing, truncated, or have an inconsistent invocation stack.
     */
    static List<RawEvent> scan(String programId, List<String> logs, InvocationScope scope) {
        /** 调用栈顶是当前能发出事件的程序。 The top frame identifies the program currently able to emit events. */
        Deque<Invocation> invocations = new ArrayDeque<>();
        /** 只收集已成功退出整个调用路径的候选数据。 Data candidates whose full invocation path exited successfully. */
        List<RawEvent> committed = new ArrayList<>();

        // 序号来自整笔交易日志，不能在挑出事件后重新编号。
        // Use the position in the entire transaction, before filtering events.
        for (int logIndex = 0; logIndex < logs.size(); logIndex++) {
            /** 当前 RPC 日志和可能匹配的运行时调用入口。 Current RPC log and potential runtime invocation entry. */
            String log = logs.get(logIndex);
            var enter = INVOKE.matcher(log);
            if (log.equals("Log truncated")) {
                throw new IllegalStateException("Solana transaction logs were truncated");
            }
            if (enter.matches()) {
                // 深度缺口表示丢失了运行时日志，无法安全识别后续事件的来源。
                // A depth gap indicates missing runtime logs and prevents safe attribution.
                if (!enter.group(2).equals(Integer.toString(invocations.size() + 1))) {
                    throw new IllegalStateException("Unexpected Solana invocation depth at log " + logIndex);
                }
                invocations.push(new Invocation(enter.group(1), new ArrayList<>()));
                continue;
            }

            /** 当前日志可能匹配的退出记录，调用栈顶用来核对退出程序或识别事件归属。 Potential exit and current frame for exit validation or event attribution. */
            var exit = EXIT.matcher(log);
            Invocation current = invocations.peek();
            if (exit.matches()) {
                if (current == null || !current.program().equals(exit.group(1))) {
                    throw new IllegalStateException("Unexpected Solana invocation exit at log " + logIndex);
                }
                invocations.pop();
                if (exit.group(2).equals("success")) {
                    // 仅把已成功退出的候选项归入父调用。父调用失败时也一起丢弃。
                    // Promote candidates only on success. A later parent failure discards them as well.
                    Invocation parent = invocations.peek();
                    (parent == null ? committed : parent.events()).addAll(current.events());
                }
                continue;
            }

            // 系统运行时的 Program data 行才可入选。其他程序及普通 Program log 消息不参与解码。
            // Accept only runtime Program data lines from the target. Other programs and ordinary Program log messages do not qualify.
            if (log.startsWith(DATA_PREFIX)) {
                if (current == null) {
                    throw new IllegalStateException("Solana program data without an invocation at log " + logIndex);
                }
                if (current.program().equals(programId) && (scope == InvocationScope.ANY || invocations.size() == 1)) {
                    current.events().add(new RawEvent(logIndex, log.substring(DATA_PREFIX.length())));
                }
            }
        }

        // 即使此前已经解出了事件，日志缺尾时也不能推进同步游标。
        // A missing exit prevents checkpoint advancement even if earlier events were readable.
        if (!invocations.isEmpty()) {
            throw new IllegalStateException("Solana transaction logs ended before all invocations exited");
        }

        return committed;
    }

    /**
     * 一层调用暂存的事件可在本层或上层失败时舍弃。
     * Events buffered by one invocation can be discarded on that frame or a parent failing.
     *
     * @param program 该帧执行的程序公钥。 Program public key for this frame.
     * @param events 该帧及已成功退出子帧的候选事件。 Candidate events from this frame and its successful descendants.
     */
    private record Invocation(String program, List<RawEvent> events) {
    }

    /**
     * 待解码的原始事件。
     * Raw event to decode.
     *
     * @param logIndex 在整笔交易日志中的零基位置。 Zero-based position in the transaction's full log stream.
     * @param encoded 来自 Program data 行的内容。 Payload from the Program data line.
     */
    record RawEvent(int logIndex, String encoded) {
    }
}

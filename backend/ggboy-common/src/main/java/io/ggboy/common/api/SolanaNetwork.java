package io.ggboy.common.api;

/**
 * GGBOY 公共接口支持的 Solana 网络。调用方通过 {@link #wireValue()} 写出请求和响应中的网络标识。
 * Solana networks supported by the GGBOY API. Callers use {@link #wireValue()} to write network identifiers in requests and responses.
 */
public enum SolanaNetwork {

    /** 本地验证器网络，用于开发和集成测试。 Local validator network for development and integration tests. */
    LOCALNET("localnet"),

    /** Solana 开发网，用于公开演示测试资产。 Solana development network for public demonstrations with test assets. */
    DEVNET("devnet");

    /** 网络在接口中使用的区分大小写的文本。 Case-sensitive text identifying the network on the wire. */
    private final String wireValue;

    /**
     * 将一个受支持网络与其稳定的协议值关联。
     * Associates a supported network with its stable wire value.
     *
     * @param wireValue 请求和响应共用的小写网络标识。 Lowercase network identifier shared by requests and responses.
     */
    SolanaNetwork(String wireValue) {
        this.wireValue = wireValue;
    }

    /**
     * 读取可写入请求或响应的公开网络标识。
     * Returns the public network identifier for writing to requests or responses.
     *
     * @return 当前网络对应的协议文本，如 {@code devnet}。 Wire text for this network, such as {@code devnet}.
     */
    public String wireValue() {
        return wireValue;
    }

    /**
     * 按公共接口定义的拼写解析网络标识。
     * Parses a network identifier using the spelling defined by the public API.
     *
     * @param wireValue 调用方提供的原始网络标识。 Network identifier exactly as supplied by the caller.
     * @return 与协议标识完全匹配的网络。 Network whose wire identifier matches exactly.
     * @throws IllegalArgumentException 标识为空或与任何受支持的值不匹配。 The identifier is null or does not match a supported value.
     */
    public static SolanaNetwork fromWireValue(String wireValue) {
        // 按枚举登记的协议值精确匹配，使输入校验与输出拼写保持一致。
        // Match each registered wire value exactly so input validation follows the same spelling as output.
        for (SolanaNetwork network : values()) {
            if (network.wireValue.equals(wireValue)) {
                return network;
            }
        }
        throw new IllegalArgumentException("Unsupported Solana network identifier");
    }
}

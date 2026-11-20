package io.ggboy.common.api;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 验证网络在接口输入和输出两端的协议拼写。 Verifies network spelling on both API input and output. */
class SolanaNetworkTest {

    /** 锁定两个受支持网络在客户端使用的协议值。 Pins the wire values used by clients for both supported networks. */
    @Test
    void writesAndReadsDocumentedNetworkNames() {
        assertEquals("localnet", SolanaNetwork.LOCALNET.wireValue());
        assertEquals("devnet", SolanaNetwork.DEVNET.wireValue());
        assertEquals(SolanaNetwork.LOCALNET, SolanaNetwork.fromWireValue("localnet"));
        assertEquals(SolanaNetwork.DEVNET, SolanaNetwork.fromWireValue("devnet"));
    }

    /**
     * 校验缺失值、未支持的网络以及与协议拼写不同的输入均被拒绝。
     * Checks that missing values, unsupported networks and alternative spellings are rejected.
     *
     * @param invalidIdentifier 请求中可能出现的无效网络标识。 Invalid network identifier as received in a request.
     */
    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "devnet ", " localnet", "DEVNET", "Localnet", "testnet", "mainnet-beta"})
    void rejectsInvalidNetworkName(String invalidIdentifier) {
        assertThrows(IllegalArgumentException.class, () -> SolanaNetwork.fromWireValue(invalidIdentifier));
    }
}

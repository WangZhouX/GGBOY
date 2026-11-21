package io.ggboy.backend.api;

import io.ggboy.common.api.SolanaNetwork;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 验证交易活动参数的默认值、签名和可重复事件类型。 Verifies activity parameters, signature validation, and repeated types. */
class ActivityQueryTest {

    /** 恰好编码 32 个零字节的测试公钥。 Test public key encoding exactly 32 zero bytes. */
    private static final String PUBLIC_KEY = "1".repeat(32);

    /** 含前导零的测试签名，Base58 解码后恰好 64 字节。 Base58 fixture with leading zeros decoding to exactly 64 bytes. */
    private static final String SIGNATURE = "1".repeat(63) + "2";

    /** 只传网络时无需筛选活动，分页使用 20 条。 A request with only the network uses no filters and 20 events per page. */
    @Test
    void defaultsToUnfilteredFirstPage() {
        // 省略所有可选的 HTTP 参数。 Omit every optional HTTP parameter.
        var query = ActivityQuery.parse("devnet", null, null, null, null, null);
        assertEquals(SolanaNetwork.DEVNET, query.network());
        assertEquals(20, query.limit());
        assertEquals(List.of(), query.types());
        assertNull(query.wallet());
    }

    /** 类型合并为唯一值并按固定顺序保存，地址和签名保持大小写。 Types are deduplicated and sorted. Keys retain their original case. */
    @Test
    void normalizesRepeatedTypeValues() {
        // 筛选两个金库动作，并额外重复一次赎回动作。 Filter two vault actions, with the redeem action repeated.
        var query = ActivityQuery.parse("localnet", PUBLIC_KEY, PUBLIC_KEY, SIGNATURE,
                List.of("VAULT_REDEEM", "VAULT_DEPOSIT", "VAULT_REDEEM"), "4");
        assertEquals(List.of("VAULT_DEPOSIT", "VAULT_REDEEM"), query.types());
        assertEquals(SIGNATURE, query.signature());
        assertEquals(PUBLIC_KEY, query.subjectAddress());
        assertEquals(4, query.limit());
    }

    /**
     * 提供了分页大小时须为范围内的十进制文本。
     * A supplied page size must be decimal text within range.
     *
     * @param limit 无效分页大小文本。 Invalid page size text.
     */
    @ParameterizedTest
    @ValueSource(strings = {"", "0", "101", "-1", "1.5", "no"})
    void rejectsInvalidPageSizes(String limit) {
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("localnet", null, null, null, null, limit));
    }

    /** 已提供的筛选不接受空值、非法编码或过多类型。 Supplied filters reject empty text, bad encodings, and excessive values. */
    @Test
    void rejectsInvalidFilters() {
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("mainnet", null, null, null, null, null));
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("localnet", "", null, null, null, null));
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("localnet", null, "0".repeat(32), null, null, null));
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("localnet", null, null, "2".repeat(64), null, null));
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("localnet", null, null, "1".repeat(65), null, null));
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("localnet", null, null, null, List.of("vault"), null));
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("localnet", null, null, null, List.of("VAULT_DEPOSIT,VAULT_REDEEM"), null));
        assertThrows(IllegalArgumentException.class,
                () -> ActivityQuery.parse("localnet", null, null, null, Collections.nCopies(33, "VAULT_DEPOSIT"), null));
    }
}

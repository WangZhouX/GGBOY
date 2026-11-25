package io.ggboy.backend.api;

import io.ggboy.backend.entity.VaultDO;
import io.ggboy.backend.entity.VaultPositionSnapshotDO;
import io.ggboy.backend.entity.VaultSnapshotDO;
import io.ggboy.backend.mapper.VaultMapper;
import io.ggboy.backend.mapper.VaultPositionSnapshotMapper;
import io.ggboy.backend.mapper.VaultSnapshotMapper;
import io.ggboy.backend.service.impl.VaultServiceImpl;
import io.ggboy.common.api.SolanaNetwork;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.math.BigInteger;
import java.time.OffsetDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 核对金库份额接口反映链上现金和自动收回赎回边界。
 * Verifies that the vault position endpoint reflects the on-chain cash and automatic recall limits.
 */
class VaultPositionLiquidityTest {

    /** 用于模拟目录以及同槽金库和份额记录的固定标识与时间。 Fixed identifiers and time for registry and same-slot vault and position fixtures. */
    private static final String VAULT = "FnumrXNQLu5t1tLE9xJaVZiqGuDw5iyfQpo18j25ztP9";
    private static final String WALLET = "8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H";
    private static final BigInteger SLOT = BigInteger.ONE;
    private static final OffsetDateTime OBSERVED_AT = OffsetDateTime.parse("2026-01-01T00:00:00Z");

    /**
     * 借贷可收回现金还未转入金库，赎回以现金与向下取整后的份额为界。
     * Recallable cash is still in lending, so cash in the vault and floored payouts determine the redemption limit.
     */
    @Test
    void capsRedemptionAtVaultCashAndKeepsPayableRoundedShare() {
        /** 40 现金、60 可收回资金和总共 61 个份额最小单位。 40 in custody, 60 recallable from lending, and 61 share base units. */
        VaultPositionResponse.Snapshot result = indexedPosition(40, 0, 60, 60, 61, 40, false, true);
        assertEquals("100", result.positionValueRaw());
        assertEquals("25", result.maxRedeemSharesRaw());
        assertEquals("40", result.redeemableRaw());
    }

    /**
     * 策略代币折价为零时仍不能销毁最后一个份额最小单位。
     * Keeps the final share base unit while a nonzero spot position rounds to zero value.
     */
    @Test
    void retainsOneShareWhenSpotDustRemains() {
        /** tSOL 残余价值向下取整为零，十份中的九份最多支付三个结算最小单位。 Spot dust floors to zero in value, and nine of ten shares pay three settlement base units. */
        VaultPositionResponse.Snapshot result = indexedPosition(4, 1, 0, 0, 10, 3, true, false);
        assertEquals("4", result.positionValueRaw());
        assertEquals("9", result.maxRedeemSharesRaw());
        assertEquals("3", result.redeemableRaw());
    }

    /**
     * 自动收回额度不足时，用现金与本次可收回额计算最大赎回量。
     * Caps an automatic recall at the sum of custody cash and currently recallable lending cash.
     */
    @Test
    void includesOnlyRecallableCashWhenAutoRecallIsEnabled() {
        VaultPositionResponse.Snapshot result = indexedPosition(40, 0, 60, 25, 61, 40, true, true);
        assertEquals("100", result.positionValueRaw());
        assertEquals("40", result.maxRedeemSharesRaw());
        assertEquals("65", result.redeemableRaw());
    }

    /**
     * 已开启自动收回且借贷资产可全部收回时，可以销毁全部份额。
     * Allows a full vault exit when automatic recall can close the whole lending position.
     */
    @Test
    void allowsFinalExitWhenTheWholePositionCanBeRecalled() {
        VaultPositionResponse.Snapshot result = indexedPosition(40, 0, 60, 60, 61, 40, true, true);
        assertEquals("61", result.maxRedeemSharesRaw());
        assertEquals("100", result.redeemableRaw());
    }

    /**
     * 仍有零价值出借份额时，未启用自动收回或无旧仓位证据的快照保留最后一份。
     * Retains the final share when automatic recall is disabled and lending dust remains or was not tracked.
     */
    @Test
    void protectsFinalShareWhenAnOldLendingPositionMayRemain() {
        assertEquals("9", indexedPosition(4, 0, 0, 0, 10, 4, false, true).maxRedeemSharesRaw());
        assertEquals("9", indexedPosition(4, 0, 0, 0, 10, 4, false, null).maxRedeemSharesRaw());
        assertEquals("10", indexedPosition(4, 0, 0, 0, 10, 4, true, true).maxRedeemSharesRaw());
    }

    /**
     * 通过真实服务读取预先准备的同槽数据库结果。
     * Reads scripted same-slot database rows through the actual service implementation.
     *
     * @param cash 金库现金最小单位数。 Vault cash base units.
     * @param spotAmount 策略代币最小单位数，估值假定小于一个结算最小单位。 Spot base units, assumed to value below one settlement base unit.
     * @param lendingValue 出借份额的结算资产最小单位价值。 Settlement base-unit value of lending shares.
     * @param recallable 当前可手动收回的结算最小单位数。 Settlement base units currently recallable by the manager.
     * @param supply 金库总份额最小单位数，该钱包持有全部。 Vault share supply in base units, all held by this wallet.
     * @param redeemable 历史持仓中保存的可赎回金额。 Historical redeemable proceeds stored on the position.
     * @param autoRecallEnabled 金库能否同一交易收回出借流动性。 Whether the vault can recall lending liquidity in the redemption.
     * @param lendingPositionOpen 采集时是否有非零出借份额，空值表示旧记录未采集。 Whether supply shares were nonzero, or null for a historical observation.
     * @return 接口根据同槽余额和份额算出的响应。 Service response based on same-slot balances and shares.
     */
    private static VaultPositionResponse.Snapshot indexedPosition(long cash, long spotAmount, long lendingValue,
            long recallable, long supply, long redeemable, boolean autoRecallEnabled, Boolean lendingPositionOpen) {
        /** 以计价 Mint 最小单位汇总的净值与份额总量。 NAV in quote mint base units and total share supply. */
        BigInteger nav = BigInteger.valueOf(cash + lendingValue);
        BigInteger totalShares = BigInteger.valueOf(supply);
        VaultSnapshotDO vaultSnapshot = new VaultSnapshotDO("devnet", VAULT, SLOT, OBSERVED_AT, null,
                BigInteger.valueOf(cash), BigInteger.valueOf(spotAmount), BigInteger.ZERO, BigInteger.valueOf(lendingValue),
                BigInteger.valueOf(recallable), nav, totalShares, autoRecallEnabled, lendingPositionOpen);
        VaultPositionSnapshotDO position = new VaultPositionSnapshotDO("devnet", VAULT, WALLET, SLOT, OBSERVED_AT,
                totalShares, nav, BigInteger.valueOf(redeemable));
        /** 三个查询入口返回同一测试金库，避免测试连接线上或本地数据库。 Three lookup entry points return the test vault without connecting to a database. */
        VaultMapper vaults = mapper(VaultMapper.class, "selectByNetworkAndAddress",
                new VaultDO("devnet", VAULT, null, null, null, null, "registered-market"));
        VaultServiceImpl service = new VaultServiceImpl(null,
                mapper(VaultSnapshotMapper.class, "selectByNetworkAndAddressAndSlot", vaultSnapshot),
                mapper(VaultPositionSnapshotMapper.class, "selectLatestByNetworkAndVaultAndWallet", position), 60) {
            /** 返回用于定位本测试金库的模拟目录。 Returns the scripted registry for this fixture. */
            @Override
            public VaultMapper getBaseMapper() {
                return vaults;
            }
        };
        return service.getVaultPosition(SolanaNetwork.DEVNET, VAULT, WALLET).orElseThrow().snapshot();
    }

    /**
     * 创建只实现本例查询方法的 Mapper。
     * Creates a Mapper double for one query method in the fixture.
     *
     * @param type Mapper 接口。 Mapper interface.
     * @param lookup 允许调用的查询方法。 Allowed query method.
     * @param response 方法固定返回的链上观测或目录记录。 Scripted chain observation or registry row.
     * @return 独立于数据库的 Mapper 替身。 Mapper double independent of the database.
     */
    private static <T> T mapper(Class<T> type, String lookup, Object response) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (proxy, method, arguments) -> {
            if (!method.getName().equals(lookup)) {
                throw new AssertionError(method.getName());
            }
            return response;
        }));
    }
}

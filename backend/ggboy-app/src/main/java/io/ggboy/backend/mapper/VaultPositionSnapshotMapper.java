package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import io.ggboy.backend.entity.VaultPositionSnapshotDO;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

/**
 * 通过 MyBatis-Plus 访问{@code vault_position_snapshot} 表中的金库持有人的份额与可赎回金额快照。
 * MyBatis-Plus mapper for snapshots of vault holders' shares and redeemable amounts in {@code vault_position_snapshot}.
 */
@Mapper
public interface VaultPositionSnapshotMapper extends BaseMapper<VaultPositionSnapshotDO> {

    /**
     * 查询指定网络、金库和钱包的最新持仓快照，在数据库中按 slot 数值倒序仅取一条。
     * Reads the latest position for one network, vault, and wallet, limiting the database result to the highest numeric slot.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param vaultAddress 金库状态账户的公钥。 Public key of the vault state account.
     * @param walletAddress 持有份额的钱包公钥。 Public key of the wallet holding the shares.
     * @return 该钱包的最新持仓快照。尚未采集时返回空引用。
     *         The wallet's latest position snapshot, or null if no observation has been collected.
     */
    default VaultPositionSnapshotDO selectLatestByNetworkAndVaultAndWallet(
            String network, String vaultAddress, String walletAddress
    ) {
        // 只取第一页的一条记录。份额区只需最新持仓，因此关闭总数查询。
        // Fetch one row from the first page and skip the total count because only the latest snapshot is needed.
        List<VaultPositionSnapshotDO> snapshots = selectList(
                Page.of(1, 1, false), Wrappers.lambdaQuery(VaultPositionSnapshotDO.class)
                        .eq(VaultPositionSnapshotDO::getNetwork, network)
                        .eq(VaultPositionSnapshotDO::getVaultAddress, vaultAddress)
                        .eq(VaultPositionSnapshotDO::getWalletAddress, walletAddress)
                        .orderByDesc(VaultPositionSnapshotDO::getSlot)
        );
        return snapshots.isEmpty() ? null : snapshots.getFirst();
    }
}

package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import io.ggboy.backend.entity.VaultDO;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

/**
 * 通过 MyBatis-Plus 访问{@code vault} 表中的策略金库登记。
 * MyBatis-Plus mapper for registered strategy vaults in {@code vault}.
 */
@Mapper
public interface VaultMapper extends BaseMapper<VaultDO> {

    /**
     * 查询指定网络下已登记的金库，按金库地址升序返回。
     * List registered vaults on the specified network in ascending vault-address order.
     *
     * <p>用网络限定查询范围，并按金库地址稳定排序，供列表直接展示。
     * Scope the query to one network and order by vault address for stable list presentation.
     *
     * @param network 已校验的网络协议值，支持 {@code localnet} 和 {@code devnet}。
     *                Validated network wire value, either {@code localnet} or {@code devnet}.
     * @return 该网络的金库登记列表，没有登记时返回空列表。
     *         Vault registrations for the network, or an empty list if none are registered.
     */
    default List<VaultDO> selectByNetwork(String network) {
        return selectList(Wrappers.lambdaQuery(VaultDO.class)
                .eq(VaultDO::getNetwork, network)
                .orderByAsc(VaultDO::getVaultAddress));
    }

    /**
     * 按网络和金库地址查询登记记录。两个条件共同构成主键。
     * Looks up a registration by network and vault address, which form the composite key.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param vaultAddress 金库状态账户的公钥。 Public key of the vault state account.
     * @return 该网络下的金库登记。未登记时返回空引用。
     *         The vault registration on that network, or null if unregistered.
     */
    default VaultDO selectByNetworkAndAddress(String network, String vaultAddress) {
        return selectOne(Wrappers.lambdaQuery(VaultDO.class)
                .eq(VaultDO::getNetwork, network)
                .eq(VaultDO::getVaultAddress, vaultAddress));
    }

    /**
     * 检查指定网络和程序是否有登记的金库，避免索引器轮询未配置的数据库。
     * Checks for any registered vault of this network and program, so the indexer can skip unconfigured databases.
     *
     * @param network 已校验的 Solana 网络代码。 Validated Solana network code.
     * @param programId 被跟踪金库程序的公开地址。 Public address of the tracked vault program.
     * @return 至少有一个匹配的登记时为真。 True when at least one matching registration exists.
     */
    default boolean existsByNetworkAndProgram(String network, String programId) {
        return exists(Wrappers.lambdaQuery(VaultDO.class)
                .eq(VaultDO::getNetwork, network)
                .eq(VaultDO::getProgramId, programId));
    }
}

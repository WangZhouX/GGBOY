package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.api.VaultHistorySnapshotResponse;
import io.ggboy.backend.api.VaultListResponse;
import io.ggboy.backend.api.VaultPositionResponse;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.common.api.CursorPage;
import io.ggboy.common.api.SolanaNetwork;
import java.math.BigInteger;
import java.util.Optional;

/**
 * 提供金库目录、历史快照及钱包持仓查询，并维护登记信息。
 * Provides vault registration persistence and queries for directory, history and wallet positions.
 */
public interface VaultService extends IService<VaultDO> {

    /**
     * 在同一个网络内组装金库目录、资产元数据和最新快照。
     * Assembles vault registrations, asset metadata, and latest snapshots for one network.
     *
     * @param network 已由 HTTP 层解析的目标网络。 Target network already parsed by the HTTP layer.
     * @return 按金库地址升序排列的列表数据。没有金库时返回空列表，没有快照时保留该金库条目。
     *        List payload ordered by vault address. No vaults yields an empty list; a vault without a snapshot is retained.
     */
    VaultListResponse listVaults(SolanaNetwork network);

    /**
     * 返回一个已登记金库的历史快照页，按数值 slot 倒序。
     * Returns a snapshot history page for a registered vault in descending numeric slot order.
     *
     * @param network 已解析的目标网络。 Parsed target network.
     * @param vaultAddress 已校验的金库公钥。 Validated vault public key.
     * @param beforeSlot 上页末条记录的 slot，当前页严格小于该值。首次请求时为空。
     *        Exclusive slot boundary from the previous page, or null for the first page.
     * @param limit 已校验的最大返回条数，范围为 1 至 100。 Validated maximum result count from 1 to 100.
     * @return 已登记金库的历史页，可为空页。金库未登记时返回空 Optional。
     *        History page for a registered vault, possibly with no items. Empty Optional for an unregistered vault.
     */
    Optional<CursorPage<VaultHistorySnapshotResponse>> listVaultSnapshots(
            SolanaNetwork network, String vaultAddress, BigInteger beforeSlot, int limit
    );

    /**
     * 查询钱包最新观测的份额，并用同一 slot 的金库快照确定可赎回上限。
     * Reads the latest observed wallet shares and resolves the redemption limit at the same vault slot.
     *
     * @param network 已解析的目标网络。 Parsed target network.
     * @param vaultAddress 已校验的金库状态账户公钥。 Validated vault state account public key.
     * @param walletAddress 已校验的份额持有人公钥。 Validated share holder public key.
     * @return 金库未登记时返回空 Optional。钱包尚未被采集时返回包含空快照的数据。
     *        Empty Optional if the vault is unregistered, or a payload with a null snapshot if the wallet is unobserved.
     */
    Optional<VaultPositionResponse> getVaultPosition(SolanaNetwork network, String vaultAddress, String walletAddress);
}

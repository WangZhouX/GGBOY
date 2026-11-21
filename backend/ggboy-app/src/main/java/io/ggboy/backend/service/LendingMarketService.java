package io.ggboy.backend.service;

import com.baomidou.mybatisplus.spring.service.IService;
import io.ggboy.backend.api.LendingMarketListResponse;
import io.ggboy.backend.api.LendingPositionResponse;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.common.api.SolanaNetwork;

import java.util.Optional;

/**
 * 提供借贷市场登记、资金池概况和钱包仓位查询。
 * Provides lending market registration, pool overview, and wallet position queries.
 */
public interface LendingMarketService extends IService<LendingMarketDO> {

    /**
     * 查询指定网络的借贷市场及其最新资金池快照。
     * Lists lending markets and the latest pool snapshot for each market on the requested network.
     *
     * @param network 已解析的目标 Solana 网络。 The parsed Solana network for the query.
     * @return 按市场地址升序排列的登记列表。尚未采集快照的市场仍保留。
     *         Market registrations ordered by address, including markets without observations.
     */
    LendingMarketListResponse listMarkets(SolanaNetwork network);

    /**
     * 查询指定钱包的最新借款与出借仓位，并用同 slot 的市场快照验证额度。
     * Reads the wallet's latest borrow and supply position and uses the same-slot market snapshot for limits.
     *
     * @param network 已解析的目标 Solana 网络。 Parsed Solana network for the query.
     * @param marketAddress 已验证的市场状态账户公钥。 Validated market state account public key.
     * @param walletAddress 已验证的钱包公钥。 Validated wallet public key.
     * @return 未登记市场返回空 Optional。已登记市场始终保留，尚未采集的钱包快照为空。
     *         Empty Optional for an unregistered market. For a registered market, the snapshot may be null.
     */
    Optional<LendingPositionResponse> getLendingPosition(
            SolanaNetwork network, String marketAddress, String walletAddress);
}

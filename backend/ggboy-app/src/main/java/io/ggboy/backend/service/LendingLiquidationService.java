package io.ggboy.backend.service;

import io.ggboy.backend.api.LendingLiquidationPageResponse;
import io.ggboy.backend.api.LiquidationCursor;
import io.ggboy.common.api.SolanaNetwork;

import java.util.Optional;

/**
 * 为借贷页面「清算市场」提供已验证价格下的最新可清算仓位。
 * Serves the latest liquidatable positions with a verified price for Lending → Liquidation Market.
 */
public interface LendingLiquidationService {

    /**
     * 进入清算市场、切换网络或市场时加载首页，继续浏览时传入上一页返回的游标。
     * Load the first page when opening the liquidation market or switching network or market.
     * Pass the returned cursor to continue browsing.
     *
     * @param network 已解析的 Solana 网络。 The parsed Solana network.
     * @param marketAddress 已校验的借贷市场公钥。 The validated lending market public key.
     * @param limit 已校验的单页条数上限。 The validated maximum number of items per page.
     * @param cursor 可选的清算分页游标，首页传空值。 The optional pagination cursor, null for the first page.
     * @return 已登记市场的清算页，未登记返回空 Optional。
     *         The liquidation page for a registered market, or an empty Optional for an unknown market.
     * @throws LiquidationCursor.ObservationChangedException 游标绑定的市场观测已变更。
     *                                                       The market observation bound to the cursor changed.
     */
    Optional<LendingLiquidationPageResponse> listLiquidations(
            SolanaNetwork network, String marketAddress, int limit, LiquidationCursor cursor
    );
}

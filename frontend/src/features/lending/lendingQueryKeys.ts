import type { LendingMarketListItem } from './api/listLendingMarkets';

/**
 * 为同一市场的公共链上现金构建缓存标识。
 * Build the public on-chain cash cache key for one market.
 *
 * @param market 当前登记，包含两个经过链上核对的 Mint 及其精度。 Registration with both mint addresses and decimals checked on-chain.
 */
export function devnetLendingCashQueryKey(market: LendingMarketListItem | null | undefined) {
  return ['devnet-lending-cash', market?.address, market?.debtAsset.mint, market?.debtAsset.decimals,
    market?.collateralAsset.mint, market?.collateralAsset.decimals] as const;
}

/**
 * 为市场内所有钱包的借款观测构建统一前缀，供出借或提取改变池现金时刷新。
 * Build a prefix covering all borrower observations for a market so supply or withdrawal can refresh them.
 *
 * @param market 已核对的市场目录条目。 Verified market registry entry.
 */
export function borrowMarketQueryKey(market: LendingMarketListItem | undefined) {
  return ['devnet-lending-borrow-position', ...devnetLendingCashQueryKey(market).slice(1)] as const;
}

/**
 * 按市场、资产和钱包隔离借款状态。
 * Scope borrowing state by market, assets, and wallet.
 *
 * @param market 已核对的市场目录条目。 Verified market registry entry.
 * @param walletAddress Phantom 当前公开地址，未连接时为空。 Current public Phantom address, null when disconnected.
 */
export function borrowPositionQueryKey(market: LendingMarketListItem | undefined, walletAddress: string | null) {
  return [...borrowMarketQueryKey(market), walletAddress] as const;
}

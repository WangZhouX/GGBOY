import { skipToken, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { readDevnetBorrowPosition, type DevnetBorrowPosition } from '../../solana/lending/borrowLendingPosition';
import { devnetBorrowActivityQueryKey } from '../../solana/lending/readBorrowActivity';
import type { LendingMarketListItem } from './api/listLendingMarkets';
import { borrowPositionQueryKey, devnetLendingCashQueryKey } from './lendingQueryKeys';
import { isDevnetSupplyMarket } from './useDevnetSupplyPosition';

/** 借款和出借使用同一已登记的 GGBOY Devnet 部署。 Borrowing and supplying use the same registered GGBOY Devnet deployment. */
export const isDevnetBorrowMarket = isDevnetSupplyMarket;

/**
 * 为「我的借款」和交易操作页读取同一个链上仓位。
 * Read the same on-chain position for My Borrowing and the transaction pages.
 *
 * @param market 当前选择的市场。 Current market selection.
 * @param walletAddress 当前钱包公钥。 Current wallet public key.
 * @returns 包含仓位、价格、资金池及钱包余额的查询状态。 Query state for position, price, pool, and wallet balances.
 */
export function useDevnetBorrowPosition(market: LendingMarketListItem | undefined, walletAddress: string | null) {
  /** 同一钱包的刷新不接受早于已知结果的观测。 Refreshes for this wallet cannot regress behind the prior observation. */
  const queryClient = useQueryClient();
  const selected = isDevnetBorrowMarket(market) ? market : undefined;
  const queryKey = borrowPositionQueryKey(selected, walletAddress);
  /** 公共现金缓存记录同一市场较新的出借或提取结果。 The shared cash cache can contain a more recent supply or withdrawal. */
  const cashKey = devnetLendingCashQueryKey(selected);

  return useQuery({
    queryKey,
    queryFn: selected && walletAddress ? ({ signal }) => readDevnetBorrowPosition(selected, walletAddress, {
      signal,
      // 读到的借款额度至少包含先前已确认的池现金与钱包仓位。
      // Include at least the prior finalized pool cash and wallet position when reading borrowing limits.
      minContextSlot: Math.max(
        queryClient.getQueryData<DevnetBorrowPosition>(queryKey)?.slot ?? 0,
        queryClient.getQueryData<{ slot: number }>(cashKey)?.slot ?? 0,
      ),
    }) : skipToken,
    refetchInterval: 30_000,
  });
}

/**
 * 使用交易最终确认的 slot 作为刷新下限，同时更新钱包仓位和公共市场现金。
 * Use the finalized transaction slot as the refresh floor and update both the position and public market cash.
 *
 * @param queryClient 全站共用的查询缓存。 Application query cache.
 * @param market 本笔交易的市场。 Market for this transaction.
 * @param walletAddress 本笔交易的签名钱包。 Wallet that signed this transaction.
 * @param minContextSlot 已确认回执提供的最低 slot。 Minimum slot from the finalized receipt.
 * @returns 已确认的仓位观测，含实际钱包余额和资金池余额。 Finalized position observation with actual wallet and pool cash.
 */
export async function syncDevnetBorrow(
  queryClient: QueryClient,
  market: LendingMarketListItem,
  walletAddress: string,
  minContextSlot: number,
): Promise<DevnetBorrowPosition> {
  if (!isDevnetBorrowMarket(market)) throw new Error('Unsupported Devnet borrowing market.');

  /** 阻止确认前的旧请求覆盖确认后的仓位或现金。 Prevent a pre-confirmation query from overwriting the confirmed position or cash. */
  const positionKey = borrowPositionQueryKey(market, walletAddress);
  const cashKey = devnetLendingCashQueryKey(market);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: positionKey, exact: true }),
    queryClient.cancelQueries({ queryKey: cashKey, exact: true }),
  ]);

  /** 链的最终确认观测可能来自不同节点，使用两项缓存和回执中最新的 slot。 RPC nodes may differ, so use the newest slot from the receipt and both caches. */
  const observation = await readDevnetBorrowPosition(market, walletAddress, {
    minContextSlot: Math.max(
      minContextSlot,
      queryClient.getQueryData<DevnetBorrowPosition>(positionKey)?.slot ?? 0,
      queryClient.getQueryData<{ slot: number }>(cashKey)?.slot ?? 0,
    ),
  });
  if (!observation.positionExists) throw new Error('Finalized borrowing position is unavailable.');

  queryClient.setQueryData<DevnetBorrowPosition>(positionKey, (previous) =>
    previous && previous.slot > observation.slot ? previous : observation);
  queryClient.setQueryData<{ slot: number; cashRaw: bigint }>(cashKey, (previous) =>
    previous && previous.slot > observation.slot ? previous : { slot: observation.slot, cashRaw: observation.cashRaw });

  // 下次打开「我的借款」时读取新活动。活动接口临时不可用仍保留已核对的仓位。
  // Fetch new history on My Borrowing while keeping the verified position if history is temporarily unavailable.
  void queryClient.invalidateQueries({ queryKey: devnetBorrowActivityQueryKey(market.address, walletAddress), exact: true });
  return observation;
}

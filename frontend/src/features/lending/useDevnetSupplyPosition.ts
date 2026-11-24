import { skipToken, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  devnetLendingPool,
  readDevnetLendingSupply,
  type DevnetLendingSupply,
} from '../../solana/lending/devnetLendingPool';
import type { LendingSupplyAction } from '../../solana/lending/supplyLendingPool';
import type { LendingMarketListItem } from './api/listLendingMarkets';
import { borrowMarketQueryKey, devnetLendingCashQueryKey } from './lendingQueryKeys';

/**
 * 判断选中的登记记录是否为支持 Phantom 出借的 GGBOY Devnet 市场。
 * Check whether the selected registry entry supports Phantom supply on GGBOY Devnet.
 *
 * @param market 来自当前网络的登记记录，尚未加载时为空。 Current-network registration, absent until loaded.
 * @returns 网络、程序和市场 PDA 都与公开部署匹配时返回 true。 True when cluster, program, and market PDA match the configured deployment.
 */
export function isDevnetSupplyMarket(market: LendingMarketListItem | undefined): market is LendingMarketListItem {
  return market?.network === 'devnet' && market.programId === devnetLendingPool.programId
    && market.address === devnetLendingPool.marketAddress;
}

/**
 * 在市场和两种资产的范围内按钱包隔离出借数据。
 * Scope supply observations by wallet within the market and its assets.
 *
 * @param market 当前链上借贷市场登记。 Registered on-chain lending market.
 * @param walletAddress Phantom 返回的 Base58 公钥，断开时为空。 Phantom Base58 public key, null when disconnected.
 */
function supplyPositionQueryKey(market: LendingMarketListItem | undefined, walletAddress: string | null) {
  return ['devnet-lending-supply-position', ...devnetLendingCashQueryKey(market).slice(1), walletAddress] as const;
}

/**
 * 用同一个链上观测展示钱包代币余额和市场份额。
 * Show wallet token balance and market shares from the same on-chain observation.
 *
 * @param market 当前市场。 Current market.
 * @param walletAddress 已连接钱包的公钥。 Connected wallet public key.
 * @returns 为操作页及「我的出借」共用的链上查询结果。 On-chain query shared by the supply form and My Supply.
 */
export function useDevnetSupplyPosition(market: LendingMarketListItem | undefined, walletAddress: string | null) {
  /** 同一钱包和市场切页时重用结果，按 slot 防止刷新回退。 Reuse the same wallet and market across routes and prevent slot regressions. */
  const queryClient = useQueryClient();
  const selected = isDevnetSupplyMarket(market) ? market : undefined;
  const queryKey = supplyPositionQueryKey(selected, walletAddress);
  return useQuery({
    queryKey,
    queryFn: selected && walletAddress
      ? ({ signal }) => readDevnetLendingSupply(selected, walletAddress, {
          signal,
          minContextSlot: queryClient.getQueryData<DevnetLendingSupply>(queryKey)?.slot,
        })
      : skipToken,
  });
}

/**
 * 在已确认的交易 slot 或更新位置重读出借状态，同步两个页面的缓存。
 * Read supply at or after the confirmed transaction slot and synchronize both page caches.
 *
 * @param queryClient 全站共享的查询缓存。 Application-wide query cache.
 * @param market 此交易锁定的 Devnet 市场。 Market bound to this transaction.
 * @param walletAddress 此交易的实际签名人。 Actual transaction signer.
 * @param minContextSlot 已最终确认交易的 slot，下方快照不得更早。 Finalized transaction slot, which the observation must not precede.
 * @param action 本次操作，全部提取后允许仓位变为零份额。 Operation, allowing a zero-share position after a full withdrawal.
 * @returns 验证后的最新仓位与资金池余额。 Verified position and pool cash.
 */
export async function syncDevnetSupply(
  queryClient: QueryClient,
  market: LendingMarketListItem,
  walletAddress: string,
  minContextSlot: number,
  action: LendingSupplyAction,
): Promise<DevnetLendingSupply> {
  if (!isDevnetSupplyMarket(market)) throw new Error('Unsupported Devnet lending market.');

  /** 现金和出借仓位使用各自的缓存标识。 Cash and supply position use separate cache keys. */
  const positionKey = supplyPositionQueryKey(market, walletAddress);
  const cashKey = devnetLendingCashQueryKey(market);
  // 取消在途的旧观测，避免交易前的读取覆盖确认后的余额和份额。
  // Cancel in-flight observations so a pre-transaction read cannot overwrite finalized balances.
  await Promise.all([
    queryClient.cancelQueries({ queryKey: positionKey, exact: true }),
    queryClient.cancelQueries({ queryKey: cashKey, exact: true }),
  ]);

  /** 缓存有更高的 slot 时也保持单调，两个页面从同一读链结果刷新。 Respect any newer cached slot and update both views from the same observation. */
  const priorPositionSlot = queryClient.getQueryData<DevnetLendingSupply>(positionKey)?.slot ?? 0;
  const priorCashSlot = queryClient.getQueryData<{ slot: number }>(cashKey)?.slot ?? 0;
  const observation = await readDevnetLendingSupply(market, walletAddress, {
    minContextSlot: Math.max(minContextSlot, priorPositionSlot, priorCashSlot),
  });
  // 上链后仍须能读取仓位账户。取出全部份额保留 PDA，其中份额为零。
  // The finalized position account must remain readable. A full withdrawal retains the PDA with zero shares.
  if (!observation.positionExists || (action === 'deposit' && observation.sharesRaw === 0n)) {
    throw new Error('Finalized supply position is unavailable.');
  }

  queryClient.setQueryData<DevnetLendingSupply>(positionKey, (previous) =>
    previous && previous.slot > observation.slot ? previous : observation);
  queryClient.setQueryData<{ slot: number; cashRaw: bigint }>(cashKey, (previous) =>
    previous && previous.slot > observation.slot ? previous : { slot: observation.slot, cashRaw: observation.cashRaw });
  // 出借或提取会改变同一池的借款额度。返回借款页时立即读链，避免沿用交易前的额度。
  // Supply and withdrawal change borrowing liquidity. Refresh on return so the form cannot reuse a pre-transaction limit.
  void queryClient.invalidateQueries({ queryKey: borrowMarketQueryKey(market) });
  return observation;
}

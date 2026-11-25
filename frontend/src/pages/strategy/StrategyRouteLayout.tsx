import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { Outlet, useOutletContext, useSearchParams } from 'react-router';
import { listVaults } from '../../features/vault/api/listVaults';
import { useNetwork, type Network } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import { usePhantomWallet } from '../../solana/phantomWallet';
import { devnetVaultConfig } from '../../solana/vault/devnetVault';
import { readVaultStrategy } from '../../solana/vault/strategyVault';

/** 页面独立路由对应的策略操作。 Strategy operations that have dedicated pages. */
export const strategyActions = ['swap', 'lend', 'recall'] as const;
/** 由页面或路由选择的操作。 Operation selected by a page or route. */
export type StrategyAction = (typeof strategyActions)[number];

/** 行为和固定路由配对，独立表单保留明确的入口。 Pair each operation with its dedicated route. */
const actionPaths = { swap: paths.strategySwap, lend: paths.strategyLend, recall: paths.strategyRecall } as const;

/**
 * 构建策略管理或操作页的链接，保留当前链和金库。
 * Build a strategy management or operation link scoped to the current network and vault.
 *
 * @param network 当前选择的链上网络。 Active blockchain network.
 * @param vault 当前金库的公开地址。 Public address of the selected vault.
 * @param action 要进入的策略操作，省略时返回管理首页。 Operation to open, or omit for the management overview.
 */
export function strategyLocation(network: Network, vault?: string, action?: StrategyAction): string {
  /** URL 只由当前页面和目录项构成。 Build the search string only from the page scope and the registry entry. */
  const params = new URLSearchParams({ network });
  if (vault) params.set('vault', vault);
  return (action ? actionPaths[action] : paths.strategy) + '?' + params.toString();
}

/**
 * 保留策略管理首页和三个操作页共享的网络、已登记金库和钱包。
 * Share the active network, registered vault, and wallet across management and operation routes.
 */
function useStrategyRouteState() {
  /** 当前网络与可签名钱包由全站导航统一管理。 Site navigation owns the network and the wallet used to sign. */
  const { network } = useNetwork();
  const wallet = usePhantomWallet();
  /** 金库选择写入 URL，以便操作回退后保留目标。 Store the selection in the URL so back navigation keeps the target. */
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedAddress = searchParams.get('vault');
  /** 复用策略金库目录查询缓存，按网络取消过期请求。 Reuse the vault registry cache and cancel obsolete network reads. */
  const catalog = useQuery({
    queryKey: ['vaults', network],
    queryFn: ({ signal }) => listVaults({ network }, signal),
  });
  /** 明确地址的链接只能选中本网络的对应金库。 Explicit addresses only select a matching vault on this network. */
  const vaults = catalog.data?.items ?? [];
  const selected = requestedAddress === null ? vaults[0] : vaults.find((vault) => vault.address === requestedAddress);
  /** 只接受当前 GGBOY 程序及其规范金库，网络配置由 RPC 客户端核验。 Read only the GGBOY program and its canonical vault, with network configuration validated by the RPC client. */
  const supported = selected?.address === devnetVaultConfig.vaultAddress.toBase58()
    && selected.programId === devnetVaultConfig.programId.toBase58()
    && selected.quoteAsset.decimals === 6 && selected.shareAsset.decimals === 6;
  /** 当前查询及已确认区块下限按网络与金库隔离。 Isolate each read and its confirmed slot floor by network and vault. */
  const queryClient = useQueryClient();
  const minSlots = useRef(new Map<string, number>());
  const scope = network + ':' + selected?.address;
  const chainKey = ['vault-strategy', network, selected?.address, selected?.quoteAsset.mint, selected?.shareAsset.mint] as const;
  /** 不连接钱包也可读取公共金库余额。 Public vault balances are readable without connecting a wallet. */
  const chain = useQuery({
    queryKey: chainKey,
    queryFn: supported && selected
      ? ({ signal }) => readVaultStrategy(selected, minSlots.current.get(scope), signal)
      : skipToken,
    refetchInterval: 30_000,
  });

  /**
   * 交易后至少读取到确认 slot，同步相关页面的公共数据。
   * Read no earlier than the confirmation slot and refresh other pages using public vault data.
   *
   * @param slot 策略交易确认的链上区块槽。 Slot at which the strategy transaction confirmed.
   */
  async function refreshAfterTransaction(slot: number) {
    minSlots.current.set(scope, Math.max(minSlots.current.get(scope) ?? 0, slot));
    await queryClient.cancelQueries({ queryKey: chainKey, exact: true });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: chainKey, exact: true }, { throwOnError: true }),
      queryClient.invalidateQueries({ queryKey: ['devnet-vault-state', selected?.address] }),
      queryClient.invalidateQueries({ queryKey: ['vaults', network] }),
      queryClient.invalidateQueries({ queryKey: ['activities', 'strategy', network, selected?.address] }),
      queryClient.invalidateQueries({ queryKey: ['activities', network, 'strategy'] }),
    ]);
  }

  /**
   * 把已选择的目录项写入路由。
   * Update the registered vault selected on the route.
   *
   * @param address 当前网络的金库公钥。 Vault public key on the active network.
   */
  function selectVault(address: string) {
    setSearchParams(new URLSearchParams({ network, vault: address }), { replace: true });
  }

  return { network, wallet, catalog, requestedAddress, vaults, selected, supported, chain, selectVault, refreshAfterTransaction };
}

/** 为策略操作页保留公共查询。 Keep public queries shared across the strategy operation pages. */
export function StrategyRouteLayout() {
  /** 使用 React Router 的子路由上下文，避免重复建立读取。 Use React Router outlet context to avoid duplicate reads. */
  const state = useStrategyRouteState();
  return <Outlet context={state} />;
}

/** 读取策略管理父路由的公共状态。 Read shared state from the parent strategy route. */
export function useStrategyRoute() {
  return useOutletContext<ReturnType<typeof useStrategyRouteState>>();
}

/**
 * 给管理操作提供单一的阻断原因，公开余额可独立展示。
 * Resolve one reason an operation is blocked while keeping public balances available.
 *
 * @param state 当前路由、查询和钱包状态。 Current route, query, and wallet state.
 * @returns 阻断原因翻译键，允许继续时为空。 Translation key of the blocking condition, or null when permitted.
 */
export function strategyGate(state: ReturnType<typeof useStrategyRouteState>): string | null {
  if (state.catalog.isPending) return 'strategy.loadingVault';
  if (state.catalog.isError) return 'strategy.vaultError';
  if (!state.selected) return state.requestedAddress ? 'strategy.unknownVault' : 'strategy.noVault';
  if (!state.supported) return 'strategy.unsupported';
  if (state.chain.isPending) return 'strategy.loadingChain';
  if (state.chain.isError) return 'strategy.chainError';
  if (!state.chain.data?.config) return 'strategy.unconfigured';
  if (state.wallet.status !== 'connected' || !state.wallet.walletAddress) return 'strategy.connectManager';
  if (state.chain.data.config.manager.toBase58() !== state.wallet.walletAddress) return 'strategy.notManager';
  return null;
}

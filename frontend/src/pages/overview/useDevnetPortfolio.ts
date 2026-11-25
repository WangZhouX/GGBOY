import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { listLendingMarkets } from '../../features/lending/api/listLendingMarkets';
import { useDevnetBorrowPosition } from '../../features/lending/useDevnetBorrowPosition';
import { isDevnetSupplyMarket, useDevnetSupplyPosition } from '../../features/lending/useDevnetSupplyPosition';
import { listVaults } from '../../features/vault/api/listVaults';
import { devnetVaultStateKey, isSupportedDevnetVault } from '../../features/vault/devnetVaultQueryKeys';
import { readDevnetVault, type DevnetVaultState } from '../../solana/vault/devnetVault';

/** 目录与读链查询共有的状态。 Status shared by registry and chain reads. */
type QueryStatus = { isPending: boolean; isError: boolean };

/**
 * 为单个仓位或余额区块说明尚不能显示金额的原因。
 * Describe why an amount cannot yet be shown in a position or balance section.
 *
 * @param registry 公共部署目录的查询状态。 Public deployment registry query status.
 * @param registered 是否已找到匹配的 GGBOY Devnet 部署。 Whether a matching GGBOY Devnet deployment has been found.
 * @param observation 该部署上钱包数据的查询状态。 Status of the wallet observation from that deployment.
 * @returns 翻译键后缀；最近一次查询成功时为空。 Translation key suffix, or null if the latest read succeeded.
 */
export function portfolioReadStatus(registry: QueryStatus, registered: boolean, observation: QueryStatus) {
  if (!registered) return registry.isError ? 'registryError' : registry.isPending ? 'loading' : 'notRegistered';
  if (observation.isError) return 'readError';
  return observation.isPending ? 'loading' : null;
}

/**
 * 汇总同一个已连接 Devnet 钱包的各模块读链结果。
 * Collect each module's on-chain data for the same connected Devnet wallet.
 *
 * @param walletAddress 只在连接钱包且选中 Devnet 时传入的 Base58 公钥。 Base58 public key supplied only while a wallet and Devnet are selected.
 * @returns 单独的目录、金库和借贷查询状态以及刷新操作。 Separate catalog, vault and lending query results and their refresh action.
 */
export function useDevnetPortfolio(walletAddress: string) {
  /** 目录键与业务页相同，选择可验证的部署而不依赖目录排序。 Registry keys match the detail pages. Select the verified deployment without depending on registry order. */
  const vaultCatalog = useQuery({
    queryKey: ['vaults', 'devnet'],
    queryFn: ({ signal }) => listVaults({ network: 'devnet' }, signal),
  });
  const marketCatalog = useQuery({
    queryKey: ['lending-markets', 'devnet'],
    queryFn: ({ signal }) => listLendingMarkets({ network: 'devnet' }, signal),
  });
  const vault = vaultCatalog.data?.items.find(isSupportedDevnetVault);
  const market = marketCatalog.data?.items.find(isDevnetSupplyMarket);

  /** 金库缓存键与存赎页相同，查询不回退到旧 slot。 The vault cache key matches its transaction pages, and observations cannot regress to earlier slots. */
  const queryClient = useQueryClient();
  const vaultKey = devnetVaultStateKey(vault?.address, walletAddress);
  const vaultRead = useQuery({
    queryKey: vaultKey,
    queryFn: vault
      ? ({ signal }) => readDevnetVault(walletAddress, queryClient.getQueryData<DevnetVaultState>(vaultKey)?.slot, signal)
      : skipToken,
  });

  /** 复用借贷页的读链与交易确认后缓存，从同一贷款市场读取钱包仓位。 Reuse lending reads and their post-confirmation cache for wallet positions at the same market. */
  const supplyRead = useDevnetSupplyPosition(market, walletAddress);
  const borrowRead = useDevnetBorrowPosition(market, walletAddress);

  /** 手动刷新保留相同的网络与钱包范围，缺少部署时重查目录。 Refresh the same network and wallet, retrying the catalog when a deployment is missing. */
  function refresh() {
    void vaultCatalog.refetch();
    void marketCatalog.refetch();
    if (vault) void vaultRead.refetch();
    if (market) {
      void supplyRead.refetch();
      void borrowRead.refetch();
    }
  }

  /** 查询进行中可保留已有成功结果，同时省去重复刷新。 Preserve existing successful results while reads are in flight and avoid repeated refreshes. */
  const isRefreshing = vaultCatalog.isFetching || marketCatalog.isFetching || vaultRead.isFetching
    || supplyRead.isFetching || borrowRead.isFetching;

  return { vaultCatalog, marketCatalog, vault, market, vaultRead, supplyRead, borrowRead, refresh, isRefreshing };
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { Outlet, useOutletContext, useSearchParams } from 'react-router';
import { listVaults, type VaultListItem } from '../../features/vault/api/listVaults';
import { useNetwork } from '../../shared/navigation/network';
import { usePhantomWallet } from '../../solana/phantomWallet';
import { devnetVaultConfig, readDevnetVault } from '../../solana/vault/devnetVault';

/** 金库页和存赎页共用的 Devnet 读链前缀。 Devnet read prefix shared by vault details and transaction routes. */
const devnetVaultQueryKey = ['devnet-vault-state'] as const;

/**
 * 检查所选金库是否匹配可签名的 Devnet 现金金库部署。
 * Check whether a registry entry matches the supported Devnet deployment for transactions.
 *
 * @param vault 已登记的金库。 Registered vault to validate.
 * @returns 网络、程序、金库、Mint、精度和资金配置全部匹配时为 true。 True when network, program, vault, mints, decimals and allocation match.
 */
function isDevnetCashVault(vault: VaultListItem) {
  return vault.network === 'devnet' &&
    vault.address === devnetVaultConfig.vaultAddress.toBase58() &&
    vault.programId === devnetVaultConfig.programId.toBase58() &&
    vault.quoteAsset.mint === devnetVaultConfig.assetMint.toBase58() &&
    vault.shareAsset.mint === devnetVaultConfig.shareMint.toBase58() &&
    vault.quoteAsset.decimals === 6 && vault.shareAsset.decimals === 6 &&
    vault.strategyAsset === null && vault.lendingMarketAddress === null;
}

/**
 * 保存同一组金库路由共享的选择、读链和确认后刷新规则。
 * Keep vault selection, chain reads, and post-confirmation refresh rules shared across vault routes.
 */
function useVaultRouteState() {
  /** 网络从 URL 取得，钱包地址由顶栏连接状态提供。 Network comes from the URL, and the header's wallet connection supplies the address. */
  const { network } = useNetwork();
  const { walletAddress } = usePhantomWallet();
  /** 正式选中的金库可随路由复制和恢复。 The selected vault can be copied and restored with the URL. */
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAddress = searchParams.get('vault');
  /** 查询客户端用于统一刷新钱包余额和金库余额。 Query client coordinating vault and wallet balance refreshes. */
  const queryClient = useQueryClient();
  /** 父路由在主页与存赎页切换时保留已确认的最高 slot。 The parent route retains the highest confirmed slot across vault and operation screens. */
  const minReadSlot = useRef<number | undefined>(undefined);

  /** 从当前网络的目录查询金库。切换网络可取消旧请求。 Query the active network's vault registry and cancel obsolete network reads. */
  const catalog = useQuery({
    queryKey: ['vaults', network],
    queryFn: ({ signal }) => listVaults({ network }, signal),
  });
  /** 无显式选择时使用第一座金库。主页在跨网络后也可回退首项。 The default is the first vault; the overview can also fall back after a network change. */
  const vaults = catalog.data?.items;
  const requestedVault = vaults?.find((vault) => vault.address === selectedAddress);
  const selectedVault = requestedVault ?? vaults?.[0];
  /** 存赎深链接必须得到原本指定的金库，避免向回退金库提交。 A transaction deep link must target its specified vault rather than the overview's fallback. */
  const unsupportedSelection = selectedAddress !== null && !requestedVault;
  /** 仅为已验证的所选现金金库读取实时状态。 Read current state only for a supported, verified cash vault. */
  const cashVault = selectedVault && isDevnetCashVault(selectedVault) ? selectedVault : undefined;
  const chain = useQuery({
    queryKey: [...devnetVaultQueryKey, cashVault?.address, walletAddress],
    enabled: cashVault !== undefined,
    queryFn: ({ signal }) => readDevnetVault(walletAddress, minReadSlot.current, signal),
    refetchInterval: 30_000,
  });

  /**
   * 刷新已登记金库和当前现金金库的链上读数。
   * Refresh registered vaults and the selected cash vault's chain state.
   */
  function refreshOverview() {
    void catalog.refetch();
    if (cashVault) void chain.refetch();
  }

  /**
   * 在存赎确认后重查余额，忽略落在交易之前或仍在途中的读数。
   * Re-read balances after confirmation, excluding pre-transaction and in-flight reads.
   *
   * @param slot 刚确认交易的链上 slot。 Chain slot of the newly confirmed transaction.
   */
  async function refreshAfterTransaction(slot: number) {
    minReadSlot.current = Math.max(minReadSlot.current ?? 0, slot);
    await queryClient.cancelQueries({ queryKey: devnetVaultQueryKey });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: devnetVaultQueryKey }, { throwOnError: true }),
      queryClient.invalidateQueries({ queryKey: ['sol-balance', 'devnet'] }),
    ]);
  }

  /**
   * 更新当前网络中所选金库的 URL 查询参数。
   * Update the URL parameter for the selected vault on the current network.
   *
   * @param address 用户在选择器中选中的已登记公钥。 Registered public key selected in the vault picker.
   */
  function selectVault(address: string) {
    setSearchParams(new URLSearchParams({ network, vault: address }), { replace: true });
  }

  return {
    network, walletAddress, vaults, selectedVault, cashVault, unsupportedSelection, catalog, chain,
    refreshOverview, refreshAfterTransaction, selectVault,
  };
}

/**
 * 在三个金库页面切换时保持公共查询和已确认交易的观测下限。
 * Preserve shared queries and the confirmed observation floor across the three vault pages.
 */
export function VaultRouteLayout() {
  /** 金库子路由读取的公共状态。 Shared state consumed by the vault child routes. */
  const state = useVaultRouteState();
  return <Outlet context={state} />;
}

/**
 * 获取最近的金库父路由提供的公共查询和刷新方法。
 * Read shared vault queries and refresh actions from the nearest vault parent route.
 */
export function useVaultRoute() {
  return useOutletContext<ReturnType<typeof useVaultRouteState>>();
}

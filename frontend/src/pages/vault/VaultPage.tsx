import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listVaults, type VaultListItem } from '../../features/vault/api/listVaults';
import { toLiveVaultOverview, toLiveVaultPosition } from '../../features/vault/liveVaultView';
import { useNetwork } from '../../shared/navigation/network';
import { PageLayout } from '../../shared/ui/PageLayout';
import { usePhantomWallet } from '../../solana/phantomWallet';
import { devnetVaultConfig, readDevnetVault } from '../../solana/vault/devnetVault';
import { VaultDepositSection } from './VaultDepositSection';
import { VaultNavHistorySection } from './VaultNavHistorySection';
import { VaultOverviewCards } from './VaultOverviewCards';
import { VaultPositionSection } from './VaultPositionSection';
import { VaultRedeemSection } from './VaultRedeemSection';
import './styles/vault-page.css';

/** Devnet 金库读链的查询前缀，确认后用于清理各钱包的旧缓存。 Prefix for Devnet vault reads, used to invalidate wallet caches after confirmation. */
const devnetVaultQueryKey = ['devnet-vault-state'] as const;

/**
 * 只有与公开部署匹配的现金金库才使用实时读链和存赎。
 * Enable live reads, deposits, and redemptions only for the matching public cash-vault deployment.
 *
 * @param vault 后端目录返回的一条金库配置。 A vault catalog entry from the backend.
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
 * 加载金库目录、Devnet 当前余额和历史，并让存赎与份额使用同一个金库选择。
 * Load the catalog, current Devnet balances, and history with a shared vault selection.
 */
export function VaultPage() {
  /** 页面标题与加载、空列表和出错状态使用当前语言。 Use the current language for headings and query states. */
  const { t } = useTranslation();
  /** URL 或全站选择器指定的网络，决定查哪个网络的金库。 Network from the URL or site selector that scopes the vault lookup. */
  const { network } = useNetwork();
  /** 钱包公钥参与读链缓存键，便于切换账户后隔离份额和余额。 Wallet address scopes the read cache so account switches keep positions and balances separate. */
  const { walletAddress } = usePhantomWallet();
  /** 交易确认后用于使金库与各钱包的缓存失效。 Invalidates vault and wallet reads after confirmation. */
  const queryClient = useQueryClient();
  /** 本次页面访问中已确认的最高交易 slot，后续读取不得早于该 slot。 Highest confirmed transaction slot of this page visit, used as a floor for later reads. */
  const minReadSlot = useRef<number | undefined>(undefined);
  /** 用户显式选择的金库地址，未选择时用当前网络列表首项。 Explicitly selected vault address, defaulting to the first registration on this network. */
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  /** 金库列表、查询状态和手动刷新操作。 Vault list, query state, and manual refresh action. */
  const { data, isPending, isError, isFetching, refetch } = useQuery({
    // 每个 Solana 网络有独立缓存，切换后使用对应网络的数据。
    // Cache each Solana network separately so switching uses the selected network's data.
    queryKey: ['vaults', network],
    /**
     * 向后端查询当前网络的金库，允许取消离开页面或切换网络后的旧请求。
     * Fetch vaults for the selected network and allow cancellation after leaving or switching networks.
     *
     * @param context 查询上下文，其中 signal 用于取消这一次请求。 Query context whose signal cancels this request.
     */
    queryFn: ({ signal }) => listVaults({ network }, signal),
  });

  /** 走势图和钱包份额只使用当前网络实际登记的金库。 Resolve the vault for the chart and position from the current network's registrations only. */
  const vaults = data?.items;
  const selectedVault = vaults?.find((vault) => vault.address === selectedAddress) ?? vaults?.[0];

  /** 只从已登记且匹配公开配置的 Devnet 金库读链。 Read only the registered Devnet vault matching the public configuration. */
  const devnetVault = network === 'devnet' ? vaults?.find(isDevnetCashVault) : undefined;
  /** 所选金库支持当前读链时，存赎和钱包份额共用同一个确认态观测。 Deposits, redemptions, and wallet shares use one confirmed observation for the selected supported vault. */
  const isDevnetVaultSelected = devnetVault !== undefined && selectedVault?.address === devnetVault.address;
  /** 接入 Devnet 后，同一次读取提供金库余额、钱包份额与存赎预览。 One Devnet read supplies balances, wallet shares, and transaction previews. */
  const chain = useQuery({
    queryKey: [...devnetVaultQueryKey, devnetVault?.address, walletAddress],
    enabled: devnetVault !== undefined,
    queryFn: ({ signal }) => readDevnetVault(walletAddress, minReadSlot.current, signal),
    refetchInterval: 30_000,
  });

  /**
   * 重查目录，并在支持的金库上直接从 Devnet 更新余额。
   * Refresh the catalog and fetch supported vault balances directly from Devnet.
   */
  function refreshOverview() {
    void refetch();
    if (devnetVault) void chain.refetch();
  }

  /**
   * 在存入或赎回确认后重新读取余额和份额，排除交易之前和仍在途中的读链结果。
   * Refresh balances and shares after confirmation, excluding pre-transaction or in-flight reads.
   *
   * @param slot 存入或赎回交易的确认 slot。 Slot in which the vault transaction confirmed.
   */
  async function refreshAfterTransaction(slot: number) {
    minReadSlot.current = Math.max(minReadSlot.current ?? 0, slot);
    await queryClient.cancelQueries({ queryKey: devnetVaultQueryKey });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: devnetVaultQueryKey }, { throwOnError: true }),
      queryClient.invalidateQueries({ queryKey: ['sol-balance', 'devnet'] }),
    ]);
  }

  return (
    <PageLayout title={t('pages.vault.title')} description={t('pages.vault.description')}>
      <section className="vault-overview" aria-labelledby="vault-overview-title">
        <div className="vault-overview__header">
          <h2 id="vault-overview-title">{t('vaultOverview.title')}</h2>
          <button
            className="vault-overview__refresh"
            type="button"
            onClick={refreshOverview}
            disabled={isFetching || (devnetVault !== undefined && chain.isFetching)}
          >
            {t(isError && !isFetching ? 'vaultOverview.retry' : 'vaultOverview.refresh')}
          </button>
        </div>
        {isPending && <p className="vault-overview__status" role="status">{t('vaultOverview.loading')}</p>}
        {isError && (
          <p className="vault-overview__status vault-overview__status--error" role="alert">
            {t(data?.items.length ? 'vaultOverview.refreshError' : 'vaultOverview.error')}
          </p>
        )}
        {!isError && data?.items.length === 0 && (
          <p className="vault-overview__status" role="status">{t('vaultOverview.empty')}</p>
        )}
        {devnetVault && chain.isPending && (
          <p className="vault-overview__status" role="status">{t('vaultOverview.chainLoading')}</p>
        )}
        {devnetVault && chain.isError && (
          <p className="vault-overview__status vault-overview__status--error" role="alert">
            {t('vaultOverview.chainError')}
          </p>
        )}
        {vaults?.map((vault) => {
          if (vault.address !== devnetVault?.address) return <VaultOverviewCards key={vault.address} vault={vault} />;

          // 新数据优先。读链失败才用已有数据，并明确是上次估算。
          // Prefer the latest chain state. Fall back to known values only on failure, marked as a previous estimate.
          const knownSnapshot = chain.data
            ? toLiveVaultOverview(chain.data, chain.isError)
            : chain.isError && vault.latestSnapshot ? { ...vault.latestSnapshot, freshness: 'STALE' as const } : null;
          if (chain.isPending) return null;
          return <VaultOverviewCards key={vault.address} vault={{ ...vault, latestSnapshot: knownSnapshot }} />;
        })}
      </section>
      {/* 一个页面选择器同时控制下方两个区块，避免图表和钱包份额选到不同金库。 */}
      {/* One page selector drives both sections, keeping the chart and wallet shares on the same vault. */}
      {selectedVault && (
        <label className="vault-selection" title={selectedVault.address}>
          <span>{t('vaultOverview.selectedVault')}</span>
          <select value={selectedVault.address} onChange={(event) => setSelectedAddress(event.currentTarget.value)}>
            {vaults?.map((vault) => (
              <option key={vault.address} value={vault.address}>
                {vault.shareAsset.symbol || t('vaultOverview.vaultFallback')} · {vault.address.slice(0, 6)}…{vault.address.slice(-6)}
              </option>
            ))}
          </select>
        </label>
      )}
      {isDevnetVaultSelected && (
        <VaultDepositSection
          key={'deposit:' + (walletAddress ?? 'disconnected')}
          vault={devnetVault}
          state={chain.data}
          isReadPending={chain.isPending}
          isReadError={chain.isError}
          refreshAfterDeposit={refreshAfterTransaction}
        />
      )}
      <VaultPositionSection
        network={network}
        vault={selectedVault}
        isVaultListPending={isPending}
        isVaultListError={isError}
        livePosition={isDevnetVaultSelected ? {
          snapshot: chain.data ? toLiveVaultPosition(chain.data, chain.isError) : undefined,
          isPending: chain.isPending,
          isError: chain.isError,
          isFetching: chain.isFetching,
          refresh: chain.refetch,
        } : undefined}
      />
      {isDevnetVaultSelected && (
        <VaultRedeemSection
          key={'redeem:' + (walletAddress ?? 'disconnected')}
          vault={devnetVault}
          state={chain.data}
          isReadPending={chain.isPending}
          isReadError={chain.isError}
          refreshAfterDeposit={refreshAfterTransaction}
        />
      )}
      <VaultNavHistorySection network={network} vault={selectedVault} isVaultListPending={isPending} isVaultListError={isError} />
    </PageLayout>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listVaults } from '../../features/vault/api/listVaults';
import { useNetwork } from '../../shared/navigation/network';
import { PageLayout } from '../../shared/ui/PageLayout';
import { VaultNavHistorySection } from './VaultNavHistorySection';
import { VaultOverviewCards } from './VaultOverviewCards';
import { VaultPositionSection } from './VaultPositionSection';
import './styles/vault-page.css';

/**
 * 加载公开金库列表，并让净值走势图和钱包份额使用同一个金库选择。
 * Load the public vault list and share one vault selection between NAV history and wallet shares.
 */
export function VaultPage() {
  /** 页面标题与加载、空列表和出错状态使用当前语言。 Use the current language for headings and query states. */
  const { t } = useTranslation();
  /** URL 或全站选择器指定的网络，决定查哪个网络的金库。 Network from the URL or site selector that scopes the vault lookup. */
  const { network } = useNetwork();
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

  /**
   * 用户点击刷新或重试时，重新请求当前网络的金库列表。
   * Re-fetch the currently selected network when the user refreshes or retries.
   */
  function refreshOverview() {
    void refetch();
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
            disabled={isFetching}
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
        {/* 一条金库记录生成一组卡片，使用金库公钥标识。 */}
        {/* Render one card group per vault entry, keyed by its public address. */}
        {data?.items.map((vault) => (
          <VaultOverviewCards key={vault.address} vault={vault} />
        ))}
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
      <VaultPositionSection network={network} vault={selectedVault} isVaultListPending={isPending} isVaultListError={isError} />
      <VaultNavHistorySection network={network} vault={selectedVault} isVaultListPending={isPending} isVaultListError={isError} />
    </PageLayout>
  );
}

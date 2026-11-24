import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toLiveVaultOverview, toLiveVaultPosition } from '../../features/vault/liveVaultView';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import { VaultNavHistorySection } from './VaultNavHistorySection';
import { VaultOverviewCards } from './VaultOverviewCards';
import { VaultPositionSection } from './VaultPositionSection';
import { VaultRecentActivitySection } from './VaultRecentActivitySection';
import { useVaultRoute } from './VaultRouteLayout';
import './styles/vault-page.css';

/**
 * 策略金库主页。首屏并排展示用户仓位、存赎入口和选中金库的公开数据。
 * Strategy vault overview with wallet holdings and actions beside public metrics for the selected vault.
 */
export function VaultPage() {
  /** 页面标题、状态和操作说明使用当前语言。 Localizes the page title, statuses, and operation instructions. */
  const { t } = useTranslation();
  /** 所选金库、钱包状态与公开查询由金库父路由跨页保留。 The parent route retains selection, wallet state and public queries across screens. */
  const { network, walletAddress, vaults, selectedVault, cashVault, catalog, chain, refreshOverview, selectVault } = useVaultRoute();
  /** 所选金库已经注册时，进入操作页的链接带上明确的网络和金库。 Operation links include the network and vault explicitly once the selection is known. */
  const selection = selectedVault ? new URLSearchParams({ network, vault: selectedVault.address }).toString() : null;
  /** 公开数据优先用当前读链。读链暂时失败时使用上次观测，并标记为上次估算。 Prefer current chain data and label the last observation as an estimate if the read fails. */
  const overviewVault = cashVault ? {
    ...cashVault,
    latestSnapshot: chain.data
      ? toLiveVaultOverview(chain.data, chain.isError)
      : chain.isError && cashVault.latestSnapshot
        ? { ...cashVault.latestSnapshot, freshness: 'STALE' as const }
        : null,
  } : selectedVault;

  /** 已验证的 Devnet 金库在左栏直接展示同一次读链取得的份额。 For the supported Devnet vault, show holdings from the same chain read as the right column. */
  const livePosition = cashVault ? {
    snapshot: chain.data ? toLiveVaultPosition(chain.data, chain.isError) : undefined,
    isPending: chain.isPending,
    isError: chain.isError,
    isFetching: chain.isFetching,
    refresh: chain.refetch,
  } : undefined;
  /** 两个独立操作入口链接到同一个已验证金库。 Both separate operations target the same validated vault. */
  const actions = cashVault && selection && walletAddress ? (
    <div className="vault-workspace__actions">
      <div className="vault-workspace__action">
        <p>{t('vaultFlow.depositDescription')}</p>
        <Link className="vault-workspace__link vault-workspace__link--primary" to={paths.vaultDeposit + '?' + selection}>
          {t('vaultDeposit.title')}
        </Link>
      </div>
      <div className="vault-workspace__action">
        <p>{t('vaultFlow.redeemDescription')}</p>
        <Link className="vault-workspace__link" to={paths.vaultRedeem + '?' + selection}>
          {t('vaultRedeem.title')}
        </Link>
      </div>
    </div>
  ) : undefined;

  return (
    <PageLayout title={t('pages.vault.title')} description={t('pages.vault.description')}>
      <div className="vault-workspace__toolbar">
        {selectedVault && (vaults?.length ?? 0) > 1 && (
          <label className="vault-selection" title={selectedVault.address}>
            <span>{t('vaultOverview.selectedVault')}</span>
            <select value={selectedVault.address} onChange={(event) => selectVault(event.currentTarget.value)}>
              {vaults?.map((vault) => (
                <option key={vault.address} value={vault.address}>
                  {vault.shareAsset.symbol || t('vaultOverview.vaultFallback')} · {vault.address.slice(0, 6)}…{vault.address.slice(-6)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="vault-overview__refresh"
          type="button"
          onClick={refreshOverview}
          disabled={catalog.isFetching || (cashVault !== undefined && chain.isFetching)}
        >
          {t(catalog.isError && !catalog.isFetching ? 'vaultOverview.retry' : 'vaultOverview.refresh')}
        </button>
      </div>

      {catalog.isError && (
        <p className="vault-overview__status vault-overview__status--error" role="alert">
          {t(vaults?.length ? 'vaultOverview.refreshError' : 'vaultOverview.error')}
        </p>
      )}

      <div className="vault-workspace">
        <VaultPositionSection
          network={network}
          vault={selectedVault}
          isVaultListPending={catalog.isPending}
          isVaultListError={catalog.isError}
          livePosition={livePosition}
          actions={actions}
        />
        <aside className="vault-workspace__overview" aria-label={t('vaultOverview.title')}>
          {catalog.isPending && <p className="vault-overview__status" role="status">{t('vaultOverview.loading')}</p>}
          {!catalog.isError && vaults?.length === 0 && (
            <p className="vault-overview__status" role="status">{t('vaultOverview.empty')}</p>
          )}
          {cashVault && chain.isPending && (
            <p className="vault-overview__status" role="status">{t('vaultOverview.chainLoading')}</p>
          )}
          {cashVault && chain.isError && (
            <p className="vault-overview__status vault-overview__status--error" role="alert">{t('vaultOverview.chainError')}</p>
          )}
          {overviewVault && (!cashVault || !chain.isPending) && <VaultOverviewCards vault={overviewVault} />}
        </aside>
      </div>

      <VaultNavHistorySection
        network={network}
        vault={selectedVault}
        isVaultListPending={catalog.isPending}
        isVaultListError={catalog.isError}
      />
      <VaultRecentActivitySection
        network={network}
        vault={selectedVault}
        walletAddress={walletAddress}
        isVaultListPending={catalog.isPending}
        isVaultListError={catalog.isError}
      />
    </PageLayout>
  );
}

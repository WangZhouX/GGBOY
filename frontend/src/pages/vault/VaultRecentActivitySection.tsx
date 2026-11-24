import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ActivityRecords } from '../../features/activity/components/ActivityRecords';
import type { VaultListItem } from '../../features/vault/api/listVaults';
import { useVaultRecentActivity } from '../../features/vault/useVaultRecentActivity';
import type { Network } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import './styles/vault-recent-activity.css';

/** 沿用策略金库页确定的网络、所选金库及连接钱包。 Uses the vault page's network, selected vault and connected wallet. */
interface VaultRecentActivitySectionProps {
  /** 查询记录所属的 Solana 网络。 Solana network containing the requested records. */
  network: Network;
  /** 当前选中的金库，目录尚无可用记录时为 undefined。 Selected vault, or undefined until the catalog provides a registration. */
  vault: VaultListItem | undefined;
  /** 当前连接钱包的公开地址，未连接时为 null。 Public address of the connected wallet, or null when disconnected. */
  walletAddress: string | null;
  /** 金库目录的首次请求是否仍在进行。 Whether the vault catalog's initial request is still pending. */
  isVaultListPending: boolean;
  /** 金库目录的最近一次请求是否失败。 Whether the latest vault catalog request failed. */
  isVaultListError: boolean;
}

/**
 * 展示当前钱包在所选金库的最近存赎和回执，区分已确认但尚未同步与没有交易。
 * Shows the wallet's recent deposits, redemptions and receipts for the selected vault, distinguishing pending indexing from no activity.
 *
 * @param props 查询作用域和金库目录状态。 Query scope and vault catalog status.
 */
export function VaultRecentActivitySection({
  network, vault, walletAddress, isVaultListPending, isVaultListError,
}: VaultRecentActivitySectionProps) {
  /** 标题、操作和查询反馈使用当前界面语言。 Localizes the heading, controls and query feedback. */
  const { t } = useTranslation();
  /** 列表和同步状态随网络、金库和钱包隔离。 Scopes records and indexing status by network, vault and wallet. */
  const activity = useVaultRecentActivity(network, vault?.address, walletAddress);
  /** 已加载的记录在后台刷新失败时仍可供核对。 Loaded records remain available if a background refresh fails. */
  const hasRecords = activity.items.length > 0;
  /** 全站活动页沿用当前网络、所选金库和钱包，仅展示匹配的金库类事件。 Opens the site-wide activity feed scoped to the current network, vault, wallet and vault category. */
  const viewAllPath = vault && walletAddress ? paths.activity + '?' + new URLSearchParams({
    network,
    category: 'vault',
    wallet: walletAddress,
    subjectAddress: vault.address,
  }) : null;

  /** 单条反馈让用户区分目录、钱包、活动接口和索引状态。 A single status distinguishes catalog, wallet, activity API and indexing states. */
  let feedback: string | undefined;
  if (!vault) {
    feedback = isVaultListPending ? 'vaultRecent.loadingVaults' : isVaultListError ? 'vaultRecent.vaultListError' : 'vaultRecent.noVault';
  } else if (!walletAddress) {
    feedback = 'vaultRecent.connectWallet';
  } else if (activity.isError) {
    feedback = hasRecords ? 'vaultRecent.refreshError' : 'vaultRecent.error';
  } else if (activity.isSyncing) {
    feedback = 'vaultRecent.syncing';
  } else if (activity.isDelayed) {
    feedback = 'vaultRecent.delayed';
  } else if (activity.isPending) {
    feedback = 'vaultRecent.loading';
  } else if (!hasRecords) {
    feedback = 'vaultRecent.empty';
  }
  /** 只有可恢复的请求失败使用警示样式。 Only recoverable request failures use the alert presentation. */
  const feedbackIsError = feedback === 'vaultRecent.vaultListError'
    || feedback === 'vaultRecent.error' || feedback === 'vaultRecent.refreshError';

  return (
    <section className="vault-recent-activity" aria-labelledby="vault-recent-activity-title">
      <header className="vault-recent-activity__header">
        <h2 id="vault-recent-activity-title">{t('vaultRecent.title')}</h2>
        {viewAllPath && (
          <div className="vault-recent-activity__actions">
            <Link className="text-link" to={viewAllPath}>{t('vaultRecent.viewAll')}</Link>
            <button
              className="vault-recent-activity__refresh"
              type="button"
              disabled={activity.isFetching}
              onClick={() => void activity.refresh()}
            >
              {t(activity.isError ? 'vaultRecent.retry' : 'vaultRecent.refresh')}
            </button>
          </div>
        )}
      </header>

      {feedback && (
        <p
          className={feedbackIsError ? 'vault-recent-activity__status vault-recent-activity__status--error' : 'vault-recent-activity__status'}
          role={feedbackIsError ? 'alert' : 'status'}
        >
          {t(feedback)}
        </p>
      )}
      {vault && walletAddress && hasRecords && <ActivityRecords items={activity.items} returnToVault={vault.address} compact />}
    </section>
  );
}

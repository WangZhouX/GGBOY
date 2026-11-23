import { skipToken, useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { listVaultSnapshots } from '../../features/vault/api/listVaultSnapshots';
import type { VaultListItem } from '../../features/vault/api/listVaults';
import type { Network } from '../../shared/navigation/network';
import { VaultNavChart } from './VaultNavChart';
import './styles/vault-nav-history.css';

/** 页面共享的金库及列表状态，决定走势图是否可以加载。 Page vault selection and list status that determine when history can load. */
interface VaultNavHistorySectionProps {
  /** 顶栏选择的 Solana 网络。 Solana network selected in the header. */
  network: Network;
  /** 图表所用的金库地址及资产精度，未选中时为 undefined。 Vault address and mint precisions, or undefined before a vault is selected. */
  vault: VaultListItem | undefined;
  /** 公开目录是否仍在首次加载。 Whether the public vault list is loading its first result. */
  isVaultListPending: boolean;
  /** 目录请求是否失败。 Whether the public vault list request failed. */
  isVaultListError: boolean;
}

/**
 * 查询所选金库的公开历史，管理刷新和游标续页，把已加载的快照交给走势图。
 * Fetch public history for the selected vault, manage refresh and cursor paging, and pass loaded snapshots to the chart.
 *
 * @param props 页面所选网络、金库及目录查询状态。 Page network, selected vault, and public list request state.
 */
export function VaultNavHistorySection({ network, vault, isVaultListPending, isVaultListError }: VaultNavHistorySectionProps) {
  /** 标题、操作和失败提示使用当前语言。 Use the current language for headings, actions, and errors. */
  const { t } = useTranslation();
  /** 当前金库状态账户地址，查询只需要金库公钥和网络。 Current vault state account address; the query only needs this public key and network. */
  const address = vault?.address;

  /** TanStack Query 按查询键管理已加载的页和当前请求状态。 TanStack Query tracks loaded pages and in-flight state for the query key. */
  const history = useInfiniteQuery({
    // 分开缓存各金库和网络的历史，切换时同时切换其游标。
    // Cache history per vault and network so each scope uses its own cursors.
    queryKey: ['vault-nav-history', network, address],
    // null 表示首屏没有游标，续页游标是后端返回的字符串。
    // Null means the first page has no cursor; later cursors are strings issued by the backend.
    initialPageParam: null as string | null,
    // 首屏省略 cursor，续页传回服务端游标；用 signal 取消已经离开的金库查询。
    // Omit the first cursor and send back later cursors as issued; cancel queries for a vault the user has left.
    queryFn: address === undefined
      ? skipToken
      : ({ pageParam, signal }) => listVaultSnapshots({ network, address, cursor: pageParam ?? undefined }, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // 查看钱包扩展等操作离开再回到标签页时，避免重复拉取已经展开的整段历史。
    // Avoid re-fetching all expanded history when the tab regains focus, for example after viewing a wallet extension.
    refetchOnWindowFocus: false,
  });

  /** 合并所有已经加载的页，时间排序和折线缺口由图表组件处理。 Combine loaded pages; the chart orders timestamps and draws gaps. */
  const snapshots = history.data?.pages.flatMap((page) => page.items) ?? [];

  /** 从最新一页开始重新查询已加载的历史，更新曲线的最新观测。 Re-fetch loaded history starting with the newest page to retrieve recent observations. */
  function refreshHistory() {
    void history.refetch();
  }

  /** 沿用最后一页的游标读更早的记录，失败后可以继续重试同一页。 Read older records with the last page's cursor and allow retrying that page. */
  function loadOlderHistory() {
    void history.fetchNextPage();
  }

  return (
    <section className="vault-history" aria-labelledby="vault-history-title">
      <header className="vault-history__header">
        <h2 id="vault-history-title">{t('vaultHistory.title')}</h2>
        {vault && (
          <button type="button" className="vault-history__button" onClick={refreshHistory} disabled={history.isFetching}>
            {t(history.isLoadingError ? 'vaultHistory.retry' : 'vaultHistory.refresh')}
          </button>
        )}
      </header>
      {!vault && (
        <p className="vault-history__status" role="status">
          {t(isVaultListError ? 'vaultHistory.vaultListError' : isVaultListPending ? 'vaultHistory.waitingForVaults' : 'vaultHistory.noVault')}
        </p>
      )}
      {vault && history.isPending && <p className="vault-history__status" role="status">{t('vaultHistory.loading')}</p>}
      {vault && history.isError && (
        <p className="vault-history__status vault-history__status--error" role="alert">
          {t(history.isFetchNextPageError ? 'vaultHistory.olderError' : history.isRefetchError ? 'vaultHistory.refreshError' : 'vaultHistory.error')}
        </p>
      )}
      {vault && history.data && snapshots.length === 0 && (
        <p className="vault-history__status" role="status">{t('vaultHistory.empty')}</p>
      )}
      {/* 切换网络或金库时重置正在查看的观测，避免沿用另一个查询的 slot。 */}
      {/* Reset the inspected observation when switching vaults or networks, because slots can repeat across queries. */}
      {vault && snapshots.length > 0 && <VaultNavChart key={`${network}:${vault.address}`} snapshots={snapshots} vault={vault} />}
      {vault && history.hasNextPage && (
        <div className="vault-history__footer">
          <button type="button" className="vault-history__button" onClick={loadOlderHistory} disabled={history.isFetching}>
            {t(history.isFetchingNextPage ? 'vaultHistory.loadingOlder' : history.isFetchNextPageError ? 'vaultHistory.retryOlder' : 'vaultHistory.loadOlder')}
          </button>
        </div>
      )}
    </section>
  );
}

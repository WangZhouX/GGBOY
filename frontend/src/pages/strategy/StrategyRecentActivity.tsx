import { skipToken, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { listActivities } from '../../features/activity/api/listActivities';
import { ActivityRecords } from '../../features/activity/components/ActivityRecords';
import { paths } from '../../shared/navigation/paths';
import { useStrategyRoute } from './StrategyRouteLayout';

/** 单个金库管理页首屏显示的最近事件条数。 Number of recent events shown for one vault. */
const activityLimit = 6;

/**
 * 仅列出所选金库已索引的调仓、出借与收回事件。
 * List only indexed swaps, allocations, and recalls for the selected vault.
 */
export function StrategyRecentActivity() {
  /** 查询与展示共用当前网络和金库，保持所有管理者的公开记录。 Query and display use the current vault and network, including all managers' public events. */
  const { network, selected } = useStrategyRoute();
  const { t } = useTranslation();
  const subjectAddress = selected?.address;
  /** 请求按金库主题和策略分类过滤，避免混入投资人的存赎。 Filter by vault subject and strategy category to exclude investor deposits and redemptions. */
  const query = useQuery({
    queryKey: ['activities', 'strategy', network, subjectAddress],
    queryFn: subjectAddress ? ({ signal }) => listActivities({
      network, category: 'strategy', subjectAddress, limit: activityLimit,
    }, signal) : skipToken,
    refetchInterval: 30_000,
  });
  /** 查看全部和打开单条回执都保留活动分类及金库条件。 Preserve the category and vault when opening the full list or a single receipt. */
  const activitySearch = subjectAddress
    ? new URLSearchParams({ network, category: 'strategy', subjectAddress }).toString()
    : undefined;
  /** 读取失败时保留上次成功读取的记录，并另行显示重试。 Preserve previous records after a failed fetch and expose retry separately. */
  const items = query.data?.items ?? [];

  return (
    <section className="strategy-panel strategy-history" aria-labelledby="strategy-history-title">
      <header className="strategy-panel__header">
        <h2 id="strategy-history-title">{t('strategy.history.title')}</h2>
        {activitySearch && (
          <div className="strategy-controls">
            <Link className="text-link" to={paths.activity + '?' + activitySearch}>{t('strategy.history.all')}</Link>
            <button className="strategy-button" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {t('strategy.refresh')}
            </button>
          </div>
        )}
      </header>
      {!subjectAddress && <p className="strategy-note">{t('strategy.history.noVault')}</p>}
      {subjectAddress && query.isPending && <p className="strategy-note" role="status">{t('strategy.history.loading')}</p>}
      {query.isError && <p className="strategy-note strategy-note--error" role="alert">{t('strategy.history.error')}</p>}
      {query.isSuccess && items.length === 0 && <p className="strategy-note">{t('strategy.history.empty')}</p>}
      {items.length > 0 && <ActivityRecords items={items} activitySearch={activitySearch} compact />}
    </section>
  );
}

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { listActivities, type ActivityCategory } from '../../features/activity/api/listActivities';
import { ActivityRecords } from '../../features/activity/components/ActivityRecords';
import { useNetwork } from '../../shared/navigation/network';
import { PageLayout } from '../../shared/ui/PageLayout';
import { ActivityFiltersForm, activitySearchKeys, invalidActivitySearchField, type ActivitySearchFilters } from './ActivityFiltersForm';
import './styles/activity-page.css';

/** 筛选按钮顺序与原型相同，“全部”对应省略 category。 Prototype category order, with All omitting the category parameter. */
const categories: readonly ('all' | ActivityCategory)[] = ['all', 'vault', 'lending', 'strategy'];

/**
 * 读取已索引活动，管理 URL 筛选、游标分页和回执入口。
 * Read indexed activity and manage URL filters, cursor pagination, and receipt navigation.
 */
export function ActivityPage() {
  /** 页面文案使用当前语言，活动可公开读取。 Page copy follows the active language. Activity is public. */
  const { t } = useTranslation();
  /** 站点统一选择的网络以及列表的 URL 查询状态。 Shared network selection and URL-backed activity filters. */
  const { network } = useNetwork();
  const [search, setSearch] = useSearchParams();
  /** 刷新首屏时用于丢弃已有页及它们的旧游标。 Used to discard accumulated pages and old cursors when refreshing the first page. */
  const queryClient = useQueryClient();
  /** 没有有效查询分类时，默认展示所有业务。 Default to all events without a recognized query category. */
  const category = categories.find((entry) => entry === search.get('category')) ?? 'all';
  /** 分享链接和筛选表单均使用相同的三个精确查询参数。 Shared links and the search form use the same three exact-match parameters. */
  const filters: ActivitySearchFilters = {
    wallet: search.get('wallet')?.trim() ?? '',
    subjectAddress: search.get('subjectAddress')?.trim() ?? '',
    signature: search.get('signature')?.trim() ?? '',
  };
  /** 输入非法的分享链接时允许修正查询条件，暂缓网络请求。 Invalid shared links can be corrected before a network request is made. */
  const invalidFilter = invalidActivitySearchField(filters);
  /** 每个网络和筛选组合具有独立缓存，游标仅在其所属序列中使用。 Each network and filter combination owns its cursor sequence and cache. */
  const queryKey = ['activities', network, category, filters.wallet, filters.subjectAddress, filters.signature] as const;
  /** TanStack Query 保存已加载页，下一页带回服务端生成的游标。 TanStack Query stores loaded pages and passes the server cursor to the next request. */
  const activityQuery = useInfiniteQuery({
    queryKey,
    enabled: invalidFilter === undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listActivities({
      network,
      category: category === 'all' ? undefined : category,
      wallet: filters.wallet || undefined,
      subjectAddress: filters.subjectAddress || undefined,
      signature: filters.signature || undefined,
      cursor: pageParam,
    }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  /** 结果按接口顺序拼接，事件身份由网络、签名和序号组成。 Concatenate server pages in order, with network, signature, and event index identifying each event. */
  const items = activityQuery.data?.pages.flatMap((page) => page.items) ?? [];
  /** 相同 URL 可保留搜索表单草稿，提交新值或切换网络时同步表单。 Keep drafts with an unchanged URL and reset the form on applied filters or network changes. */
  const formKey = JSON.stringify([network, filters]);

  /**
   * 把分类写入 URL，保留其他已提交条件。
   * Write the category into the URL while retaining other submitted filters.
   *
   * @param next 选择的活动类别。 Selected activity category.
   */
  function selectCategory(next: (typeof categories)[number]) {
    if (next === category) return;

    /** 一次 URL 更新保留网络和非分类筛选。 Preserve the network and exact-match filters in one URL update. */
    const nextSearch = new URLSearchParams(search);
    nextSearch.set('network', network);
    nextSearch.delete('cursor');
    if (next === 'all') nextSearch.delete('category');
    else nextSearch.set('category', next);
    setSearch(nextSearch);
  }

  /**
   * 提交筛选条件后通过新的查询键加载首屏。
   * Load the first page under a new query key after applying search filters.
   *
   * @param next 钱包、业务账户和签名的精确匹配条件。 Exact-match wallet, subject, and signature filters.
   */
  function applyFilters(next: ActivitySearchFilters) {
    /** 保留当前网络和业务分类，只更新表单字段。 Keep the current network and category and update only form fields. */
    const nextSearch = new URLSearchParams(search);
    nextSearch.set('network', network);
    nextSearch.delete('cursor');
    for (const key of activitySearchKeys) {
      if (next[key]) nextSearch.set(key, next[key]);
      else nextSearch.delete(key);
    }
    setSearch(nextSearch);
  }

  /** 重查首屏，避免异步索引补写后继续沿用旧游标。 Refresh from the first page so backfilled events cannot be skipped by obsolete cursors. */
  function refreshActivity() {
    void queryClient.resetQueries({ queryKey, exact: true });
  }

  return (
    <PageLayout title={t('pages.activity.title')} description={t('pages.activity.description')}>
      <section className="activity-feed" aria-labelledby="activity-list-title">
        <header className="activity-feed__heading">
          <h2 id="activity-list-title">{t('activity.title')}</h2>
          <button className="activity-button" type="button" disabled={activityQuery.isFetching || invalidFilter !== undefined} onClick={refreshActivity}>
            {t('activity.refresh')}
          </button>
        </header>

        <div className="activity-categories" role="group" aria-label={t('activity.categoryLabel')}>
          {categories.map((entry) => (
            <button key={entry} type="button" aria-pressed={entry === category} onClick={() => selectCategory(entry)}>
              {t('activity.categories.' + entry)}
            </button>
          ))}
        </div>
        <ActivityFiltersForm key={formKey} filters={filters} applyFilters={applyFilters} />

        {!invalidFilter && activityQuery.isPending && (
          <p className="activity-feedback" role="status">{t('activity.loading')}</p>
        )}
        {activityQuery.isError && (
          <p className="activity-feedback activity-feedback--error" role="alert">
            {t(activityQuery.isFetchNextPageError ? 'activity.olderError' : 'activity.error')}
          </p>
        )}
        {activityQuery.isSuccess && items.length === 0 && (
          <p className="activity-feedback" role="status">{t('activity.empty')}</p>
        )}
        {items.length > 0 && <ActivityRecords items={items} activitySearch={search.toString()} />}
        {activityQuery.hasNextPage && (
          <div className="activity-feed__pagination">
            <button className="activity-button" type="button" disabled={activityQuery.isFetching} onClick={() => { void activityQuery.fetchNextPage(); }}>
              {t(activityQuery.isFetchingNextPage ? 'activity.loadingOlder' : activityQuery.isFetchNextPageError ? 'activity.retryOlder' : 'activity.loadOlder')}
            </button>
          </div>
        )}
      </section>
    </PageLayout>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { listActivities } from '../../features/activity/api/listActivities';
import { ActivityRecords } from '../../features/activity/components/ActivityRecords';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { paths } from '../../shared/navigation/paths';

/** 清算市场首页最近已索引事件的展示上限。 Maximum number of recent indexed events on the liquidation market page. */
const activityLimit = 6;

/**
 * 列出当前市场已索引的清算交易，使用活动模块的回执入口。
 * List indexed liquidation transactions for the current market using the activity module's receipt links.
 *
 * @param props 所选市场决定网络和活动业务地址。 Selected market providing the network and activity subject address.
 */
export function LendingLiquidationActivity({ market }: { market: LendingMarketListItem }) {
  const { t } = useTranslation();
  const { network, address: subjectAddress } = market;
  /** 清算交易最终确认后失效活动缓存。索引异步补齐，前台每 30 秒再读取。 Invalidate activity on liquidation finalization. Check every 30 seconds in the foreground while indexing catches up. */
  const recent = useQuery({
    queryKey: ['activities', network, 'recent-liquidations', subjectAddress],
    queryFn: ({ signal }) => listActivities({
      network, category: 'lending', subjectAddress, types: ['LENDING_LIQUIDATION'], limit: activityLimit,
    }, signal),
    refetchInterval: 30_000,
  });
  /** 全部借贷活动入口保留同一个网络和市场。 Full lending activity link retains the same network and market. */
  const activitySearch = new URLSearchParams({ network, category: 'lending', subjectAddress }).toString();
  const items = recent.data?.items ?? [];

  return (
    <section className="liquidations__panel" aria-labelledby="liquidations-activity-title">
      <header className="liquidations__heading">
        <h2 id="liquidations-activity-title">{t('lendingLiquidations.recent')}</h2>
        <div className="liquidations__actions">
          <Link className="text-link" to={paths.activity + '?' + activitySearch}>{t('lendingLiquidations.allActivity')}</Link>
          <button className="liquidations__button" type="button" disabled={recent.isFetching} onClick={() => void recent.refetch()}>
            {t('lendingLiquidations.refreshActivity')}
          </button>
        </div>
      </header>
      {recent.isPending && <p className="liquidations__notice" role="status">{t('lendingLiquidations.activityLoading')}</p>}
      {recent.isError && (
        <p className="liquidations__notice liquidations__notice--error" role="alert">{t('lendingLiquidations.activityError')}</p>
      )}
      {recent.isSuccess && !items.length && <p className="liquidations__notice">{t('lendingLiquidations.activityEmpty')}</p>}
      {items.length > 0 && <ActivityRecords items={items} activitySearch={activitySearch} />}
    </section>
  );
}

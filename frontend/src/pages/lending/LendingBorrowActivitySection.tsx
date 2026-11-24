import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { devnetBorrowActivityQueryKey, readDevnetBorrowActivity, type DevnetBorrowActivity } from '../../solana/lending/readBorrowActivity';
import { formatPositionAmount } from './positionValues';
import './styles/lending-borrow-activity.css';

/** 当前所选市场、钱包和确认后的读取下限。 Selected market, wallet, and optional post-confirmation slot floor. */
interface LendingBorrowActivitySectionProps {
  /** 从市场目录确认的 Devnet 部署和两个资产的精度。 Registered Devnet deployment and its two asset precisions. */
  market: LendingMarketListItem;
  /** Phantom 当前连接的钱包公钥。 Public key of the wallet currently connected through Phantom. */
  walletAddress: string;
  /** 最近一次借款操作已确认的 slot，下次读取必须至少达到此处。 Finalized slot of the latest borrowing action; the next read must reach this slot. */
  minContextSlot?: number;
}

/** 与链上借款事件编号一一对应的国际化名称。 Localized names indexed by the on-chain borrowing event code. */
const actionLabels = ['depositCollateral', 'borrow', 'repay', 'withdrawCollateral'] as const;

/**
 * 展示所选钱包在这个市场最近已最终确认的借款活动。
 * Show recently finalized borrow actions for the selected wallet in this market.
 *
 * @param props 用于读取活动的 Devnet 市场、钱包及可选确认 slot。 Devnet market, wallet, and optional finalized slot used to load activity.
 */
export function LendingBorrowActivitySection({ market, walletAddress, minContextSlot }: LendingBorrowActivitySectionProps) {
  /** 文案、金额分组和日期采用当前界面语言。 Use the interface language for copy, number grouping, and date formatting. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  /** 普通页面切换短时复用数据；交易确认时由交易流程标记待刷新。 Reuse recent reads across routine navigation; transaction finalization invalidates this query. */
  const queryClient = useQueryClient();
  const queryKey = devnetBorrowActivityQueryKey(market.address, walletAddress);
  const activity = useQuery({
    queryKey,
    queryFn: ({ signal }) => readDevnetBorrowActivity(
      market, walletAddress, minContextSlot, signal, queryClient.getQueryData<DevnetBorrowActivity>(queryKey),
    ),
    staleTime: 30_000,
    retry: false,
  });

  /** 重试失败保留现有记录，并与确实没有查到记录的状态区分。 Keep previously loaded records after an error and distinguish failure from an empty result. */
  const items = activity.data?.items ?? [];
  const feedback = activity.isPending ? 'loading'
    : activity.isError ? items.length ? 'refreshError' : 'error'
    : activity.data?.partial ? 'partial'
    : items.length ? undefined : 'empty';

  return (
    <section className="lending-position__section lending-borrow-activity" aria-labelledby="lending-borrow-activity-title">
      <header className="lending-position__header">
        <h2 id="lending-borrow-activity-title">{t('lendingBorrowActivity.title')}</h2>
        <button className="lending-position__button" type="button" disabled={activity.isFetching} onClick={() => void activity.refetch()}>
          {t(activity.isError || activity.data?.partial ? 'lendingBorrowActivity.retry' : 'lendingBorrowActivity.refresh')}
        </button>
      </header>

      {feedback && (
        <p className={activity.isError ? 'lending-position__note lending-position__note--error' : 'lending-position__note'}
          role={activity.isError ? 'alert' : 'status'}>
          {t('lendingBorrowActivity.' + feedback)}
        </p>
      )}

      {items.length > 0 && (
        <ul className="lending-borrow-activity__items">
          {items.map((item) => {
            // 存入与取回按抵押 Mint 显示，借款与还款按借款 Mint 显示。
            // Use the collateral mint for deposits and withdrawals, and the debt mint for borrows and repayments.
            const asset = item.kind === 0 || item.kind === 3 ? market.collateralAsset : market.debtAsset;
            const action = t('lendingBorrowActivity.' + actionLabels[item.kind]);
            const amount = formatPositionAmount(item.amountRaw.toString(), asset, locale);
            /** 链上 Unix 时间以秒计，Date 接收毫秒。 Chain timestamps are in Unix seconds, while Date expects milliseconds. */
            const timestamp = item.blockTime === null ? null : new Date(item.blockTime * 1000);
            const date = timestamp && Number.isFinite(timestamp.valueOf()) ? timestamp : null;
            return (
              <li key={item.signature + ':' + item.index}>
                <span className="lending-borrow-activity__action">{action}</span>
                <span className="lending-borrow-activity__amount">{amount}</span>
                {date
                  ? <time dateTime={date.toISOString()}>{dateFormatter.format(date)}</time>
                  : <span className="lending-borrow-activity__time">{t('lendingBorrowActivity.timeUnavailable')}</span>}
                <a className="text-link" href={'https://explorer.solana.com/tx/' + encodeURIComponent(item.signature) + '?cluster=devnet'}
                  target="_blank" rel="noreferrer" aria-label={t('lendingBorrowActivity.receiptLabel', { action, amount })}>
                  {t('lendingBorrowActivity.receipt')}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

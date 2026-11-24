import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';
import type { ActivityItem } from '../api/listActivities';
import {
  formatActivityAmount,
  formatActivityTime,
  getActivityAssetLabel,
  getActivityLegTranslationKey,
  getActivityTypeTranslationKey,
  shortenActivityAddress,
} from '../activityDisplay';
import { isActivityPublicKey } from '../activityIdentifiers';
import { withNetwork } from '../../../shared/navigation/network';
import { paths } from '../../../shared/navigation/paths';
import './styles/activity-records.css';

/** 活动结果和返回来源页面的条件。 Activity results and the context needed to return to the originating page. */
interface ActivityRecordsProps {
  /** 来自共享查询接口的事件，每个事件保有完整参与方和变动。 Shared API events containing full participants and movements. */
  items: readonly ActivityItem[];
  /** 可选的主列表 URL 查询条件。 Optional query string from the main activity list. */
  activitySearch?: string;
  /** 打开回执后返回的所选金库 Base58 公钥。 Base58 public key of the selected vault to return to from a receipt. */
  returnToVault?: string;
  /** 业务页已限定钱包和分类时省略重复的列和值。 Hide redundant details when the owning page already scopes the wallet and category. */
  compact?: boolean;
}

/**
 * 展示可用于业务页的交易事件表格和回执链接。
 * Render a transaction event table with receipt links for activity and other business pages.
 *
 * @param props 事件、回执返回条件和是否使用精简表格。 Events, receipt return context, and optional compact rendering.
 */
export function ActivityRecords({ items, activitySearch, returnToVault, compact = false }: ActivityRecordsProps) {
  /** 列标题、代码名称和日期使用当前界面语言。 Use the selected UI language for columns, code labels, and dates. */
  const { t, i18n } = useTranslation();
  /** 时间和金额跟随站点当前语言。 Time and amount formatting follows the site's active language. */
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 金库公钥有效才保存来源；全站列表继续携带自己的筛选条件。 Keep a validated vault origin, or retain the global activity filters. */
  const receiptState = returnToVault && isActivityPublicKey(returnToVault)
    ? { returnToVault }
    : activitySearch !== undefined ? { activitySearch } : undefined;

  return (
    <div className={compact ? 'activity-records activity-records--compact' : 'activity-records'} role="region" aria-label={t('activity.recordsTable')} tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('activity.table.operation')}</th>
            <th scope="col">{t('activity.table.assets')}</th>
            {!compact && <th scope="col">{t('activity.table.participants')}</th>}
            <th scope="col">{t('activity.table.time')}</th>
            <th scope="col">{t('activity.table.receipt')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            /** 已加载的事件实际带回执身份和源网络。 Each loaded event provides its receipt identity and network. */
            const receiptPath = withNetwork(generatePath(paths.activityReceipt, {
              signature: item.signature,
              eventIndex: item.eventIndex.toString(),
            }), item.network);
            /** 区块时间缺失时保留空值。 Preserve missing block timestamps. */
            const time = formatActivityTime(item.blockTime, locale);
            /** 策略事件来自金库程序，列表按其业务分类显示。 The vault program emits strategy events, which show their business category in the list. */
            const businessGroup = item.module === 'VAULT' && item.type.startsWith('STRATEGY_') ? 'STRATEGY' : item.module;
            return (
              <tr key={item.network + ':' + item.signature + ':' + item.eventIndex}>
                <th scope="row">
                  <span className="activity-records__operation">
                    {t(getActivityTypeTranslationKey(item.type), { defaultValue: item.type })}
                  </span>
                  {!compact && (
                    <span className="activity-records__secondary">
                      {t('activity.modules.' + businessGroup, { defaultValue: businessGroup })}
                    </span>
                  )}
                </th>
                <td>
                  {item.assets.length > 0 ? (
                    <ul>
                      {item.assets.map((asset) => (
                        <li key={asset.legIndex}>
                          <span>{t(getActivityLegTranslationKey(item.type, asset.legType), { defaultValue: asset.legType })}</span>
                          {' '}
                          <strong title={asset.mint}>
                            {formatActivityAmount(asset, locale)} {getActivityAssetLabel(asset, item.network)}
                          </strong>
                        </li>
                      ))}
                    </ul>
                  ) : t('activity.table.unavailable')}
                </td>
                {!compact && (
                  <td>
                    {item.participants.length > 0 ? (
                      <ul>
                        {item.participants.map((participant) => (
                          <li key={participant.walletAddress + ':' + participant.role}>
                            <span>{t('activity.roles.' + participant.role, { defaultValue: participant.role })}</span>
                            {' '}
                            <span className="activity-records__address" title={participant.walletAddress}>
                              {shortenActivityAddress(participant.walletAddress)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : t('activity.table.unavailable')}
                  </td>
                )}
                <td>{time && item.blockTime ? <time dateTime={item.blockTime}>{time}</time> : t('activity.table.unavailableTime')}</td>
                <td>
                  <Link className="text-link" to={receiptPath} state={receiptState}>
                    {t('activity.viewReceipt')}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

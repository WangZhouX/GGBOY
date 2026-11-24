import { skipToken, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import {
  formatActivityAmount,
  formatActivityTime,
  getActivityAssetLabel,
  getActivityLegTranslationKey,
  getActivityTypeTranslationKey,
} from '../../features/activity/activityDisplay';
import { isActivityEventIndex, isActivityPublicKey, isActivitySignature } from '../../features/activity/activityIdentifiers';
import { getActivityReceipt } from '../../features/activity/api/getActivityReceipt';
import type { ActivityItem } from '../../features/activity/api/listActivities';
import { ApiError } from '../../shared/api/client';
import { type Network, useNetwork } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import './styles/activity-receipt.css';

/**
 * 恢复活动列表的筛选条件，且始终返回站内列表。
 * Restore the activity list filters and always return to the in-app list.
 *
 * @param state 打开回执时携带的路由状态。 Router state supplied when opening the receipt.
 * @param network 当前回执对应的网络。 Network selected on the receipt.
 * @returns 带有网络和可恢复筛选条件的活动列表链接。 List link with the network and available filters.
 */
function listLocation(state: unknown, network: Network): string {
  /** 仅从路由状态读取查询串，列表路径使用常量。 Read only a search string from state and use a fixed in-app path. */
  const listSearch = typeof state === 'object' && state !== null &&
    'activitySearch' in state && typeof state.activitySearch === 'string' ? state.activitySearch : '';

  /** 回执可以切换网络，返回时保留筛选但丢弃绑定旧范围的游标。 Preserve filters when returning, while discarding any cursor tied to the previous scope. */
  const params = new URLSearchParams(listSearch);
  params.set('network', network);
  params.delete('cursor');
  return paths.activity + '?' + params.toString();
}

/**
 * 仅用有效的交易来源公钥构建返回策略金库的站内链接。
 * Build an in-app vault return link only from a valid vault key in the receipt origin.
 *
 * @param state 打开回执时携带的路由状态。 Router state supplied when opening the receipt.
 * @param network 当前回执对应的网络。 Network selected on the receipt.
 * @returns 保留金库选择的页面链接，或无有效来源时返回 undefined。 Vault page link preserving selection, or undefined without a valid origin.
 */
function vaultLocation(state: unknown, network: Network): string | undefined {
  if (typeof state !== 'object' || state === null || !('returnToVault' in state)
    || typeof state.returnToVault !== 'string' || !isActivityPublicKey(state.returnToVault)) {
    return undefined;
  }

  return paths.vault + '?' + new URLSearchParams({ network, vault: state.returnToVault }).toString();
}

/**
 * 展示一条已入库事件的标识、参与方和所有实际资产变动。
 * Show identifiers, participants, and all actual asset movements for an indexed event.
 *
 * @param props.receipt 后端返回的完整交易事件和元数据。 Full transaction event and metadata returned by the backend.
 */
function ReceiptDetails({ receipt }: { receipt: ActivityItem }) {
  /** 时间、金额和业务名称按当前界面语言展示。 Format the time, amounts, and business names using the current UI language. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  /** 后端区块时间用 UTC 表示，缺失时单独提示。 Display the backend block timestamp in UTC and handle missing values explicitly. */
  const blockTimeText = formatActivityTime(receipt.blockTime, locale);

  return (
    <div className="receipt-details">
      <section className="receipt-section" aria-labelledby="receipt-details-title">
        <h2 id="receipt-details-title">{t('receipt.heading')}</h2>
        <dl className="receipt-identifiers">
          <dt>{t('receipt.operation')}</dt>
          <dd>{t(getActivityTypeTranslationKey(receipt.type), { defaultValue: receipt.type })}</dd>
          <dt>{t('receipt.module')}</dt>
          <dd>{t('activity.modules.' + receipt.module, { defaultValue: receipt.module })}</dd>
          <dt>{t('layout.network')}</dt>
          <dd>{t('network.' + receipt.network)}</dd>
          <dt>{t('receipt.signature')}</dt>
          <dd><code className="receipt-address">{receipt.signature}</code></dd>
          <dt>{t('receipt.eventIndex')}</dt>
          <dd>{receipt.eventIndex}</dd>
          <dt>{t('receipt.blockTime')}</dt>
          <dd>
            {blockTimeText !== null && receipt.blockTime !== null
              ? <time dateTime={receipt.blockTime}>{blockTimeText}</time>
              : t('receipt.unavailableTime')}
          </dd>
          <dt>{t('receipt.slot')}</dt>
          <dd>{receipt.slot}</dd>
          <dt>{t('receipt.program')}</dt>
          <dd><code className="receipt-address">{receipt.programId}</code></dd>
          <dt>{t('receipt.subject')}</dt>
          <dd><code className="receipt-address">{receipt.subjectAddress}</code></dd>
        </dl>
      </section>

      <section className="receipt-section" aria-labelledby="receipt-participants-title">
        <h2 id="receipt-participants-title">{t('receipt.participants')}</h2>
        {receipt.participants.length === 0 ? (
          <p className="receipt-section__empty">{t('receipt.emptyParticipants')}</p>
        ) : (
          <ul className="receipt-entries">
            {receipt.participants.map((participant) => (
              <li key={participant.walletAddress + ':' + participant.role}>
                <dl className="receipt-identifiers">
                  <dt>{t('receipt.role')}</dt>
                  <dd>{t('activity.roles.' + participant.role, { defaultValue: participant.role })}</dd>
                  <dt>{t('receipt.wallet')}</dt>
                  <dd><code className="receipt-address">{participant.walletAddress}</code></dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="receipt-section" aria-labelledby="receipt-assets-title">
        <h2 id="receipt-assets-title">{t('receipt.assets')}</h2>
        {receipt.assets.length === 0 ? (
          <p className="receipt-section__empty">{t('receipt.emptyAssets')}</p>
        ) : (
          <ul className="receipt-entries">
            {receipt.assets.map((asset) => (
              <li key={asset.legIndex}>
                <dl className="receipt-identifiers">
                  <dt>{t('receipt.legType')}</dt>
                  <dd>{t(getActivityLegTranslationKey(receipt.type, asset.legType), { defaultValue: asset.legType })}</dd>
                  <dt>{t('receipt.amount')}</dt>
                  <dd className="receipt-amount">
                    {formatActivityAmount(asset, locale)} {getActivityAssetLabel(asset, receipt.network)}
                  </dd>
                  <dt>{t('receipt.mint')}</dt>
                  <dd><code className="receipt-address">{asset.mint}</code></dd>
                  <dt>{t('receipt.decimals')}</dt>
                  <dd>{asset.decimals}</dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * 根据网络、交易签名和事件序号查询回执，并恢复活动筛选或金库选择。
 * Fetch the receipt by network, transaction signature, and event index, preserving list filters or the selected vault on return.
 */
export function ActivityReceiptPage() {
  /** 页面状态、业务标题和字段标签使用当前界面语言。 Use the UI language for status, headings and labels. */
  const { t } = useTranslation();
  /** 从回执 URL 读取 Base58 签名、十进制事件序号和可选显式网络。 Read the Base58 signature, decimal index, and optional explicit network from the receipt URL. */
  const { signature, eventIndex } = useParams<'signature' | 'eventIndex'>();
  const [searchParams] = useSearchParams();
  const { network } = useNetwork();
  const explicitNetwork = searchParams.get('network');

  /** 路由状态可能保存金库来源或活动列表筛选。 Router state may carry the originating vault or the activity list filters. */
  const location = useLocation();
  /** 无有效金库来源时回到活动列表。 Return to the activity list when there is no valid vault origin. */
  const returnToVault = vaultLocation(location.state, network);

  /** 先校验字符格式再转成数字，避免空值、负数或指数形式误入请求。 Validate decimal syntax before conversion so blanks, negative numbers and exponent notation cannot reach the request. */
  const parsedIndex = eventIndex !== undefined && /^[0-9]{1,10}$/.test(eventIndex) ? Number(eventIndex) : undefined;
  /** 非法显式网络、签名或序号不发起请求。 Suppress requests for an invalid explicit network, signature, or index. */
  const request = (explicitNetwork === null || explicitNetwork === network) &&
    signature !== undefined && isActivitySignature(signature) && isActivityEventIndex(parsedIndex)
    ? { network, signature, eventIndex: parsedIndex }
    : undefined;

  /** 交易中的多条事件分别缓存，不混用不同网络或事件序号的结果。 Cache each event independently across networks, transaction signatures and event indices. */
  const receiptQuery = useQuery({
    queryKey: ['activity-receipt', network, signature, parsedIndex],
    queryFn: request
      ? ({ signal }) => getActivityReceipt(request, signal)
      : skipToken,
  });

  /** 查不到事件与查询失败分开反馈。 Distinguish missing events from query failures. */
  const errorStatus = receiptQuery.error instanceof ApiError ? receiptQuery.error.status : undefined;
  const invalid = request === undefined || errorStatus === 400;
  const missing = errorStatus === 404;

  return (
    <PageLayout title={t('pages.receipt.title')} description={t('pages.receipt.description')}>
      {invalid ? (
        <p className="receipt-status receipt-status--error" role="alert">{t('receipt.invalid')}</p>
      ) : receiptQuery.data ? (
        <ReceiptDetails receipt={receiptQuery.data} />
      ) : receiptQuery.isPending ? (
        <p className="receipt-status" role="status">{t('receipt.loading')}</p>
      ) : (
        <div className={missing ? 'receipt-status' : 'receipt-status receipt-status--error'}>
          <p role={missing ? 'status' : 'alert'}>{t(missing ? 'receipt.notFound' : 'receipt.error')}</p>
          <button
            className="receipt-retry"
            type="button"
            disabled={receiptQuery.isFetching}
            onClick={() => void receiptQuery.refetch()}
          >
            {t('receipt.retry')}
          </button>
        </div>
      )}

      <nav className="receipt-links" aria-label={t('pages.receipt.title')}>
        <Link className="text-link" to={returnToVault ?? listLocation(location.state, network)}>
          {t(returnToVault ? 'vaultRecent.back' : 'receipt.back')}
        </Link>
        {request?.network === 'devnet' && !invalid && (
          <a
            className="text-link"
            href={'https://explorer.solana.com/tx/' + encodeURIComponent(request.signature) + '?cluster=devnet'}
            target="_blank"
            rel="noreferrer"
          >
            {t('receipt.explorer')}
          </a>
        )}
      </nav>
    </PageLayout>
  );
}

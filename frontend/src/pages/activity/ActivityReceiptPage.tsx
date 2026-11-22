import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useNetwork, withNetwork } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import './activity-receipt.css';

/**
 * 展示直接打开回执链接时得到的网络、签名和事件序号。
 * Show the network, signature, and event index read from a directly opened receipt link.
 */
export function ActivityReceiptPage() {
  /** 页面字段标签跟随当前语言。 Keep receipt labels in the selected language. */
  const { t } = useTranslation();
  /** 来自路由的交易签名和事件序号文本。 Signature and event index text from the route. */
  const { signature, eventIndex } = useParams<'signature' | 'eventIndex'>();
  /** 来自查询参数或站点偏好的网络。 Network read from the URL query or site preference. */
  const { network } = useNetwork();

  return (
    <PageLayout title={t('pages.receipt.title')} description={t('pages.receipt.description')}>
      <dl className="receipt-identifiers">
        <dt>{t('layout.network')}</dt>
        <dd>{t('network.' + network)}</dd>
        <dt>{t('receipt.signature')}</dt>
        <dd className="receipt-signature">{signature}</dd>
        <dt>{t('receipt.eventIndex')}</dt>
        <dd>{eventIndex}</dd>
      </dl>
      <Link className="text-link" to={withNetwork(paths.activity, network)}>
        {t('receipt.back')}
      </Link>
    </PageLayout>
  );
}

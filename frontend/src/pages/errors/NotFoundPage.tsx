import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useNetwork, withNetwork } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';

/**
 * 显示无法匹配的地址，并提供返回总览的链接。
 * Show an unmatched URL with a link back to the overview.
 */
export function NotFoundPage() {
  /** 本地化页面说明和返回动作。 Localize the page description and return link. */
  const { t } = useTranslation();
  /** 返回总览时延续原网络。 Keep the same network when returning to the overview. */
  const { network } = useNetwork();

  return (
    <PageLayout title={t('pages.notFound.title')} description={t('pages.notFound.description')}>
      <Link className="text-link" to={withNetwork(paths.overview, network)}>
        {t('actions.backToOverview')}
      </Link>
    </PageLayout>
  );
}

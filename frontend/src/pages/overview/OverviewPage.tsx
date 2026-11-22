import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useNetwork, withNetwork } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import './overview.css';

/** 总览提供的四个业务入口。 Four business destinations shown on the overview. */
const destinations = ['vault', 'lending', 'strategy', 'activity'] as const;

/**
 * 资产总览的导航入口，便于从应用首页进入各项业务。
 * Entry page that opens each business area from the portfolio overview.
 */
export function OverviewPage() {
  /** 为入口的标题和说明读取当前语言。 Translate the destination titles and descriptions. */
  const { t } = useTranslation();
  /** 业务入口链接继承当前网络。 Business links carry the current network. */
  const { network } = useNetwork();

  return (
    <PageLayout title={t('pages.overview.title')} description={t('pages.overview.description')}>
      <nav className="module-grid" aria-label={t('overview.section')}>
        {destinations.map((destination) => (
          <Link className="module-link" key={destination} to={withNetwork(paths[destination], network)}>
            <div>
              <h2>{t('pages.' + destination + '.title')}</h2>
              <p>{t('overview.' + destination)}</p>
            </div>
            <span className="module-arrow" aria-hidden="true">↗</span>
          </Link>
        ))}
      </nav>
    </PageLayout>
  );
}

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useNetwork, withNetwork } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import { DevnetWalletBalance } from './DevnetWalletBalance';
import './styles/overview.css';

/** 总览提供的四个业务入口。 Four business destinations shown on the overview. */
const destinations = ['vault', 'lending', 'strategy', 'activity'] as const;

/**
 * 展示钱包的 Devnet SOL 余额和各业务入口。
 * Show the wallet's Devnet SOL balance and links to each business area.
 */
export function OverviewPage() {
  /** 为入口的标题和说明读取当前语言。 Translate the destination titles and descriptions. */
  const { t } = useTranslation();
  /** 钱包余额区和业务入口使用站点当前网络。 The wallet balance section and business links use the selected site network. */
  const { network } = useNetwork();

  return (
    <PageLayout title={t('pages.overview.title')} description={t('pages.overview.description')}>
      <DevnetWalletBalance network={network} />
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

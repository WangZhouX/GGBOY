import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { useNetwork, withNetwork } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import './lending-navigation.css';

/** 借贷市场及三项独立子页的导航顺序。 Navigation order for the lending market and three nested pages. */
const lendingPages = ['lending', 'borrow', 'supply', 'liquidations'] as const;

/**
 * 为市场概况、借款、出借和清算页面提供共用子导航。
 * Render the navigation shared by the market overview, borrowing, supplying, and liquidation pages.
 */
export function LendingNavigation() {
  /** 本地化借贷子导航标题。 Localize the lending navigation labels. */
  const { t } = useTranslation();
  /** 切换页面时保持同一网络。 Keep the same network when changing pages. */
  const { network } = useNetwork();

  return (
    <nav className="sub-nav" aria-label={t('lending.navigation')}>
      {lendingPages.map((item) => (
        <NavLink className="nav-link" key={item} end to={withNetwork(paths[item], network)}>
          {t(item === 'lending' ? 'lending.overview' : 'pages.' + item + '.title')}
        </NavLink>
      ))}
    </nav>
  );
}

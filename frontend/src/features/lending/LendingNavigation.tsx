import { useTranslation } from 'react-i18next';
import { NavLink, useSearchParams } from 'react-router';
import { type Network, useNetwork } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import './lending-navigation.css';

/** 借贷市场及三项独立子页的导航顺序。 Navigation order for the lending market and three nested pages. */
const lendingPages = ['lending', 'borrow', 'supply', 'liquidations'] as const;

/** 市场概况完成目录加载后，可把已核对的选择传给子导航。 Once verified by the registry, the market overview can supply that selection to the navigation. */
interface LendingNavigationProps {
  /** 当前网络中所选市场的公钥；子页从自身 URL 读取，目录未选中时传 null。 Selected market on the current network; nested pages read their URL, while a missing selection is null. */
  marketAddress?: string | null;
}

/**
 * 为借贷链接保留网络和可选的市场公钥。
 * Preserve the network and optional market public key in lending links.
 *
 * @param path 借贷子页面的站内路径。 In-app path of a lending page.
 * @param network 当前的 Solana 网络。 Active Solana network.
 * @param marketAddress 当前市场公钥，未选中时省略。 Selected market public key, omitted when unselected.
 * @returns 携带当前网络及市场选择的链接。 URL carrying the current network and optional selection.
 */
export function lendingLocation(path: string, network: Network, marketAddress?: string | null): string {
  /** 网址参数由浏览器统一编码。 URL parameters are encoded by the browser. */
  const query = new URLSearchParams({ network });
  if (marketAddress) query.set('market', marketAddress);
  return path + '?' + query.toString();
}

/**
 * 为市场概况、借款、出借和清算页面提供共用子导航。
 * Render the navigation shared by the market overview, borrowing, supplying, and liquidation pages.
 *
 * @param props 概况传入已核对的市场选择，其他页面沿用当前 URL。 The overview supplies the verified selection and other pages carry their URL choice.
 */
export function LendingNavigation({ marketAddress }: LendingNavigationProps) {
  /** 借贷导航的文字和链接根据当前语言及网络更新。 Navigation updates labels and links for the current language and network. */
  const { t } = useTranslation();
  const { network } = useNetwork();
  const [searchParams] = useSearchParams();
  /** 已核对的概况选择优先，子页之间跳转时保留上次链接中的选择。 Prefer the verified overview selection and preserve the linked selection between nested pages. */
  const selectedAddress = marketAddress === undefined ? searchParams.get('market') : marketAddress;

  return (
    <nav className="sub-nav" aria-label={t('lending.navigation')}>
      {lendingPages.map((item) => (
        <NavLink className="nav-link" key={item} end={item !== 'borrow' && item !== 'supply'} to={lendingLocation(paths[item], network, selectedAddress)}>
          {t(item === 'lending' ? 'lending.overview' : 'pages.' + item + '.title')}
        </NavLink>
      ))}
    </nav>
  );
}

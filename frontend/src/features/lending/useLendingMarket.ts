import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useNetwork } from '../../shared/navigation/network';
import { listLendingMarkets } from './api/listLendingMarkets';

/**
 * 从当前网络的公开目录解析所选市场，供市场首页和各仓位页共用。
 * Resolve the selected market from the current network's public registry for the overview and position pages.
 *
 * @returns 当前网络、市场目录查询、所选市场及更新 URL 的方法。 Network, registry query, selected market, and URL update handler.
 */
export function useLendingMarket() {
  /** 网络和可选市场公钥都随当前页面地址变动。 The network and optional market public key follow the current URL. */
  const { network } = useNetwork();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedMarket = searchParams.get('market');

  /** 公开目录按网络隔离，首页与子页可以复用同一份查询结果。 Keep public registries separate by network while sharing the result between the overview and nested pages. */
  const markets = useQuery({
    queryKey: ['lending-markets', network],
    queryFn: ({ signal }) => listLendingMarkets({ network }, signal),
  });

  /** 只接受当前网络的登记地址，直达链接未选市场或地址失效时默认选首项。 Only accept markets registered on the current network, defaulting to its first item for missing or obsolete selections. */
  const items = markets.data?.items;
  const selected = items?.find((item) => item.address === requestedMarket) ?? items?.[0];

  /**
   * 将市场选择保存到 URL，方便子页与浏览器返回操作使用相同的选择。
   * Save the market in the URL so nested pages and browser back navigation reuse the selection.
   *
   * @param address 当前网络目录中选择的市场公钥。 Market public key selected from the current network's registry.
   */
  function selectMarket(address: string) {
    /** 保留已有参数并写入明确的网络和市场。 Retain existing parameters and store the explicit network and market. */
    const nextSearch = new URLSearchParams(searchParams);
    nextSearch.set('network', network);
    nextSearch.set('market', address);
    setSearchParams(nextSearch, { replace: true });
  }

  return { network, markets, items, selected, selectMarket };
}

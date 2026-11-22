import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { readPreference, writePreference } from '../preferences';

/** 支持且与后端协议一致的网络名称。 Supported networks matching the backend wire values. */
export const networks = ['localnet', 'devnet'] as const;

/** 从网络选项派生的联合类型。 Network union derived from the available options. */
export type Network = (typeof networks)[number];

/** 当前站点保存最近网络选择的键。 Key for the site's most recent network choice. */
const networkPreferenceKey = 'ggboy.network';

/**
 * 验证来自 URL 或浏览器设置的网络值。
 * Validate a network value from the URL or browser preferences.
 *
 * @param value 需要验证的网络字符串。 Network string to validate.
 * @returns 值是否与支持的后端协议名称一致。 Whether the value matches a supported backend wire name.
 */
function isNetwork(value: string | null): value is Network {
  return networks.some((network) => network === value);
}

/**
 * 通过 URL 统一当前页面和链接所用的网络。没有有效 URL 设置时采用浏览器偏好或 localnet。
 * Resolve the network for the current page and its links from the URL, then browser preference or localnet.
 *
 * @returns 当前网络及更新该网络的回调。 Current network and the handler for changing it.
 */
export function useNetwork() {
  /** React Router 提供当前路由的查询参数及更新方法。 React Router exposes current search parameters and their setter. */
  const [searchParams, setSearchParams] = useSearchParams();
  /** 显式网络优先于上次选择，便于从另一个设备打开回执链接。 An explicit network takes precedence for portable receipt links. */
  const requestedNetwork = searchParams.get('network');
  /** 地址没有指定网络时才读取偏好。 Read the preference only when the URL does not supply a valid network. */
  const storedNetwork = isNetwork(requestedNetwork) ? requestedNetwork : readPreference(networkPreferenceKey);
  /** 当前页面及后端查询共同使用的协议网络名称。 Wire network shared by the page and backend queries. */
  const network = isNetwork(storedNetwork) ? storedNetwork : 'localnet';

  useEffect(() => {
    writePreference(networkPreferenceKey, network);
  }, [network]);

  /**
   * 把新网络写入路由，并丢弃作用域属于旧网络的分页游标。
   * Put the new network in the route and discard a cursor scoped to the previous network.
   *
   * @param value 来自选择器的网络值。 Network value from the selector.
   */
  function changeNetwork(value: string) {
    if (!isNetwork(value) || value === network) return;

    /** 在保留其他界面筛选的副本中设置新网络。 Copy other interface filters before setting the new network. */
    const nextSearch = new URLSearchParams(searchParams);
    nextSearch.set('network', value);
    nextSearch.delete('cursor');
    setSearchParams(nextSearch);
  }

  return { network, changeNetwork };
}

/**
 * 为应用内路径加上网络，使分享的链接能独立打开对应环境。
 * Add a network to an application path so a shared link opens in the intended environment.
 *
 * @param path 不含查询参数的应用内路径。 Application path without search parameters.
 * @param network 目标网络。 Target network.
 * @returns 带有 network 查询参数的链接。 Link containing the network search parameter.
 */
export function withNetwork(path: string, network: Network): string {
  return path + '?' + new URLSearchParams({ network });
}

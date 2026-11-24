import { skipToken, useQuery } from '@tanstack/react-query';
import { usePhantomWallet } from '../../solana/phantomWallet';
import { getLendingPosition } from './api/getLendingPosition';
import { useDevnetBorrowPosition } from './useDevnetBorrowPosition';
import { isDevnetSupplyMarket, useDevnetSupplyPosition } from './useDevnetSupplyPosition';
import { useLendingMarket } from './useLendingMarket';

/**
 * 使用当前网络、市场和已连接的 Phantom 公钥查询个人借款与出借仓位。
 * Query personal borrowing and supply positions for the current network, market, and connected Phantom public key.
 *
 * @param kind 页面使用的仓位数据类型，Devnet 读取实际链上仓位。 Position view, with direct on-chain data on the supported Devnet market.
 * @returns 两个仓位页面共用的钱包、市场及仓位查询状态。 Wallet, market, and position query state shared by both position pages.
 */
export function useLendingPosition(kind: 'borrow' | 'supply' = 'borrow') {
  /** 先通过公开目录确定市场；从当前钱包连接取得查询使用的公钥。 Resolve the market through the public registry and get the query key from the active wallet connection. */
  const { network, markets, selected } = useLendingMarket();
  const wallet = usePhantomWallet();
  const marketAddress = selected?.address;
  const walletAddress = wallet.status === 'connected' ? wallet.walletAddress : null;

  /** 已登记的 Devnet 市场分别读取借款与出借仓位 PDA，其余市场保留既有索引。 Read the separate borrow and supply PDAs on the registered Devnet market and use the index elsewhere. */
  const chainMarket = isDevnetSupplyMarket(selected) ? selected : undefined;
  const borrowing = useDevnetBorrowPosition(kind === 'borrow' ? chainMarket : undefined, walletAddress);
  const supplying = useDevnetSupplyPosition(kind === 'supply' ? chainMarket : undefined, walletAddress);

  /** 两个页面共用同一响应，任何查询参数变动都使用独立的缓存记录。 Both pages share the response, with separate cache entries for different values of any query parameter. */
  const position = useQuery({
    queryKey: ['lending-position', network, marketAddress, walletAddress],
    // 钱包断开或市场尚未确定时跳过请求。传递取消信号，避免继续等待不再使用的旧仓位。
    // Skip the request without a connected wallet or selected market. Pass the cancellation signal so old position reads can stop.
    queryFn: !chainMarket && marketAddress && walletAddress
      ? ({ signal }) => getLendingPosition({ network, marketAddress, walletAddress }, signal)
      : skipToken,
  });

  return {
    markets, selected, wallet, walletAddress, position,
    liveBorrow: chainMarket && kind === 'borrow' ? borrowing : undefined,
    liveSupply: chainMarket && kind === 'supply' ? supplying : undefined,
  };
}

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { listLendingLiquidations, type LendingLiquidationAvailability } from '../../features/lending/api/listLendingLiquidations';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { LendingNavigation } from '../../features/lending/LendingNavigation';
import { useLendingMarket } from '../../features/lending/useLendingMarket';
import { ApiError } from '../../shared/api/client';
import { PageLayout } from '../../shared/ui/PageLayout';
import { isLiquidationMarketSupported } from '../../solana/lending/liquidateLendingPosition';
import { usePhantomWallet } from '../../solana/phantomWallet';
import { LendingLiquidationActivity } from './LendingLiquidationActivity';
import { LendingLiquidationOperation } from './LendingLiquidationOperation';
import { formatPositionAmount, formatPositionDecimal, positionAssetLabel } from './positionValues';
import './styles/liquidations.css';

/** 逐个映射后端状态，只有就绪批次才显示候选。 Map backend statuses explicitly and show candidates only from a ready batch. */
const availabilityMessages: Record<Exclude<LendingLiquidationAvailability, 'READY'>, string> = {
  NO_SNAPSHOT: 'lendingLiquidations.noSnapshot',
  STALE: 'lendingLiquidations.stale',
  PRICE_UNAVAILABLE: 'lendingLiquidations.priceUnavailable',
};

/** 当前网络中可用的借贷市场。 Markets available on the selected network. */
interface CandidatesProps {
  /** 来自公开目录的市场公钥及债务和抵押资产精度。 Market key and debt and collateral precisions from the public registry. */
  market: LendingMarketListItem;
  /** 无效的显式市场仍可浏览目录，但不允许使用回退市场签名。 An invalid explicit market can be browsed via the registry fallback, but cannot sign there. */
  hasValidMarketSelection: boolean;
}

/**
 * 展示同一观测批次的清算候选、价格与分页状态，无需连接钱包。
 * Show liquidation candidates, prices, and pagination for one observation batch without wallet access.
 *
 * @param props 已核验的市场与资产元数据。 Verified market and asset metadata.
 */
function LiquidationCandidates({ market, hasValidMarketSelection }: CandidatesProps) {
  /** 本地化金额和时间保持 API 观测的单位与原始 ISO 值。 Localized amounts and dates preserve the API's units and original ISO values. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const queryClient = useQueryClient();
  const wallet = usePhantomWallet();
  const [searchParams, setSearchParams] = useSearchParams();
  /** 候选写入 URL，以便已广播后刷新页面或重新连接 Phantom 能回到原候选。 Save the selection in the URL so reconnecting or refreshing after broadcast restores the same target. */
  const requestedBorrower = searchParams.get('borrower');
  const selectedBorrower = requestedBorrower && searchParams.get('liquidationNetwork') === market.network &&
    searchParams.get('market') === market.address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(requestedBorrower) ? requestedBorrower : null;
  const walletAddress = wallet.status === 'connected' ? wallet.walletAddress : null;
  const writesEnabled = hasValidMarketSelection && isLiquidationMarketSupported(market);

  /** 候选页缓存按网络和公钥隔离，游标只在同一评估批次内可用。 Cache by network and market, using cursors only within their original evaluation batch. */
  const queryKey = ['lending-liquidations', market.network, market.address] as const;
  const candidates = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listLendingLiquidations({
      network: market.network, marketAddress: market.address, cursor: pageParam,
    }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // 已加载的续页绑定同一 slot；用户刷新时应从首屏开始重新加载。
    // Loaded cursors refer to the same slot. A user refresh must reload from the first page.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
    retry: false,
  });

  /** 后端在评估批次变更后拒绝续页，提示从首屏恢复。 The backend rejects continuation after a batch changes, so restart from the first page. */
  const cursorExpired = candidates.isFetchNextPageError && candidates.error instanceof ApiError && candidates.error.status === 400;
  const firstPage = candidates.data?.pages[0];
  /** 续页可能先遇到新的缺价或过期状态；此时不继续使用旧的就绪批次。 A later page may encounter missing prices or staleness first, so do not keep using the older ready batch. */
  const currentPage = candidates.data?.pages.find((page) => page.availability !== 'READY') ?? firstPage;
  const ready = currentPage?.availability === 'READY' && !cursorExpired;
  const items = ready ? candidates.data?.pages.flatMap((page) => page.items) ?? [] : [];

  /** 清空累积续页并重查首屏，避免在旧评估续页。 Discard all loaded pages and reload the first page to avoid obsolete cursors. */
  function refresh() {
    void queryClient.resetQueries({ queryKey, exact: true });
  }

  /** 将候选与签名所依据的市场及网络一起写入 URL。 Store the candidate along with its signing market and network in the URL. */
  function selectBorrower(address: string) {
    const next = new URLSearchParams(searchParams);
    next.set('network', market.network);
    next.set('market', market.address);
    next.set('borrower', address);
    next.set('liquidationNetwork', market.network);
    setSearchParams(next, { replace: true });
  }

  return (
    <>
      <section className="liquidations__panel" aria-labelledby="liquidations-candidates-title">
        <header className="liquidations__heading">
          <h2 id="liquidations-candidates-title">{t('lendingLiquidations.candidates')}</h2>
          <button type="button" className="liquidations__button" disabled={candidates.isFetching} onClick={refresh}>
            {t('lendingLiquidations.refresh')}
          </button>
        </header>
        {candidates.isPending && <p className="liquidations__notice" role="status">{t('lendingLiquidations.loading')}</p>}
        {candidates.isError && (
          <p className="liquidations__notice liquidations__notice--error" role="alert">
            {t(cursorExpired ? 'lendingLiquidations.cursorExpired' : candidates.isFetchNextPageError
              ? 'lendingLiquidations.nextPageError' : 'lendingLiquidations.requestError')}
          </p>
        )}
        {!cursorExpired && currentPage && currentPage.availability !== 'READY' && (
          <p className="liquidations__notice" role="status">{t(availabilityMessages[currentPage.availability])}</p>
        )}
        {ready && currentPage && (
          <>
            <dl className="liquidations__context">
              {currentPage.collateralPrice !== null && (
                <div>
                  <dt>{t('lendingLiquidations.price')}</dt>
                  <dd>{t('lendingLiquidations.priceValue', {
                    price: formatPositionDecimal(currentPage.collateralPrice, locale),
                    debt: positionAssetLabel(market.debtAsset),
                    collateral: positionAssetLabel(market.collateralAsset),
                  })}</dd>
                </div>
              )}
              {currentPage.oracleAddress !== null && (
                <div>
                  <dt>{t('lendingLiquidations.oracle')}</dt>
                  <dd><code>{currentPage.oracleAddress}</code></dd>
                </div>
              )}
              {currentPage.oraclePublishedAt !== null && (
                <div>
                  <dt>{t('lendingLiquidations.oraclePublished')}</dt>
                  <dd><time dateTime={currentPage.oraclePublishedAt}>{date.format(new Date(currentPage.oraclePublishedAt))}</time></dd>
                </div>
              )}
              {currentPage.observedAt !== null && (
                <div>
                  <dt>{t('lendingLiquidations.observed')}</dt>
                  <dd><time dateTime={currentPage.observedAt}>{date.format(new Date(currentPage.observedAt))}</time></dd>
                </div>
              )}
            </dl>

            {!items.length && !candidates.isError && (
              <p className="liquidations__notice" role="status">{t('lendingLiquidations.empty')}</p>
            )}
            {items.length > 0 && (
              <div className="liquidations__scroll" tabIndex={0} role="region" aria-label={t('lendingLiquidations.candidates')}>
                <table className="liquidations__table">
                  <thead>
                    <tr>
                      <th scope="col">{t('lendingLiquidations.borrower')}</th>
                      <th scope="col">{t('lendingLiquidations.health')}</th>
                      <th scope="col">{t('lendingLiquidations.debt')}</th>
                      <th scope="col">{t('lendingLiquidations.collateral')}</th>
                      {writesEnabled && <th scope="col">{t('lendingLiquidations.actionColumn')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.walletAddress}>
                        <th scope="row"><code>{item.walletAddress}</code></th>
                        <td className="liquidations__health">{formatPositionDecimal(item.healthFactor, locale)}</td>
                        <td>{formatPositionAmount(item.debtRaw, market.debtAsset, locale)}</td>
                        <td>{formatPositionAmount(item.collateralRaw, market.collateralAsset, locale)}</td>
                        {writesEnabled && (
                          <td>
                            <button className="liquidations__button" type="button" aria-pressed={selectedBorrower === item.walletAddress}
                              onClick={() => selectBorrower(item.walletAddress)}>
                              {t('lendingLiquidations.selectAction')}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {candidates.hasNextPage && (
              <button type="button" className="liquidations__button" disabled={candidates.isFetching}
                onClick={() => void candidates.fetchNextPage()}>
                {t(candidates.isFetchingNextPage ? 'lendingLiquidations.loadingMore' : 'lendingLiquidations.loadMore')}
              </button>
            )}
          </>
        )}
        {!writesEnabled && <p className="liquidations__notice">{t('lendingLiquidations.readOnly')}</p>}
      </section>
      {writesEnabled && selectedBorrower && !walletAddress && (
        <section className="liquidations__panel" aria-labelledby="liquidation-connect-title">
          <header className="liquidations__heading">
            <h2 id="liquidation-connect-title">{t('lendingLiquidations.actionTitle')}</h2>
          </header>
          <p className="liquidations__notice">{t('lendingLiquidations.walletPrompt')}</p>
          <button type="button" className="liquidations__button liquidations__button--primary"
            disabled={wallet.status !== 'disconnected'} onClick={() => void wallet.connect()}>
            {t(wallet.status === 'connecting' ? 'wallet.connecting' : 'wallet.connect')}
          </button>
          {wallet.error && <p className="liquidations__notice liquidations__notice--error" role="alert">{t('wallet.' + wallet.error)}</p>}
        </section>
      )}
      {writesEnabled && selectedBorrower && walletAddress && (
        <LendingLiquidationOperation key={selectedBorrower + ':' + walletAddress} market={market}
          borrowerAddress={selectedBorrower} walletAddress={walletAddress} onConfirmed={refresh} />
      )}
      <LendingLiquidationActivity market={market} />
    </>
  );
}

/**
 * 渲染清算市场路由，沿用借贷市场目录和网络选择。
 * Render the liquidation route using the shared market registry and network selection.
 */
export function LiquidationsPage() {
  /** 借贷子页共同使用当前 URL 的网络和市场。 Lending subpages share the network and market from the active URL. */
  const { t } = useTranslation();
  const { network, items, markets, selected } = useLendingMarket();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedMarket = searchParams.get('market');
  const hasValidMarketSelection = requestedMarket === null || requestedMarket === selected?.address;

  /** 切换市场时清除上一个市场的候选，以免误带入新的市场。 Clear the previous candidate when selecting a different market. */
  function changeMarket(marketAddress: string) {
    const next = new URLSearchParams(searchParams);
    next.set('network', network);
    next.set('market', marketAddress);
    next.delete('borrower');
    next.delete('liquidationNetwork');
    setSearchParams(next, { replace: true });
  }

  return (
    <PageLayout title={t('pages.liquidations.title')} description={t('pages.liquidations.description')}>
      <LendingNavigation marketAddress={selected?.address ?? null} />
      {selected && (items?.length ?? 0) > 1 && (
        <label className="liquidations__market">
          <span>{t('lendingPool.selectedMarket')}</span>
          <select value={selected.address} onChange={(event) => changeMarket(event.currentTarget.value)}>
            {items?.map((market) => (
              <option key={market.address} value={market.address}>
                {positionAssetLabel(market.debtAsset)} / {positionAssetLabel(market.collateralAsset)} · {market.address}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected ? (
        <LiquidationCandidates key={selected.network + ':' + selected.address} market={selected}
          hasValidMarketSelection={hasValidMarketSelection} />
      ) : markets.isError ? (
        <div className="liquidations__panel">
          <p className="liquidations__notice liquidations__notice--error" role="alert">{t('lendingPool.error')}</p>
          <button type="button" className="liquidations__button" onClick={() => void markets.refetch()}>
            {t('lendingPool.retry')}
          </button>
        </div>
      ) : (
        <p className="liquidations__notice" role="status">{t(markets.isPending ? 'lendingPool.loading' : 'lendingPool.noMarkets')}</p>
      )}
    </PageLayout>
  );
}

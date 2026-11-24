import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { LendingMarketAsset } from '../../features/lending/api/listLendingMarkets';
import { LendingNavigation, lendingLocation } from '../../features/lending/LendingNavigation';
import { devnetLendingCashQueryKey } from '../../features/lending/lendingQueryKeys';
import { isDevnetSupplyMarket } from '../../features/lending/useDevnetSupplyPosition';
import { useLendingMarket } from '../../features/lending/useLendingMarket';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import { readDevnetLendingCash } from '../../solana/lending/devnetLendingPool';
import { LendingPoolMetrics } from './LendingPoolMetrics';
import './styles/lending-market.css';

/**
 * 资产简称缺失时使用 Mint 缩写，让市场仍能按资产标识区分。
 * Abbreviate the mint when no ticker is registered so markets can still be distinguished.
 *
 * @param asset 接口返回的 Mint 公钥与显示信息。 Mint public key and display metadata from the API.
 * @returns 简称或供展示的 Mint 缩写。 Ticker or display abbreviation of the mint.
 */
function assetLabel(asset: LendingMarketAsset) {
  return asset.symbol || asset.mint.slice(0, 4) + '…' + asset.mint.slice(-4);
}

/**
 * 组织借款、出借和清算入口，并展示当前网络中所选市场的公开资金池观测。
 * Show borrowing, supplying and liquidation entry points with public pool observations for the selected market.
 */
export function LendingMarketPage() {
  /** 首页的文字与状态跟随界面语言。 Page copy and status follow the current UI language. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 首页与仓位页使用同一份公开目录和市场选择规则。 The overview and position pages share the public registry and market selection rules. */
  const { network, items, markets, selected, selectMarket } = useLendingMarket();
  const marketAddress = selected?.address;

  /** 登记的 GGBOY Devnet 市场使用链上现金，并提供出借入口。 Use chain cash and enable supply for the registered GGBOY Devnet deployment. */
  const liveMarket = isDevnetSupplyMarket(selected) ? selected : null;
  /** 与交易确认后的缓存同步共用查询键。 Share the cash query key with the post-confirmation synchronization. */
  const cashKey = devnetLendingCashQueryKey(liveMarket);
  const queryClient = useQueryClient();
  const liveCash = useQuery({
    queryKey: cashKey,
    queryFn: liveMarket ? async ({ signal }) => {
      /** 保留更新的已确认余额，防止较慢的 RPC 节点造成显示回退。 Preserve newer confirmed cash if the RPC node returns an older slot. */
      const current = await readDevnetLendingCash(liveMarket, signal);
      const previous = queryClient.getQueryData<typeof current>(cashKey);
      return previous && previous.slot > current.slot ? previous : current;
    } : skipToken,
    refetchInterval: 30_000,
  });
  /** 链上余额达到索引的 slot 后才替换同一市场的现金。 Replace indexed cash once the chain observation has reached its snapshot slot. */
  const confirmedCash = liveMarket && liveCash.data &&
    (!liveMarket.latestSnapshot || BigInt(liveCash.data.slot) >= BigInt(liveMarket.latestSnapshot.slot))
    ? liveCash.data : undefined;
  /** 单独报告链上现金读取状态，RPC 失败时保留该登记项的上次余额。 Report cash-read status separately, retaining the last balance for this registration after an RPC failure. */
  const liveCashStatus = !liveMarket ? undefined
    : liveCash.isError ? liveCash.data ? 'lendingPool.chainCashRefreshError' : 'lendingPool.chainCashError'
    : liveCash.isPending && !selected?.latestSnapshot ? 'lendingPool.chainCashLoading' : undefined;

  /** 空市场和已登记但尚未采集分别提示。 Distinguish an empty registry from a registered pool waiting for its first observation. */
  const poolStatus = markets.isPending ? 'lendingPool.loading'
    : markets.isError ? selected ? 'lendingPool.refreshError' : 'lendingPool.error'
    : !selected ? 'lendingPool.noMarkets'
    : selected.latestSnapshot === null ? liveMarket ? 'lendingPool.noIndexedMetrics' : 'lendingPool.noObservation'
    : undefined;

  /** 按当前网络重新查询资金池，后台刷新失败时仍可查看已加载的值。 Refresh the active network while keeping previously loaded metrics if the refresh fails. */
  function refreshPool() {
    void markets.refetch();
    if (liveMarket) void liveCash.refetch();
  }

  return (
    <PageLayout title={t('pages.lending.title')} description={t('pages.lending.description')}>
      <LendingNavigation marketAddress={marketAddress ?? null} />
      <div className="lending-market">
        <div className="lending-market__actions">
          <section className="lending-market__entry" aria-labelledby="lending-borrow-entry">
            <h2 id="lending-borrow-entry">{t('lendingMarket.borrowTitle')}</h2>
            <p>{t('lendingMarket.borrowDescription')}</p>
            <Link className="lending-market__button lending-market__button--primary" to={lendingLocation(paths.borrow, network, marketAddress)}>
              {t('lendingMarket.borrowLink')}
            </Link>
          </section>
          <section className="lending-market__entry" aria-labelledby="lending-supply-entry">
            <h2 id="lending-supply-entry">{t('lendingMarket.supplyTitle')}</h2>
            <p>{t('lendingMarket.supplyDescription')}</p>
            <Link className="lending-market__button" to={lendingLocation(liveMarket ? paths.supplyDeposit : paths.supply, network, marketAddress)}>
              {t(liveMarket ? 'lendingSupply.action' : 'lendingMarket.supplyLink')}
            </Link>
          </section>
        </div>

        <div className="lending-market__details">
          <section className="lending-market__section" aria-labelledby="lending-pool-title">
            <header className="lending-market__section-header">
              <h2 id="lending-pool-title">{t('lendingPool.title')}</h2>
              <button type="button" className="lending-market__button" onClick={refreshPool} disabled={markets.isFetching || liveCash.isFetching}>
                {t(markets.isError || (liveMarket && liveCash.isError) ? 'lendingPool.retry' : 'lendingPool.refresh')}
              </button>
            </header>
            {selected && (items?.length ?? 0) > 1 && (
              <label className="lending-market__selector">
                <span>{t('lendingPool.selectedMarket')}</span>
                <select value={selected.address} onChange={(event) => selectMarket(event.currentTarget.value)}>
                  {items?.map((item) => (
                    <option key={item.address} value={item.address}>
                      {assetLabel(item.debtAsset)} / {assetLabel(item.collateralAsset)} · {item.address.slice(0, 6)}…{item.address.slice(-6)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selected && (
              <p className="lending-market__pair" title={selected.address}>
                {t('lendingPool.assetPair', {
                  debt: assetLabel(selected.debtAsset),
                  collateral: assetLabel(selected.collateralAsset),
                })}
              </p>
            )}
            {poolStatus && (
              <p
                className={markets.isError ? 'lending-market__status lending-market__status--error' : 'lending-market__status'}
                role={markets.isError ? 'alert' : 'status'}
              >
                {t(poolStatus)}
              </p>
            )}
            {selected?.latestSnapshot && (
              <LendingPoolMetrics market={selected} snapshot={selected.latestSnapshot} cashOverride={confirmedCash?.cashRaw} />
            )}
            {/* 链上观测单独更新现金，利率和债务等指标仍使用索引。 */}
            {/* The live observation updates cash while rates and debt retain their indexed values. */}
            {liveMarket && confirmedCash && !liveMarket.latestSnapshot && (
              <dl className="lending-pool-metrics">
                <div>
                  <dt>{t('lendingPool.cash')}</dt>
                  <dd>
                    {formatTokenAmount(confirmedCash.cashRaw, liveMarket.debtAsset.decimals, locale)}{' '}
                    <span title={liveMarket.debtAsset.mint}>{assetLabel(liveMarket.debtAsset)}</span>
                  </dd>
                </div>
              </dl>
            )}
            {confirmedCash && (
              <p className="lending-market__status">
                {t('lendingPool.chainCashObservation', { slot: confirmedCash.slot })}
              </p>
            )}
            {liveCashStatus && (
              <p
                className={liveCash.isError ? 'lending-market__status lending-market__status--error' : 'lending-market__status'}
                role={liveCash.isError ? 'alert' : 'status'}
              >
                {t(liveCashStatus)}
              </p>
            )}
          </section>

          <section className="lending-market__section lending-market__liquidation" aria-labelledby="lending-liquidation-title">
            <h2 id="lending-liquidation-title">{t('lendingMarket.liquidationTitle')}</h2>
            <p>{t('lendingMarket.liquidationDescription')}</p>
            <Link className="text-link" to={lendingLocation(paths.liquidations, network, marketAddress)}>
              {t('lendingMarket.liquidationLink')}
            </Link>
          </section>
        </div>
      </div>
    </PageLayout>
  );
}

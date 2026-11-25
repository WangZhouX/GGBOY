import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { getActivityAssetLabel, shortenActivityAddress } from '../../features/activity/activityDisplay';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import { StrategyRecentActivity } from './StrategyRecentActivity';
import { strategyActions, strategyGate, strategyLocation, useStrategyRoute, type StrategyAction } from './StrategyRouteLayout';
import './styles/strategy.css';

/**
 * 返回输入资产、预言机或池余额不足时最具体的可见提示。
 * Return the most specific visible explanation for unavailable balances, prices, or pool liquidity.
 *
 * @param state 所选金库的实时读取结果。 Current on-chain observation of the selected vault.
 * @param action 页面要展示的管理操作。 Management operation shown by the page.
 */
function actionAvailability(state: ReturnType<typeof useStrategyRoute>['chain']['data'], action: StrategyAction) {
  if (!state?.config) return null;
  if (action === 'lend') {
    if (state.maxLendRaw === null) return 'strategy.actions.lend.unknownLimit';
    return state.maxLendRaw === 0n ? 'strategy.actions.lend.noCapacity' : null;
  }
  if (action === 'recall') {
    return state.maxRecallSharesRaw === 0n
      ? state.lendingSharesRaw === 0n ? 'strategy.actions.recall.noPosition' : 'strategy.actions.recall.noLiquidity'
      : null;
  }
  if (state.priceRaw === null) return 'strategy.actions.swap.priceUnavailable';
  /** 两个方向各自需要金库投入资产和测试兑换储备库存。 Each direction needs an input balance in the vault and an output balance in the test swap reserve. */
  const canBuy = state.cashRaw > 0n && state.swapSpotRaw > 0n;
  const canSell = state.spotRaw > 0n && state.swapCashRaw > 0n;
  return canBuy || canSell ? null : 'strategy.actions.swap.noLiquidity';
}

/**
 * 展示金库资金配置、三种管理动作和按金库筛选的策略交易。
 * Review vault allocation, three management actions, and strategy activity filtered by vault.
 */
export function StrategyPage() {
  /** 文案和金额始终使用当前界面语言。 Use the active interface language for all copy and amounts. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 公共账户与权限状态在管理首页及独立表单之间复用。 Reuse public balances and role status across the overview and forms. */
  const route = useStrategyRoute();
  const { network, catalog, chain, selected, vaults, selectVault } = route;
  const gate = strategyGate(route);
  /** 过时或无法读取的链上账户允许回看索引值，显示清楚其数据来源且禁用交易。 Use indexed figures as a labeled fallback when chain reads fail and keep transactions disabled. */
  const snapshot = selected?.latestSnapshot;
  const live = chain.isSuccess ? chain.data : undefined;
  const config = live?.config;
  const overview = live || snapshot;
  /** 从所选金库的登记信息显示币种，缺少简称时使用同一资产的地址缩写。 Use the selected vault's registered ticker or abbreviate that same mint. */
  const quoteAsset = selected?.quoteAsset;
  const spotAsset = selected?.strategyAsset;
  const spotMint = config?.strategyMint.toBase58() ?? spotAsset?.mint;
  const spotSymbol = spotAsset && spotAsset.mint === spotMint ? spotAsset.symbol : null;
  const spotLabel = spotMint ? getActivityAssetLabel({ mint: spotMint, symbol: spotSymbol }, network) : null;
  /** 即时赎回资金为托管现金，以及已启用同笔收回时的池内可取金额。 Instant redemption uses vault cash and the withdrawable pool amount when atomic recall is enabled. */
  const cash = live ? live.cashRaw : snapshot?.cashRaw;
  const redeemLiquidity = live?.autoRecallEnabled ? live.cashRaw + live.maxRecallRaw
    : snapshot?.autoRecallEnabled && !live ? BigInt(snapshot.cashRaw) + BigInt(snapshot.lendingWithdrawableRaw) : cash;
  const figures = [
    { key: 'nav', raw: live ? live.navRaw : snapshot?.navRaw },
    { key: 'cash', raw: cash },
    { key: 'spot', raw: spotMint ? live?.spotRaw ?? snapshot?.strategyAmountRaw : undefined, spot: true },
    { key: 'strategyValue', raw: live ? live.strategyValueRaw : snapshot?.strategyValueRaw },
    { key: 'lendValue', raw: live ? live.lendingValueRaw : snapshot?.lendValueRaw },
    { key: 'lendShares', raw: config ? live?.lendingSharesRaw : undefined, shares: true },
    { key: 'maxLend', raw: config ? live?.maxLendRaw : undefined },
    { key: 'maxRecall', raw: config ? live?.maxRecallRaw : snapshot?.lendingWithdrawableRaw },
    { key: 'redeemCash', raw: redeemLiquidity },
  ];

  return (
    <PageLayout title={t('pages.strategy.title')} description={t('pages.strategy.description')}>
      <div className="strategy-layout">
        <section className="strategy-panel strategy-account" aria-labelledby="strategy-account-title">
          <header className="strategy-panel__header">
            <h2 id="strategy-account-title">{t('strategy.account.title')}</h2>
            <button
              className="strategy-button"
              type="button"
              disabled={catalog.isFetching || (route.supported && chain.isFetching)}
              onClick={() => {
                void catalog.refetch();
                if (route.supported) void chain.refetch();
              }}
            >
              {t('strategy.refresh')}
            </button>
          </header>
          {vaults.length > 1 && (
            <label className="strategy-field">
              {t('strategy.account.selectVault')}
              <select value={selected?.address ?? ''} onChange={(event) => selectVault(event.currentTarget.value)}>
                {!selected && <option value="">{t('strategy.account.selectVault')}</option>}
                {vaults.map((vault) => (
                  <option key={vault.address} value={vault.address}>
                    {getActivityAssetLabel(vault.quoteAsset, network)} · {shortenActivityAddress(vault.address)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selected && (
            <div className="strategy-account__identity">
              <code title={selected.address}>{shortenActivityAddress(selected.address)}</code>
              <Link className="text-link" to={paths.vault + '?' + new URLSearchParams({ network, vault: selected.address })}>
                {t('strategy.account.viewVault')}
              </Link>
            </div>
          )}
          {overview && quoteAsset ? (
            <>
              <p className="strategy-note" role="status">{t(live ? 'strategy.account.live' : 'strategy.account.indexed')}</p>
              {live?.navRaw === null && <p className="strategy-note">{t('strategy.account.navUnavailable')}</p>}
              <dl className="strategy-figures">
                {figures.map(({ key, raw, spot, shares }) => (
                  <div key={key}>
                    <dt>{t('strategy.account.' + key)}</dt>
                    <dd>
                      {raw == null ? t('strategy.unavailable') : shares
                        ? formatTokenAmount(raw, 6, locale) + ' ' + t('strategy.form.poolShares')
                        : spot && spotLabel
                          ? formatTokenAmount(raw, config?.strategyDecimals ?? spotAsset?.decimals ?? 0, locale) + ' ' + spotLabel
                          : formatTokenAmount(raw, quoteAsset.decimals, locale) + ' ' + getActivityAssetLabel(quoteAsset, network)}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p className="strategy-note" role="status">{t(gate ?? 'strategy.account.waiting')}</p>
          )}
          {config && (
            <dl className="strategy-config">
              <dt>{t('strategy.account.manager')}</dt>
              <dd><code>{config.manager.toBase58()}</code></dd>
              <dt>{t('strategy.account.reserve')}</dt>
              <dd>{new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(config.reserveBps / 10_000)}</dd>
              <dt>{t('strategy.account.lendingCap')}</dt>
              <dd>{new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(config.lendingCapBps / 10_000)}</dd>
              <dt>{t('strategy.account.tradeCap')}</dt>
              <dd>{new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(config.maxTradeBps / 10_000)}</dd>
            </dl>
          )}
        </section>
        <section className="strategy-panel strategy-actions" aria-labelledby="strategy-actions-title">
          <header className="strategy-panel__header">
            <h2 id="strategy-actions-title">{t('strategy.actions.title')}</h2>
          </header>
          {gate && overview && <p className="strategy-note" role="status">{t(gate)}</p>}
          {gate === 'strategy.connectManager' && route.wallet.status === 'disconnected' && (
            <div>
              <button className="strategy-button" type="button" onClick={() => void route.wallet.connect()}>
                {t('wallet.connect')}
              </button>
            </div>
          )}
          <ul className="strategy-action-list">
            {strategyActions.map((action) => {
              /** 操作余额不足时，列出对应原因并避免进入不可执行表单。 Show the relevant shortage and avoid opening an unusable form. */
              const unavailable = actionAvailability(live, action);
              /** 操作名、资金去向和失败原因都由当前操作决定。 The action determines its name, destination, and any blocking reason. */
              const copy = 'strategy.actions.' + action;
              return (
                <li key={action}>
                  <h3>{t(copy + '.title')}</h3>
                  <p>{t(copy + '.description')}</p>
                  {gate === null && unavailable === null && selected && (
                    <Link className="strategy-button strategy-button--primary" to={strategyLocation(network, selected.address, action)}>
                      {t(copy + '.open')}
                    </Link>
                  )}
                  {gate === null && unavailable && <p className="strategy-note">{t(unavailable)}</p>}
                </li>
              );
            })}
          </ul>
        </section>
        <StrategyRecentActivity />
      </div>
    </PageLayout>
  );
}

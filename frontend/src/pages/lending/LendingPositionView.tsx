import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LendingNavigation } from '../../features/lending/LendingNavigation';
import type { useLendingPosition } from '../../features/lending/useLendingPosition';
import { positionAssetLabel } from './positionValues';
import './styles/lending-position.css';

/** 借款与出借页共用的查询状态和各自提供的内容。 Shared position query state and page-specific content. */
interface LendingPositionViewProps {
  /** 页面自己的仓位区标题。 Heading for the page's position section. */
  title: string;
  /** 当前市场、钱包与仓位请求状态。 Current market, wallet, and position query state. */
  state: ReturnType<typeof useLendingPosition>;
  /** 获取观测后由当前页面生成的指标列表。 Metrics rendered by the current page once an observation is available. */
  children: ReactNode;
  /** 市场支持的操作入口，展示于对应仓位区下方。 Actions supported by this market, displayed under the position. */
  actions?: ReactNode;
  /** 借款页右侧展示的风险规则。 Risk rules displayed alongside the borrowing section. */
  aside?: ReactNode;
}

/**
 * 为两个仓位页展示当前市场、钱包提示、查询状态和观测时间。
 * Render the active market, wallet prompt, query states, and observation time for both position pages.
 *
 * @param props 查询状态与当前页面的仓位指标。 Query state and the current page's position metrics.
 */
export function LendingPositionView({ title, state, children, aside, actions }: LendingPositionViewProps) {
  /** 状态文案和时间都按界面语言显示。 Localize both the state text and observation time. */
  const { t, i18n } = useTranslation();
  /** 查询只能使用已解析的市场和连接中的钱包，断开时也停止显示上次仓位。 Requires a resolved market and a connected wallet; hide the last position on disconnect. */
  const { selected, markets, wallet, walletAddress, position, liveSupply, liveBorrow } = state;
  const canQuery = Boolean(selected && walletAddress);
  /** 读取状态与金额都取同一数据源，链上空仓仍可正常展示零值。 Report status and amounts from the same source, including zero balances for a verified empty position. */
  const snapshot = canQuery && !liveSupply && !liveBorrow ? position.data?.snapshot : undefined;
  const chainSupply = canQuery ? liveSupply?.data : undefined;
  const chainBorrow = canQuery ? liveBorrow?.data : undefined;
  const positionQuery = liveBorrow ?? liveSupply ?? position;
  const hasObservation = Boolean(snapshot || chainSupply || chainBorrow);
  /** 钱包连接、断开的等待阶段不允许发起第二次操作。 Prevent another wallet operation while connecting or disconnecting. */
  const walletBusy = wallet.status === 'connecting' || wallet.status === 'disconnecting';

  /** 按依赖顺序解释当前缺少的数据，错误与已同步空仓分别处理。 Explain missing dependencies in order and distinguish errors from an observed empty position. */
  const status = !selected
    ? markets.isError ? 'lendingPosition.marketError'
      : markets.isPending ? 'lendingPosition.marketLoading'
      : 'lendingPool.noMarkets'
    : !walletAddress ? 'lendingPosition.connectPrompt'
    : positionQuery.isError ? hasObservation ? 'lendingPosition.refreshError' : 'lendingPosition.error'
    : positionQuery.isPending ? 'lendingPosition.loading'
    : snapshot === null ? 'lendingPosition.awaitingSnapshot'
    : undefined;
  const statusIsError = selected ? canQuery && positionQuery.isError : markets.isError;

  /** 观测时间保留为 UTC，旧记录用「上次观测」显示。 Keep the UTC observation time and label older records as the last observation. */
  const observedAt = chainSupply?.observedAt ?? snapshot?.observedAt;
  const observationTime = observedAt ? new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
    dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC',
  }).format(new Date(observedAt)) : undefined;

  /** 单独重试目录或当前仓位。 Retry either the registry or the current position. */
  function refresh() {
    if (!selected) void markets.refetch();
    else if (canQuery) void positionQuery.refetch();
  }

  /** 使用全站共享的 Phantom 连接流程。 Start the app's shared Phantom connection. */
  function connectWallet() {
    void wallet.connect();
  }

  return (
    <>
      <LendingNavigation marketAddress={selected?.address ?? null} />
      <div className={aside && hasObservation ? 'lending-position lending-position--split' : 'lending-position'}>
        <section className="lending-position__section" aria-labelledby="lending-position-title">
          <header className="lending-position__header">
            <h2 id="lending-position-title">{title}</h2>
            {(canQuery || (!selected && markets.isError)) && (
              <button type="button" className="lending-position__button" onClick={refresh}
                disabled={selected ? positionQuery.isFetching : markets.isFetching}>
                {t(statusIsError ? 'lendingPosition.retry' : 'lendingPosition.refresh')}
              </button>
            )}
          </header>
          {selected && (
            <p className="lending-position__note" title={selected.address}>
              {t('lendingPool.assetPair', {
                debt: positionAssetLabel(selected.debtAsset),
                collateral: positionAssetLabel(selected.collateralAsset),
              })}
            </p>
          )}
          {status && (
            <p className={statusIsError ? 'lending-position__note lending-position__note--error' : 'lending-position__note'}
              role={statusIsError ? 'alert' : 'status'}>
              {t(status)}
            </p>
          )}
          {selected && !walletAddress && (
            <button type="button" className="lending-position__button lending-position__button--connect"
              onClick={connectWallet} disabled={walletBusy}>
              {t(wallet.status === 'connecting' ? 'wallet.connecting' : 'wallet.connect')}
            </button>
          )}
          {/* 旧数据保留其观测时间，当前额度和历史数据的语义由接口分开。 */}
          {/* Preserve the timestamp of older data and rely on the API to distinguish current limits from historical values. */}
          {hasObservation && (
            <>
              <p className="lending-position__note">
                {chainBorrow ? t('lendingBorrow.synced') : chainSupply
                  ? t('lendingPosition.onChainObservation', { slot: chainSupply.slot })
                  : <time dateTime={observedAt}>
                      {t(snapshot?.freshness === 'STALE' ? 'lendingPool.previousObservation' : 'lendingPool.observedAt', { time: observationTime })}
                    </time>}
              </p>
              {children}
            </>
          )}
          {actions}
        </section>
        {hasObservation && aside}
      </div>
    </>
  );
}

/** 仓位指标的可见名称和格式化后数值。 Visible name and formatted value of a position metric. */
interface LendingPositionMetric {
  /** 当前语言的指标名称，同一组内唯一。 Localized metric name, unique within its group. */
  label: string;
  /** 由调用方按资产精度生成的金额或状态文本。 Amount formatted using the mint precision or status text supplied by the caller. */
  value: string;
}

/**
 * 用定义列表渲染有名称的仓位指标。
 * Render named position metrics as a definition list.
 *
 * @param props 页面按业务顺序提供的指标。 Metrics in the page's business order.
 */
export function LendingPositionMetrics({ rows }: { rows: LendingPositionMetric[] }) {
  return (
    <dl className="lending-position__metrics">
      {rows.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

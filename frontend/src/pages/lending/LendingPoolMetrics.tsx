import { useTranslation } from 'react-i18next';
import type { LendingMarketListItem, LendingMarketSnapshot } from '../../features/lending/api/listLendingMarkets';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import './styles/lending-pool-metrics.css';

/** 选中的借贷市场和已取得的资金池观测。 Selected lending market and its available pool observation. */
interface LendingPoolMetricsProps {
  /** 市场登记信息，提供金额所用借款资产的 Mint 和小数位。 Market registration supplying the debt mint and its decimal precision. */
  market: LendingMarketListItem;
  /** 该市场最后一次观测的金额、利率和时间。 Amounts, rates, and time from the market's latest observation. */
  snapshot: LendingMarketSnapshot;
  /** 已验证且观测 slot 不早于快照的 Devnet 现金。 Verified Devnet cash observed at or after the indexed slot. */
  cashOverride?: bigint;
}

/** 一个基点是百分之一百分点，转换成百分比时保留两位小数。 One basis point is one hundredth of a percentage point, so percentages use two decimal places. */
const basisPointDecimals = 2;

/**
 * 展示资金池的现金、可借金额、未偿债务、利用率和年化利率。
 * Display pool cash, available borrowing, outstanding debt, utilization, and annualized rates.
 *
 * @param props 已选市场与相应的资金池观测。 Selected market and its corresponding pool observation.
 * @returns 资金池指标的定义列表及 UTC 观测时间。 Pool metrics definition list and UTC observation time.
 */
export function LendingPoolMetrics({ market, snapshot, cashOverride }: LendingPoolMetricsProps) {
  /** 指标标签、金额和时间使用当前界面语言。 Use the active interface language for metric labels, amounts, and time. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 借款资产的精度来自登记的 Mint，简称缺失时仍可查看完整的 Mint。 Asset precision comes from the registered debt mint, whose full address remains available if the ticker is missing. */
  const { mint, symbol, decimals } = market.debtAsset;
  const assetUnit = symbol?.trim() || mint.slice(0, 4) + '…' + mint.slice(-4);
  /** 观测时间统一显示为 UTC，旧数据保留原来的观测时刻。 Display the original observation time in UTC, including older observations. */
  const observationTime = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(snapshot.observedAt));
  const observationLabel = snapshot.freshness === 'STALE' ? 'lendingPool.previousObservation' : 'lendingPool.observedAt';

  /** 可借金额和债务取索引，现金可取更新的链上观测。 Borrowable amounts and debt use the index, and cash can use a newer live observation. */
  const amounts = [
    { label: 'cash', raw: cashOverride ?? snapshot.cashRaw },
    { label: 'availableToBorrow', raw: snapshot.availableToBorrowRaw },
    { label: 'totalDebt', raw: snapshot.totalDebtRaw },
  ] as const;
  /** 利用率和年化利率的单位均为基点。 Utilization and annualized rates are expressed in basis points. */
  const rates = [
    { label: 'utilization', bps: snapshot.utilizationBps },
    { label: 'borrowApr', bps: snapshot.borrowRateBps },
    { label: 'supplyApr', bps: snapshot.supplyRateBps },
  ] as const;

  return (
    <>
      <p className="lending-pool-metrics__observation">
        <time dateTime={snapshot.observedAt}>{t(observationLabel, { time: observationTime })}</time>
      </p>
      <dl className="lending-pool-metrics">
        {amounts.map(({ label, raw }) => (
          <div key={label}>
            <dt>{t('lendingPool.' + label)}</dt>
            <dd>{formatTokenAmount(raw, decimals, locale)} <span title={mint}>{assetUnit}</span></dd>
          </div>
        ))}
        {rates.map(({ label, bps }) => (
          <div key={label}>
            <dt>{t('lendingPool.' + label)}</dt>
            {/* 基点已经是定点整数，直接移动小数点可以精确显示百分比。 */}
            {/* Basis points are already fixed-point integers, so shifting the decimal point preserves the exact percentage. */}
            <dd>{formatTokenAmount(BigInt(bps), basisPointDecimals, locale)}%</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

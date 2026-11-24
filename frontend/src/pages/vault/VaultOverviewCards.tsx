import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { VaultListItem } from '../../features/vault/api/listVaults';
import { formatVaultAmount, formatVaultNavPerShare } from '../../features/vault/vaultAmounts';
import './styles/vault-overview-cards.css';

/** 页面所选的金库及同一次读数。 Selected vault and its single observed snapshot. */
interface VaultOverviewCardsProps {
  /** 已登记的金库以及它的计价资产、份额资产和最新快照。 Registered vault with its quote asset, share asset, and latest snapshot. */
  vault: VaultListItem;
}

/** 定义列表中一项指标的名称及已格式化内容。 Label and formatted value for one definition-list metric. */
interface VaultMetricProps {
  /** 当前语言的指标名称。 Metric label in the selected language. */
  label: string;
  /** 包含单位的数值或可用性文案。 Formatted value with its unit, or availability text. */
  value: ReactNode;
}

/**
 * 渲染金库概况中的一项指标。
 * Render one metric in the vault overview.
 *
 * @param props 指标名称与对应内容。 Metric label and its corresponding value.
 */
function VaultMetric({ label, value }: VaultMetricProps) {
  return (
    <div className="vault-overview-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * 在金库页右侧依次展示资产估值和即时赎回资金来源。
 * Display vault valuation followed by immediate redemption funding in the right column.
 *
 * @param props 当前选中的金库及其观测结果。 Selected vault and its observed snapshot.
 */
export function VaultOverviewCards({ vault }: VaultOverviewCardsProps) {
  /** 指标翻译和数值格式使用同一界面语言。 Use the same UI language for metric translations and numeric formatting. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 唯一区域标题前缀，用于将每组数据与可访问名称关联。 Unique heading prefix linking each metric group to its accessible name. */
  const headingId = useId();
  /** 结算单位、份额单位与最新的记录可能尚未同步。 Settlement units, share units, and the latest snapshot, which may be unavailable. */
  const { latestSnapshot: snapshot, quoteAsset, shareAsset } = vault;
  /** 结算资产无简称时缩写 Mint，同时在数字旁保留完整地址提示。 Use an abbreviated mint when no ticker exists, keeping the full address in its tooltip. */
  const quoteUnit = quoteAsset.symbol || quoteAsset.mint.slice(0, 4) + '…' + quoteAsset.mint.slice(-4);
  /** 接口返回空值时使用的可用性文案。 Availability text for a null API value. */
  const unavailable = t('vaultOverview.unavailable');
  /** 将该组指标的同一个采集时间显示为 UTC。 Display the shared observation time in UTC. */
  const observationTime = snapshot === null ? null : new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(snapshot.observedAt));

  /**
   * 为已格式化的金额附上结算资产单位。
   * Append the settlement unit to an already formatted amount.
   *
   * @param amount 使用当前语言格式化的金额。 Amount formatted for the current locale.
   * @returns 带结算资产简称或 Mint 缩写的金额。 Amount with the settlement ticker or abbreviated mint.
   */
  function withQuoteUnit(amount: string) {
    return <>{amount} <span title={quoteAsset.mint}>{quoteUnit}</span></>;
  }

  /**
   * 用结算资产精度格式化金额，并保留不可用与实际零金额的区别。
   * Format an amount using settlement precision and distinguish unavailable values from real zero amounts.
   *
   * @param raw 结算资产最小单位的整数字符串，缺少估值时为 null。 Integer base-unit string, or null when valuation is unavailable.
   * @returns 带结算资产简称的金额或可用性文案。 Amount with its settlement ticker, or availability text.
   */
  function quoteAmount(raw: string | null): ReactNode {
    return raw === null ? unavailable : withQuoteUnit(formatVaultAmount(raw, quoteAsset.decimals, locale));
  }

  /** 用金库净值和总份额算出每一份的价值，零份额时显示原因。 Compute NAV per share from vault value and share supply, explaining a zero supply. */
  let navPerShare: ReactNode = unavailable;
  if (snapshot !== null) {
    if (BigInt(snapshot.totalSharesRaw) === 0n) {
      navPerShare = t('vaultOverview.noIssuedShares');
    } else if (snapshot.navRaw !== null) {
      navPerShare = withQuoteUnit(formatVaultNavPerShare(
        snapshot.navRaw, snapshot.totalSharesRaw, quoteAsset.decimals, shareAsset.decimals, locale,
      ));
    }
  }
  /** 立即可付的资产仅含同一观测中的现金和借贷池可取回部分，以计价 Mint 最小单位计算。 Immediate liquidity includes cash and currently withdrawable lending funds at the same observation, in quote base units. */
  const paymentLimitRaw = snapshot === null ? null
    : (BigInt(snapshot.cashRaw) + BigInt(snapshot.lendingWithdrawableRaw)).toString();

  return (
    <div className="vault-overview-metrics">
      <section className="vault-overview-panel vault-overview-panel--assets" aria-labelledby={headingId + '-assets'}>
        <h2 id={headingId + '-assets'}>{t('vaultOverview.assetsAndNav')}</h2>
        {snapshot === null ? (
          <p className="vault-overview-awaiting" role="status">{t('vaultOverview.awaitingSnapshot')}</p>
        ) : (
          <>
            <time className="vault-overview-observation" dateTime={snapshot.observedAt}>
              {t('vaultOverview.updatedAt', { time: observationTime })}
            </time>
            <dl>
              <VaultMetric label={t('vaultOverview.nav')} value={quoteAmount(snapshot.navRaw)} />
              <VaultMetric
                label={shareAsset.symbol
                  ? t('vaultOverview.navPerShare', { share: shareAsset.symbol })
                  : t('vaultOverview.navPerShareDefault')}
                value={navPerShare}
              />
              <VaultMetric label={t('vaultOverview.cash')} value={quoteAmount(snapshot.cashRaw)} />
              <VaultMetric label={t('vaultOverview.lendingValue')} value={quoteAmount(snapshot.lendValueRaw)} />
              <VaultMetric label={t('vaultOverview.strategyValue')} value={quoteAmount(snapshot.strategyValueRaw)} />
            </dl>
          </>
        )}
      </section>
      <section className="vault-overview-panel vault-overview-panel--funding" aria-labelledby={headingId + '-funding'}>
        <h2 id={headingId + '-funding'}>{t('vaultOverview.redemptionFunding')}</h2>
        <p className="vault-overview-funding-note">
          {t(vault.lendingMarketAddress ? 'vaultOverview.fundingLending' : 'vaultOverview.fundingCash', { asset: quoteUnit })}
          {vault.strategyAsset && <> {t('vaultOverview.fundingStrategy', { asset: quoteUnit })}</>}
        </p>
        {snapshot?.freshness === 'STALE' && <p className="vault-overview-observation">{t('vaultOverview.previousEstimate')}</p>}
        {snapshot === null ? (
          <p className="vault-overview-awaiting">{unavailable}</p>
        ) : (
          <dl>
            <VaultMetric label={t('vaultOverview.redeemCash')} value={quoteAmount(snapshot.cashRaw)} />
            <VaultMetric label={t('vaultOverview.lendingWithdrawable')} value={quoteAmount(snapshot.lendingWithdrawableRaw)} />
            <VaultMetric label={t('vaultOverview.paymentLimit')} value={quoteAmount(paymentLimitRaw)} />
          </dl>
        )}
      </section>
    </div>
  );
}

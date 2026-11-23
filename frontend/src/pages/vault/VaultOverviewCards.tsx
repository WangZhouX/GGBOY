import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { VaultAsset, VaultLatestSnapshot, VaultListItem } from '../../features/vault/api/listVaults';
import { formatVaultAmount, formatVaultNavPerShare } from '../../features/vault/vaultAmounts';
import './styles/vault-overview-cards.css';

/** 策略金库列表中的一项及其快照。 One strategy vault entry with its snapshot. */
interface VaultOverviewCardsProps {
  /** 来自金库概况接口的金库信息。 Vault information from the overview API. */
  vault: VaultListItem;
}

/** 已同步快照及其计价单位。 Synchronized snapshot and its valuation units. */
interface VaultSnapshotCardsProps {
  /** 仅在金库已经有快照时渲染明细。 Render details only when the vault has a snapshot. */
  snapshot: VaultLatestSnapshot;
  /** 结算资产提供金额精度和简称。 Settlement asset providing the amount precision and ticker. */
  quoteAsset: VaultAsset;
  /** 份额资产提供份额总量的精度和简称。 Share asset providing the share precision and ticker. */
  shareAsset: VaultAsset;
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
 * 显示同一快照中的净值、资产构成和金库可支付的资金。
 * Present NAV, asset composition, and payment liquidity from the same snapshot.
 *
 * @param props 已同步快照及其结算和份额资产。 Synchronized snapshot with its settlement and share assets.
 */
function VaultSnapshotCards({ snapshot, quoteAsset, shareAsset }: VaultSnapshotCardsProps) {
  /** 指标翻译和数值格式使用同一界面语言。 Use the same UI language for metric translations and numeric formatting. */
  const { t, i18n } = useTranslation();
  /** 金额分组、小数分隔符和显示精度使用的区域语言。 Locale used for grouping and decimal separators. */
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 接口返回空值时使用的可用性文案。 Availability text for a null API value. */
  const unavailable = t('vaultOverview.unavailable');
  /** 结算资产简称为空时，缩写 Mint 并提供完整地址。 Use an abbreviated mint with the full address available when no ticker exists. */
  const quoteUnit = quoteAsset.symbol || quoteAsset.mint.slice(0, 4) + '…' + quoteAsset.mint.slice(-4);

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
    return raw === null
      ? unavailable
      : withQuoteUnit(formatVaultAmount(raw, quoteAsset.decimals, locale));
  }

  /** 有份额且有估值时，以展示份额为分母计算每份净值。 Divide by display-unit shares only when shares and a valuation exist. */
  let navPerShare: ReactNode = unavailable;
  if (BigInt(snapshot.totalSharesRaw) === 0n) {
    navPerShare = t('vaultOverview.noIssuedShares');
  } else if (snapshot.navRaw !== null) {
    /** 每个完整展示份额对应的结算资产金额。 Settlement asset amount per whole display share. */
    const formatted = formatVaultNavPerShare(
      snapshot.navRaw,
      snapshot.totalSharesRaw,
      quoteAsset.decimals,
      shareAsset.decimals,
      locale,
    );
    navPerShare = withQuoteUnit(formatted);
  }

  // 支付上限仅计入同一快照中的闲置现金和可取回资金，保持整数精度。
  // Use only cash and lending withdrawals from the same snapshot, retaining integer precision.
  const paymentLimitRaw = (BigInt(snapshot.cashRaw) + BigInt(snapshot.lendingWithdrawableRaw)).toString();
  /** 数据仍是上次读取的结果时，用标题明确区分赎回资金估算。 Label redemption funding as a previous estimate when it comes from an older read. */
  const fundingTitle = snapshot.freshness === 'STALE'
    ? t('vaultOverview.previousRedemptionFunding')
    : t('vaultOverview.redemptionFunding');

  return (
    <div className="vault-overview-grid">
      <section className="vault-overview-panel vault-overview-panel--assets">
        <h4>{t('vaultOverview.assetsAndNav')}</h4>
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
      </section>
      <section className="vault-overview-panel vault-overview-panel--funding">
        <h4>{fundingTitle}</h4>
        <dl>
          <VaultMetric label={t('vaultOverview.redeemCash')} value={quoteAmount(snapshot.cashRaw)} />
          <VaultMetric
            label={t('vaultOverview.lendingWithdrawable')}
            value={quoteAmount(snapshot.lendingWithdrawableRaw)}
          />
          <VaultMetric label={t('vaultOverview.paymentLimit')} value={quoteAmount(paymentLimitRaw)} />
        </dl>
      </section>
    </div>
  );
}

/**
 * 显示一个金库的身份、上次更新时间和概况明细。
 * Show one vault's identity, last update time, and overview metrics.
 *
 * @param props 金库列表中的一项。 An entry from the vault list.
 */
export function VaultOverviewCards({ vault }: VaultOverviewCardsProps) {
  /** 状态文案和观测时间使用当前界面语言。 Use the current UI language for status text and observation times. */
  const { t, i18n } = useTranslation();
  /** 金库最新观测快照，未同步时为空。 Latest observed snapshot, or null while awaiting synchronization. */
  const snapshot = vault.latestSnapshot;
  /** 用中文或英文展示时间，但观测时区统一为 UTC。 Format the time in Chinese or English while keeping the observation in UTC. */
  const observationTime = snapshot === null ? null : new Intl.DateTimeFormat(
    i18n.resolvedLanguage ?? i18n.language,
    {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'UTC',
    },
  ).format(new Date(snapshot.observedAt));

  return (
    <article className="vault-overview-entry">
      <header className="vault-overview-header">
        <div className="vault-overview-identity">
          <h3>{vault.shareAsset.symbol || t('vaultOverview.vaultFallback')}</h3>
          <p className="vault-overview-address">{vault.address}</p>
        </div>
        {snapshot !== null && (
          <time className="vault-overview-observation" dateTime={snapshot.observedAt}>
            {t('vaultOverview.updatedAt', { time: observationTime })}
          </time>
        )}
      </header>
      {snapshot === null ? (
        <p className="vault-overview-awaiting">{t('vaultOverview.awaitingSnapshot')}</p>
      ) : (
        <VaultSnapshotCards
          snapshot={snapshot}
          quoteAsset={vault.quoteAsset}
          shareAsset={vault.shareAsset}
        />
      )}
    </article>
  );
}

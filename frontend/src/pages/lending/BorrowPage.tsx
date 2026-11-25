import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { lendingLocation } from '../../features/lending/LendingNavigation';
import { isDevnetBorrowMarket } from '../../features/lending/useDevnetBorrowPosition';
import { useLendingPosition } from '../../features/lending/useLendingPosition';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { paths } from '../../shared/navigation/paths';
import type { DevnetBorrowPosition } from '../../solana/lending/borrowLendingPosition';
import { lendingFixedAprBps } from '../../solana/lending/lendingInterest';
import { PageLayout } from '../../shared/ui/PageLayout';
import { BorrowLimitGuidance } from './BorrowLimitGuidance';
import { LendingBorrowActivitySection } from './LendingBorrowActivitySection';
import { LendingPositionMetrics, LendingPositionView } from './LendingPositionView';
import { formatPositionAmount, formatPositionDecimal, positionAssetLabel } from './positionValues';

/** 操作以仓位建立到结清的业务顺序排列，路径对应各自的交易表单。 Actions follow the position lifecycle and point to their own transaction form. */
const positionOperations = [
  { action: 'depositCollateral', slug: 'collateral' },
  { action: 'borrow', slug: 'borrow' },
  { action: 'repay', slug: 'repay' },
  { action: 'withdrawCollateral', slug: 'withdraw' },
] as const;

/**
 * 在个人仓位下展示 Devnet 借款流程的四个入口。
 * Render the four Devnet borrowing entry points under the wallet position.
 *
 * @param props 已登记市场，用于在操作间保留网络和市场。 Registered market, preserving selection across operations.
 */
function BorrowActions({ market }: { market: LendingMarketListItem }) {
  const { t } = useTranslation();

  return (
    <div className="lending-position__operations">
      <h3>{t('lendingBorrow.operationsTitle')}</h3>
      <ul className="lending-position__operation-list">
        {positionOperations.map(({ action, slug }) => (
          <li key={action}>
            <h4>{t(`lendingBorrow.operations.${action}.title`)}</h4>
            <p className="lending-position__note">{t(`lendingBorrow.operations.${action}.description`)}</p>
            <Link
              className="lending-position__button"
              to={lendingLocation(paths.borrowOperation.replace(':action', slug), market.network, market.address)}
            >
              {t(`lendingBorrow.operations.${action}.action`)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 展示钱包实有抵押品、未偿借款和可用额度。阅读中的空值表示当前缺少有效报价输入。
 * Show actual collateral, outstanding borrowing and available limits, with missing values for unavailable quotes.
 *
 * @param props 已确认链上观测和用于格式化金额的市场资产。 Finalized chain observation and market assets used to format amounts.
 */
function LiveBorrowBalances({ observation, market }: { observation: DevnetBorrowPosition; market: LendingMarketListItem }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 代币余额及额度按对应 Mint 精度展示，健康度为六位定点倍数。 Amounts use the relevant mint precision, and health is a six-decimal ratio. */
  const { collateralAsset, debtAsset } = market;
  const unavailable = t('lendingPosition.unavailable');
  const health = observation.debtRaw === 0n ? t('lendingPosition.noDebt')
    : observation.healthFactorE6 === null ? unavailable : formatTokenAmount(observation.healthFactorE6, 6, locale);

  return (
    <LendingPositionMetrics rows={[
      { label: t('lendingPosition.collateral'), value: formatPositionAmount(observation.collateralRaw.toString(), collateralAsset, locale) },
      { label: t('lendingPosition.debt'), value: formatPositionAmount(observation.debtRaw.toString(), debtAsset, locale) },
      { label: t('lendingPosition.maxBorrow'), value: observation.maxBorrowRaw === null ? unavailable : formatPositionAmount(observation.maxBorrowRaw.toString(), debtAsset, locale) },
      { label: t('lendingBorrow.limitGuidance.poolAvailable'), value: formatPositionAmount(observation.availableToBorrowRaw.toString(), debtAsset, locale) },
      { label: t('lendingPosition.maxCollateralWithdraw'), value: observation.maxWithdrawRaw === null ? unavailable : formatPositionAmount(observation.maxWithdrawRaw.toString(), collateralAsset, locale) },
      { label: t('lendingPosition.healthFactor'), value: health },
      { label: t('lendingBorrow.walletCollateral'), value: formatPositionAmount(observation.collateralBalanceRaw.toString(), collateralAsset, locale) },
      { label: t('lendingBorrow.walletDebt', { symbol: positionAssetLabel(debtAsset) }), value: formatPositionAmount(observation.debtBalanceRaw.toString(), debtAsset, locale) },
    ]} />
  );
}

/**
 * 以当前市场的测试预言机和链上风控口径渲染风险条件。
 * Render risk terms using the market's test oracle and on-chain limits.
 *
 * @param props 单个最终确认 slot 中的价格、两种资产和仓位。 Price, assets, and position sampled at one finalized slot.
 */
function LiveBorrowRisk({ observation, market }: { observation: DevnetBorrowPosition; market: LendingMarketListItem }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 过期和缺失报价由专门状态说明，过期价格不参与已显示的实时指标。 Report expired and absent quotes explicitly, excluding expired prices from current metrics. */
  const priceStatus = observation.priceStatus;
  const unavailable = t('lendingPosition.unavailable');
  const priceUnit = positionAssetLabel(market.debtAsset) + ' / ' + positionAssetLabel(market.collateralAsset);
  const publishedAt = observation.pricePublishedAt === null ? undefined : new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(observation.pricePublishedAt * 1000));

  return (
    <section className="lending-position__section" aria-labelledby="lending-position-risk">
      <h2 id="lending-position-risk">{t('lendingPosition.riskTitle')}</h2>
      {priceStatus !== 'fresh' && (
        <p className="lending-position__note" role="status">{t(priceStatus === 'stale' ? 'lendingBorrow.priceStale' : 'lendingBorrow.priceMissing')}</p>
      )}
      <LendingPositionMetrics rows={[
        { label: t('lendingPosition.collateralPrice'), value: priceStatus !== 'fresh' || observation.priceRaw === null ? unavailable : formatTokenAmount(observation.priceRaw, market.debtAsset.decimals, locale) + ' ' + priceUnit },
        { label: t('lendingPosition.borrowLtv'), value: formatTokenAmount(observation.borrowLtvBps, 2, locale) + '%' },
        ...(observation.interestEnabled ? [{ label: t('lendingBorrow.fixedApr'), value: formatTokenAmount(lendingFixedAprBps, 2, locale) + '%' }] : []),
        { label: t('lendingPosition.liquidationThreshold'), value: formatTokenAmount(observation.liquidationLtvBps, 2, locale) + '%' },
        { label: t('lendingPosition.currentLtv'), value: observation.currentLtvBps === null ? unavailable : formatTokenAmount(observation.currentLtvBps, 2, locale) + '%' },
        { label: t('lendingPosition.liquidationPrice'), value: observation.liquidationPriceRaw === null ? unavailable : formatTokenAmount(observation.liquidationPriceRaw, market.debtAsset.decimals, locale) + ' ' + priceUnit },
      ]} />
      {publishedAt && <p className="lending-position__note">{t('lendingBorrow.pricePublishedAt', { time: publishedAt })}</p>}
    </section>
  );
}

/**
 * 对应「我的借款」，展示钱包的抵押资产、债务、额度和观测时风险。
 * Render My Borrowing with the wallet's collateral, debt, limits, and observed risk.
 */
export function BorrowPage() {
  /** 指标与数值格式按当前语言生成。 Generate metric labels and number formatting for the current language. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const unavailable = t('lendingPosition.unavailable');
  /** 已登记的 Devnet 市场直接读链，其余市场展示现有的索引仓位。 Read the registered Devnet market directly and retain indexed positions for other markets. */
  const state = useLendingPosition();
  const observation = state.liveBorrow?.data;
  const snapshot = state.liveBorrow ? undefined : state.position.data?.snapshot;
  const market = state.selected;

  /** 构建仓位和风险两组内容，未采集时由查询状态区给出提示。 Build the position and risk groups, leaving unobserved state to the query status view. */
  let borrowing;
  let risk;
  if (market && snapshot) {
    /** 抵押品和债务可能有不同的 Mint 精度。 Collateral and debt can have different mint precisions. */
    const { collateralAsset, debtAsset } = market;
    /** 健康度与清算标记均为观测结果，不能据此确认现时清算资格。 Health and liquidation flags are historical observations and do not establish present eligibility. */
    const health = snapshot.healthFactor !== null ? formatPositionDecimal(snapshot.healthFactor, locale)
      : BigInt(snapshot.debtRaw) === 0n ? t('lendingPosition.noDebt') : unavailable;
    const liquidation = snapshot.isLiquidatable === null ? unavailable
      : t(snapshot.isLiquidatable ? 'lendingPosition.liquidationEligible' : 'lendingPosition.liquidationIneligible');
    borrowing = (
      <LendingPositionMetrics rows={[
        { label: t('lendingPosition.collateral'), value: formatPositionAmount(snapshot.collateralRaw, collateralAsset, locale) },
        { label: t('lendingPosition.debt'), value: formatPositionAmount(snapshot.debtRaw, debtAsset, locale) },
        { label: t('lendingPosition.maxBorrow'), value: snapshot.maxBorrowRaw === null ? unavailable : formatPositionAmount(snapshot.maxBorrowRaw, debtAsset, locale) },
        { label: t('lendingPosition.maxCollateralWithdraw'), value: snapshot.maxCollateralWithdrawRaw === null ? unavailable : formatPositionAmount(snapshot.maxCollateralWithdrawRaw, collateralAsset, locale) },
        { label: t('lendingPosition.healthFactor'), value: health },
        { label: t('lendingPosition.liquidationAtObservation'), value: liquidation },
      ]} />
    );

    /** 风险参数来自相同 slot 的市场观测，不从其他 slot 补值。 Risk parameters come from the same observed market slot, without filling gaps from a different slot. */
    const rules = snapshot.marketRisk;
    const collateralPrice = rules?.collateralPrice ?? null;
    const currentLtv = rules?.currentLtv ?? null;
    const liquidationPrice = rules?.liquidationPrice ?? null;
    /** 价格为每一整单位抵押资产对应的借款资产量。 A price is the amount of debt tokens per whole collateral token. */
    const priceUnit = positionAssetLabel(debtAsset) + ' / ' + positionAssetLabel(collateralAsset);
    risk = (
      <section className="lending-position__section" aria-labelledby="lending-position-risk">
        <h2 id="lending-position-risk">{t('lendingPosition.riskTitle')}</h2>
        <p className="lending-position__note">{t('lendingPosition.riskHelp')}</p>
        <LendingPositionMetrics rows={[
          { label: t('lendingPosition.collateralPrice'), value: collateralPrice === null ? unavailable : formatPositionDecimal(collateralPrice, locale) + ' ' + priceUnit },
          // 借款上限和清算阈值由服务端用基点返回。两位小数换算为百分比，保留精度。
          // Borrowing and liquidation thresholds arrive as basis points. Shift two decimals to express percentage points exactly.
          { label: t('lendingPosition.borrowLtv'), value: rules ? formatTokenAmount(BigInt(rules.borrowLtvBps), 2, locale) + '%' : unavailable },
          { label: t('lendingPosition.liquidationThreshold'), value: rules ? formatTokenAmount(BigInt(rules.liquidationThresholdBps), 2, locale) + '%' : unavailable },
          { label: t('lendingPosition.currentLtv'), value: currentLtv === null ? unavailable : formatPositionDecimal(currentLtv, locale, true) },
          { label: t('lendingPosition.liquidationPrice'), value: liquidationPrice === null ? unavailable : formatPositionDecimal(liquidationPrice, locale) + ' ' + priceUnit },
        ]} />
      </section>
    );
  }

  if (market && observation) {
    // 空仓也显示实际零值，避免把缺少 PDA 当成数据仍在同步。
    // Show actual zeros for an empty position rather than treating an absent PDA as pending data.
    borrowing = (
      <>
        <LiveBorrowBalances observation={observation} market={market} />
        {!state.liveBorrow?.isError && <BorrowLimitGuidance observation={observation} market={market} />}
      </>
    );
    risk = <LiveBorrowRisk observation={observation} market={market} />;
  }

  return (
    <PageLayout title={t('pages.borrow.title')} description={t('pages.borrow.description')}>
      <LendingPositionView
        title={t('lendingPosition.borrowTitle')}
        state={state}
        aside={risk}
        actions={isDevnetBorrowMarket(market) && <BorrowActions market={market} />}
      >
        {borrowing}
      </LendingPositionView>
      {market && state.walletAddress && observation && (
        <LendingBorrowActivitySection market={market} walletAddress={state.walletAddress} minContextSlot={observation.slot} />
      )}
    </PageLayout>
  );
}

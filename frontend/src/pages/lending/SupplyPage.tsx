import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { lendingLocation } from '../../features/lending/LendingNavigation';
import { isDevnetSupplyMarket } from '../../features/lending/useDevnetSupplyPosition';
import { useLendingPosition } from '../../features/lending/useLendingPosition';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import { lendingShareDecimals } from '../../solana/lending/devnetLendingPool';
import { getSupplyWithdrawalLimit, valueSupplyShares } from '../../solana/lending/supplyWithdrawalAmounts';
import { LendingPositionMetrics, LendingPositionView } from './LendingPositionView';
import { formatPositionAmount } from './positionValues';

/**
 * 对应「我的出借」，优先展示已验证的 Devnet 出借份额和对应估值。
 * Render My Supply with verified Devnet shares and their position value where supported.
 */
export function SupplyPage() {
  /** 金额、份额与标题跟随界面语言。 Amounts, shares, and headings follow the interface language. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const unavailable = t('lendingPosition.unavailable');
  /** Devnet 支持的市场读链，其他市场消费现有响应中的出借字段。 Read the supported Devnet market directly and consume indexed supply fields for other markets. */
  const state = useLendingPosition('supply');
  /** 同一钱包的借款请求可能已有缓存，面向 Devnet 出借时只使用链上仓位。 The same wallet may have an indexed borrow cache. Use only live observations for Devnet supply. */
  const snapshot = state.liveSupply ? undefined : state.position.data?.snapshot;
  const liveSupply = state.liveSupply?.data;
  const market = state.selected;
  const debtAsset = market?.debtAsset;

  /** 总仓位估值和当前可提取额度来自同一个最终确认 slot。 Position value and the available withdrawal limit use the same finalized slot. */
  const suppliedValueRaw = liveSupply ? valueSupplyShares(liveSupply, liveSupply.sharesRaw) : 0n;
  const withdrawalLimit = liveSupply && getSupplyWithdrawalLimit(liveSupply);
  /** 旧索引没有发布份额小数位，继续按最小单位展示。 The existing index has no share precision metadata, so keep showing its raw base units. */
  const shareUnit = t('lendingPosition.shareBaseUnits');

  return (
    <PageLayout title={t('pages.supply.title')} description={t('pages.supply.description')}>
      <LendingPositionView
        title={t('lendingPosition.supplyTitle')}
        state={state}
        actions={market && isDevnetSupplyMarket(market) && (
          <div className="lending-position__supply-actions">
            <Link className="lending-position__button lending-position__button--connect"
              to={lendingLocation(paths.supplyDeposit, market.network, market.address)}>
              {t('lendingSupply.action')}
            </Link>
            <Link className="lending-position__button lending-position__button--connect"
              to={lendingLocation(paths.supplyWithdrawal, market.network, market.address)}>
              {t('lendingSupplyWithdrawal.title')}
            </Link>
          </div>
        )}
      >
        {liveSupply && debtAsset && withdrawalLimit && (
          <LendingPositionMetrics rows={[
            { label: t(liveSupply.interestEnabled ? 'lendingPosition.suppliedValueWithInterest' : 'lendingPosition.suppliedValue'),
              value: formatPositionAmount(suppliedValueRaw.toString(), debtAsset, locale) },
            { label: t('lendingPosition.supplyShares'), value: formatTokenAmount(liveSupply.sharesRaw, lendingShareDecimals, locale) + ' ' + t('lendingPosition.sharesUnit') },
            { label: t('lendingPosition.maxSupplyWithdraw'), value: formatPositionAmount(withdrawalLimit.assetsRaw.toString(), debtAsset, locale) },
            { label: t('lendingPosition.maxSupplyWithdrawShares'), value: formatTokenAmount(withdrawalLimit.sharesRaw, lendingShareDecimals, locale) + ' ' + t('lendingPosition.sharesUnit') },
            { label: t('lendingPosition.walletSupplyBalance'), value: formatPositionAmount(liveSupply.walletAssetRaw.toString(), debtAsset, locale) },
          ]} />
        )}
        {snapshot && debtAsset && (
          <LendingPositionMetrics rows={[
            { label: t('lendingPosition.suppliedValue'), value: formatPositionAmount(snapshot.suppliedValueRaw, debtAsset, locale) },
            { label: t('lendingPosition.supplyShares'), value: formatTokenAmount(snapshot.supplySharesRaw, 0, locale) + ' ' + shareUnit },
            { label: t('lendingPosition.maxSupplyWithdraw'), value: snapshot.maxSupplyWithdrawRaw === null ? unavailable : formatPositionAmount(snapshot.maxSupplyWithdrawRaw, debtAsset, locale) },
            { label: t('lendingPosition.maxSupplyWithdrawShares'), value: snapshot.maxSupplyWithdrawSharesRaw === null ? unavailable : formatTokenAmount(snapshot.maxSupplyWithdrawSharesRaw, 0, locale) + ' ' + shareUnit },
          ]} />
        )}
      </LendingPositionView>
    </PageLayout>
  );
}

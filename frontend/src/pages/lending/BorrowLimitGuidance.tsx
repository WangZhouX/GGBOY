import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { lendingLocation } from '../../features/lending/LendingNavigation';
import { paths } from '../../shared/navigation/paths';
import type { DevnetBorrowPosition } from '../../solana/lending/borrowLendingPosition';
import { positionAssetLabel } from './positionValues';
import './styles/borrow-limit-guidance.css';

/**
 * 在已确认的可借额度为零时，说明真实限制并提供对应入口。
 * Explain confirmed zero borrowing capacity and point to the relevant next actions.
 *
 * @param props 同一链上观测及市场登记。 Same-slot on-chain observation and market registration.
 */
export function BorrowLimitGuidance({ observation, market }: {
  observation: DevnetBorrowPosition;
  market: LendingMarketListItem;
}) {
  const { t } = useTranslation();
  if (observation.maxBorrowRaw !== 0n) return null;

  /** 钱包抵押余额与已锁定抵押分别记账，可借资金采用池中实际可用的额度。 Check custody collateral and usable pool funds independently of wallet balances. */
  const noCollateral = observation.collateralRaw === 0n;
  const noLiquidity = observation.availableToBorrowRaw === 0n;
  /** 已锁定抵押和池可借资金都大于零时，只有有效报价才能确认抵押额度已用尽。 Only a fresh quote can establish that collateral capacity is exhausted when both balances are positive. */
  const collateralLimitReached = !noCollateral && !noLiquidity && observation.priceStatus === 'fresh';
  const collateral = positionAssetLabel(market.collateralAsset);
  const debt = positionAssetLabel(market.debtAsset);

  if (!noCollateral && !noLiquidity && !collateralLimitReached) return null;

  return (
    <section className="lending-borrow-guidance">
      <h3>{t('lendingBorrow.limitGuidance.title')}</h3>
      <ul>
        {noCollateral && (
          <li>
            <p>{t(observation.collateralBalanceRaw > 0n
              ? 'lendingBorrow.limitGuidance.collateralRequired'
              : 'lendingBorrow.limitGuidance.collateralUnavailable', { collateral })}</p>
            {observation.collateralBalanceRaw > 0n && (
              <Link className="text-link" to={lendingLocation(paths.borrowOperation.replace(':action', 'collateral'), market.network, market.address)}>
                {t('lendingBorrow.limitGuidance.depositCollateral')}
              </Link>
            )}
          </li>
        )}
        {noLiquidity && (
          <li>
            <p>{t(observation.totalDebtRaw > 0n
              ? 'lendingBorrow.limitGuidance.liquidityWithDebt'
              : 'lendingBorrow.limitGuidance.liquidityUnavailable', { debt })}</p>
            <Link className="text-link" to={lendingLocation(
              observation.debtBalanceRaw > 0n ? paths.supplyDeposit : paths.lending,
              market.network,
              market.address,
            )}>
              {observation.debtBalanceRaw > 0n ? t('lendingBorrow.limitGuidance.supplyLiquidity', { debt })
                : t('lendingBorrow.limitGuidance.viewPool')}
            </Link>
          </li>
        )}
        {collateralLimitReached && (
          <li>
            <p>{t(observation.debtRaw > 0n
              ? 'lendingBorrow.limitGuidance.debtAtLimit'
              : 'lendingBorrow.limitGuidance.collateralTooSmall')}</p>
            {observation.debtRaw > 0n && observation.debtBalanceRaw > 0n && (
              <Link className="text-link" to={lendingLocation(paths.borrowOperation.replace(':action', 'repay'), market.network, market.address)}>
                {t('lendingBorrow.limitGuidance.repay')}
              </Link>
            )}
            {observation.collateralBalanceRaw > 0n && (
              <Link className="text-link" to={lendingLocation(paths.borrowOperation.replace(':action', 'collateral'), market.network, market.address)}>
                {t('lendingBorrow.limitGuidance.addCollateral')}
              </Link>
            )}
          </li>
        )}
      </ul>
    </section>
  );
}

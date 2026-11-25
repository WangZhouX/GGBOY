import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { lendingLocation } from '../../features/lending/LendingNavigation';
import type { VaultAsset } from '../../features/vault/api/listVaults';
import { toLiveVaultPosition } from '../../features/vault/liveVaultView';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { paths } from '../../shared/navigation/paths';
import { lendingShareDecimals } from '../../solana/lending/devnetLendingPool';
import { valueSupplyShares } from '../../solana/lending/supplyWithdrawalAmounts';
import { portfolioReadStatus, useDevnetPortfolio } from './useDevnetPortfolio';
import './styles/devnet-portfolio-positions.css';

/** 总览的一项显示金额。 One displayed amount in the portfolio overview. */
interface PortfolioAmount {
  /** 指标标题。 Metric label. */
  label: string;
  /** 精确格式化后的值，当前不能展示时为空。 Exactly formatted value, or null when unavailable. */
  value: string | null;
}

/**
 * 根据登记 Mint 精度与界面语言显示最小单位金额。
 * Display a base-unit amount using the registered mint precision and interface locale.
 *
 * @param raw 链上最小单位数量，缺少估值时为空。 On-chain base units, or null when valuation is unavailable.
 * @param asset 该金额对应的 Mint、精度和简称。 The amount's mint, decimal precision, and ticker.
 * @param locale 界面语言。 Interface locale.
 * @returns 金额与币种；缺少估值时为空。 Amount with ticker, or null when valuation is unavailable.
 */
function formatAssetAmount(raw: string | bigint | null, asset: VaultAsset, locale: string): string | null {
  /** 未配置简称时，使用公开 Mint 的短标识。 Use a short public mint identifier when no ticker is configured. */
  const symbol = asset.symbol?.trim() || asset.mint.slice(0, 4) + '…' + asset.mint.slice(-4);
  return raw === null ? null : formatTokenAmount(raw, asset.decimals, locale) + ' ' + symbol;
}

/**
 * 渲染一组同类资产金额及对应详情链接。
 * Render related asset amounts and their detail link.
 *
 * @param props 区块标题、已格式化金额、查询状态和可选详情。 Section title, formatted amounts, query status, and optional details.
 */
function PortfolioCard({ title, amounts, status, details }: {
  title: string;
  amounts: PortfolioAmount[];
  status?: ReturnType<typeof portfolioReadStatus>;
  details?: { href: string; label: string };
}) {
  /** 缺失估值与查询状态使用当前界面语言。 Localize unavailable valuations and query statuses. */
  const { t } = useTranslation();
  /** 失败提示用警示角色，加载和目录空状态用普通状态提示。 Announce failures as alerts and loading or empty registry messages as status updates. */
  const failed = status === 'readError' || status === 'registryError';

  return (
    <article className="portfolio-card">
      <h3>{title}</h3>
      {status && (
        <p className={failed ? 'portfolio-card__status portfolio-card__status--error' : 'portfolio-card__status'} role={failed ? 'alert' : 'status'}>
          {t('overview.portfolio.' + status)}
        </p>
      )}
      {amounts.length > 0 && (
        <dl>
          {amounts.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value ?? t('overview.portfolio.unavailable')}</dd>
            </div>
          ))}
        </dl>
      )}
      {details && <Link className="portfolio-card__link" to={details.href}>{details.label}</Link>}
    </article>
  );
}

/**
 * 汇总同一个 Devnet 钱包的可用代币和链上仓位。
 * Summarize the spendable tokens and on-chain positions of one Devnet wallet.
 *
 * @param props 已连接钱包的 Devnet 公钥。 Connected wallet's Devnet public key.
 */
export function DevnetPortfolioPositions({ walletAddress }: { walletAddress: string }) {
  /** 金额和状态与当前界面语言一致。 Format amounts and status copy in the current interface locale. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 各区块使用已核验的数据；新请求失败时隐藏该来源的旧观测。 Use verified observations and hide that source's cached amounts when its latest read fails. */
  const { vaultCatalog, marketCatalog, vault, market, vaultRead, supplyRead, borrowRead, refresh, isRefreshing } =
    useDevnetPortfolio(walletAddress);
  const vaultState = vaultRead.isSuccess ? vaultRead.data : undefined;
  const supply = supplyRead.isSuccess ? supplyRead.data : undefined;
  const borrow = borrowRead.isSuccess ? borrowRead.data : undefined;
  const vaultPosition = vaultState && toLiveVaultPosition(vaultState, false);
  const vaultStatus = portfolioReadStatus(vaultCatalog, vault !== undefined, vaultRead);
  const supplyStatus = portfolioReadStatus(marketCatalog, market !== undefined, supplyRead);
  const borrowStatus = portfolioReadStatus(marketCatalog, market !== undefined, borrowRead);

  /** 同一 mockUSDC 关联账户只显示一次。优先使用较新已最终确认的借贷读数，其次使用金库读数。 Display the mockUSDC ATA once. Prefer the newer finalized lending observation, then fall back to the vault observation. */
  const useBorrowBalance = borrow !== undefined && (supply === undefined || borrow.slot >= supply.slot);
  const walletDebtBalance = (useBorrowBalance ? borrow.debtBalanceRaw : supply?.walletAssetRaw) ?? vaultState?.wallet?.assetBalanceRaw;
  const walletCollateralBalance = borrow?.collateralBalanceRaw;
  const walletDebtAsset = useBorrowBalance || supply ? market?.debtAsset : vault?.quoteAsset;
  const walletAmounts: PortfolioAmount[] = [];
  if (walletDebtBalance !== undefined && walletDebtAsset) {
    walletAmounts.push({ label: t('overview.portfolio.stablecoin'), value: formatAssetAmount(walletDebtBalance, walletDebtAsset, locale) });
  }
  if (walletCollateralBalance !== undefined && market) {
    walletAmounts.push({ label: t('overview.portfolio.collateralToken'), value: formatAssetAmount(walletCollateralBalance, market.collateralAsset, locale) });
  }

  /** 同一金库的估值与份额来自同一个 slot；借贷仓位独立展示，不合计为钱包余额。 Vault shares and valuation come from the same slot. Lending positions are shown independently from spendable wallet balances. */
  const vaultAmounts = vault && vaultPosition ? [
    { label: t('overview.portfolio.vaultShares'), value: formatAssetAmount(vaultPosition.sharesRaw, vault.shareAsset, locale) },
    { label: t('overview.portfolio.vaultValue'), value: formatAssetAmount(vaultPosition.positionValueRaw, vault.quoteAsset, locale) },
  ] : [];
  const supplyAmounts = market && supply ? [
    { label: t('lendingPosition.supplyShares'), value: formatTokenAmount(supply.sharesRaw, lendingShareDecimals, locale) + ' ' + t('lendingPosition.sharesUnit') },
    { label: t('lendingPosition.suppliedValue'), value: formatAssetAmount(valueSupplyShares(supply, supply.sharesRaw), market.debtAsset, locale) },
  ] : [];
  const borrowAmounts = market && borrow ? [
    { label: t('lendingPosition.collateral'), value: formatAssetAmount(borrow.collateralRaw, market.collateralAsset, locale) },
    { label: t('lendingPosition.debt'), value: formatAssetAmount(borrow.debtRaw, market.debtAsset, locale) },
  ] : [];

  /** 详情链接带上读取时核对的部署和网络。 Detail links carry the verified deployment and network used for the read. */
  const vaultHref = vault && paths.vault + '?' + new URLSearchParams({ network: 'devnet', vault: vault.address });

  return (
    <section className="devnet-portfolio" aria-labelledby="devnet-portfolio-title">
      <header className="devnet-portfolio__header">
        <h2 id="devnet-portfolio-title">{t('overview.portfolio.title')}</h2>
        <button type="button" onClick={refresh} disabled={isRefreshing}>{t('overview.portfolio.refresh')}</button>
      </header>
      <div className="devnet-portfolio__grid">
        <PortfolioCard title={t('overview.portfolio.wallet')} amounts={walletAmounts} status={borrowStatus} />
        <PortfolioCard title={t('pages.vault.title')} amounts={vaultAmounts} status={vaultStatus}
          details={vaultHref ? { href: vaultHref, label: t('overview.portfolio.viewVault') } : undefined} />
        <PortfolioCard title={t('pages.supply.title')} amounts={supplyAmounts} status={supplyStatus}
          details={market && { href: lendingLocation(paths.supply, 'devnet', market.address), label: t('overview.portfolio.viewSupply') }} />
        <PortfolioCard title={t('pages.borrow.title')} amounts={borrowAmounts} status={borrowStatus}
          details={market && { href: lendingLocation(paths.borrow, 'devnet', market.address), label: t('overview.portfolio.viewBorrow') }} />
      </div>
    </section>
  );
}

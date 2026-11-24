import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import { VaultDepositSection } from './VaultDepositSection';
import { VaultRedeemSection } from './VaultRedeemSection';
import { useVaultRoute } from './VaultRouteLayout';
import './styles/vault-page.css';

/** 对应存入或赎回两个独立路由的操作。 Operation represented by each dedicated deposit or redemption route. */
interface VaultOperationPageProps {
  /** 由路由确定的存入或赎回动作。 Deposit or redemption selected by the route. */
  action: 'deposit' | 'redeem';
}

/**
 * 为存入或赎回提供独立屏幕，复用已验证的选择和原有链上交易流程。
 * Give deposits and redemptions their own screen using the verified selection and existing on-chain workflow.
 *
 * @param props 当前路由匹配的操作。 Operation matched by the active route.
 */
export function VaultOperationPage({ action }: VaultOperationPageProps) {
  /** 页面文案使用站点选择的语言。 Copy uses the selected site language. */
  const { t } = useTranslation();
  /** 查询、连接状态和交易刷新与策略金库首页共用。 Queries, wallet state and post-confirmation refresh are shared with the overview. */
  const { network, walletAddress, selectedVault, cashVault, unsupportedSelection, catalog, chain, refreshOverview, refreshAfterTransaction } = useVaultRoute();
  /** 从操作页返回时保留当前金库和网络。 Preserve the selected vault and network when returning from an operation. */
  const backSearch = new URLSearchParams({ network });
  if (selectedVault) backSearch.set('vault', selectedVault.address);
  /** 当前路由决定标题、说明和交易组件。 The route determines the heading, description and transaction component. */
  const isDeposit = action === 'deposit';
  const Operation = isDeposit ? VaultDepositSection : VaultRedeemSection;
  /** 钱包或金库变化后重建表单，避免沿用另一作用域的未提交报价。 Reset the form across wallet and vault changes to prevent reuse of another scope's unsent quote. */
  const operationKey = [action, cashVault?.address, walletAddress].join(':');

  useEffect(() => {
    // 从首页深处进入独立流程时回到屏幕顶部，并让辅助技术从正文开始阅读。
    // Start operations at the top when reached from further down the overview and focus the main landmark.
    window.scrollTo(0, 0);
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [action]);

  return (
    <PageLayout
      title={t(isDeposit ? 'vaultDeposit.title' : 'vaultRedeem.title')}
      description={t(isDeposit ? 'vaultFlow.depositDescription' : 'vaultFlow.redeemDescription')}
    >
      <div className="vault-operation__navigation">
        <Link className="text-link" to={paths.vault + '?' + backSearch}>
          <span aria-hidden="true">‹</span> {t('vaultFlow.back')}
        </Link>
      </div>
      {catalog.isPending ? (
        <p className="vault-overview__status" role="status">{t('vaultOverview.loading')}</p>
      ) : !cashVault || unsupportedSelection ? (
        <div className="vault-operation__unavailable">
          <p className="vault-overview__status" role={catalog.isError ? 'alert' : 'status'}>
            {t(catalog.isError ? 'vaultOverview.error' : 'vaultFlow.unavailable')}
          </p>
          {catalog.isError && (
            <button className="vault-overview__refresh" type="button" onClick={refreshOverview} disabled={catalog.isFetching}>
              {t('vaultOverview.retry')}
            </button>
          )}
        </div>
      ) : (
        <div className="vault-operation">
          {chain.isError && (
            <button className="vault-overview__refresh" type="button" onClick={refreshOverview} disabled={chain.isFetching}>
              {t('vaultOverview.refresh')}
            </button>
          )}
          <Operation
            key={operationKey}
            vault={cashVault}
            state={chain.data}
            isReadPending={chain.isPending}
            isReadError={chain.isError}
            refreshAfterDeposit={refreshAfterTransaction}
          />
        </div>
      )}
    </PageLayout>
  );
}

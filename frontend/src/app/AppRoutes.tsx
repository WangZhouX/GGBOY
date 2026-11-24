import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ActivityPage } from '../pages/activity/ActivityPage';
import { ActivityReceiptPage } from '../pages/activity/ActivityReceiptPage';
import { NotFoundPage } from '../pages/errors/NotFoundPage';
import { BorrowPage } from '../pages/lending/BorrowPage';
import { LendingBorrowOperationPage } from '../pages/lending/LendingBorrowOperationPage';
import { LendingSupplyOperationPage } from '../pages/lending/LendingSupplyOperationPage';
import { LendingMarketPage } from '../pages/lending/LendingMarketPage';
import { LiquidationsPage } from '../pages/lending/LiquidationsPage';
import { SupplyPage } from '../pages/lending/SupplyPage';
import { OverviewPage } from '../pages/overview/OverviewPage';
import { StrategyPage } from '../pages/strategy/StrategyPage';
import { VaultOperationPage } from '../pages/vault/VaultOperationPage';
import { VaultPage } from '../pages/vault/VaultPage';
import { VaultRouteLayout } from '../pages/vault/VaultRouteLayout';
import { paths } from '../shared/navigation/paths';
import { AppLayout } from './layout/AppLayout';

/**
 * 将根 URL 导向资产总览，保留原链接携带的查询参数。
 * Route the root URL to the portfolio overview and preserve its query parameters.
 */
function OverviewRedirect() {
  /** 根 URL 携带的查询参数，例如网络。 Search parameters supplied to the root URL, such as the network. */
  const { search } = useLocation();
  return <Navigate replace to={{ pathname: paths.overview, search }} />;
}

/**
 * 将产品地址映射到 pages 中的页面入口。所有页面共用外层布局。
 * Map product URLs to page entries under pages. All routes share the application layout.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<OverviewRedirect />} />
        <Route path={paths.overview} element={<OverviewPage />} />
        <Route path={paths.vault} element={<VaultRouteLayout />}>
          <Route index element={<VaultPage />} />
          <Route path={paths.vaultDeposit} element={<VaultOperationPage action="deposit" />} />
          <Route path={paths.vaultRedeem} element={<VaultOperationPage action="redeem" />} />
        </Route>
        <Route path={paths.lending}>
          <Route index element={<LendingMarketPage />} />
          <Route path={paths.borrow} element={<BorrowPage />} />
          <Route path={paths.borrowOperation} element={<LendingBorrowOperationPage />} />
          <Route path={paths.supply} element={<SupplyPage />} />
          <Route path={paths.supplyDeposit} element={<LendingSupplyOperationPage />} />
          <Route path={paths.supplyWithdrawal} element={<LendingSupplyOperationPage action="withdraw" />} />
          <Route path={paths.liquidations} element={<LiquidationsPage />} />
        </Route>
        <Route path={paths.strategy} element={<StrategyPage />} />
        <Route path={paths.activity}>
          <Route index element={<ActivityPage />} />
          <Route path={paths.activityReceipt} element={<ActivityReceiptPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

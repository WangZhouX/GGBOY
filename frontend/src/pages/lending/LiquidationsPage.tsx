import { useTranslation } from 'react-i18next';
import { LendingNavigation } from '../../features/lending/LendingNavigation';
import { PageLayout } from '../../shared/ui/PageLayout';

/**
 * 渲染清算市场路由，保留借贷业务之间的导航。
 * Render the liquidation market with navigation between lending areas.
 */
export function LiquidationsPage() {
  /** 使用当前语言显示页面标题和说明。 Show the page heading and description in the current language. */
  const { t } = useTranslation();

  return (
    <PageLayout title={t('pages.liquidations.title')} description={t('pages.liquidations.description')}>
      <LendingNavigation />
    </PageLayout>
  );
}

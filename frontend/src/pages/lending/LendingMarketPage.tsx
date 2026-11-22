import { useTranslation } from 'react-i18next';
import { LendingNavigation } from '../../features/lending/LendingNavigation';
import { PageLayout } from '../../shared/ui/PageLayout';

/**
 * 渲染借贷市场概况和共用子导航。
 * Render the market overview and shared lending navigation.
 */
export function LendingMarketPage() {
  /** 使用当前语言显示页面标题和说明。 Show the page heading and description in the current language. */
  const { t } = useTranslation();

  return (
    <PageLayout title={t('pages.lending.title')} description={t('pages.lending.description')}>
      <LendingNavigation />
    </PageLayout>
  );
}

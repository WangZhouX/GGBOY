import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../shared/ui/PageLayout';

/**
 * 渲染策略管理的路由入口。
 * Render the strategy management entry.
 */
export function StrategyPage() {
  /** 使用当前语言显示页面标题和说明。 Show the page heading and description in the current language. */
  const { t } = useTranslation();

  return (
    <PageLayout title={t('pages.strategy.title')} description={t('pages.strategy.description')} />
  );
}

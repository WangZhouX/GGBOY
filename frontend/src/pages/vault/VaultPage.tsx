import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../shared/ui/PageLayout';

/**
 * 渲染策略金库的路由入口。
 * Render the strategy vault entry.
 */
export function VaultPage() {
  /** 使用当前语言显示页面标题和说明。 Show the page heading and description in the current language. */
  const { t } = useTranslation();

  return (
    <PageLayout title={t('pages.vault.title')} description={t('pages.vault.description')} />
  );
}

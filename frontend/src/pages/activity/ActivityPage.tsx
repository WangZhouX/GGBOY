import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../shared/ui/PageLayout';

/**
 * 渲染交易活动列表的路由入口。
 * Render the entry for the transaction activity list.
 */
export function ActivityPage() {
  /** 使用当前语言显示页面标题和说明。 Show the page heading and description in the current language. */
  const { t } = useTranslation();

  return (
    <PageLayout title={t('pages.activity.title')} description={t('pages.activity.description')} />
  );
}

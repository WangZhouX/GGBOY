import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet } from 'react-router';
import { networks, useNetwork, withNetwork } from '../../shared/navigation/network';
import { paths, primaryPages } from '../../shared/navigation/paths';
import { i18n, languages, resolveLanguage } from '../i18n/i18n';
import './AppLayout.css';

/**
 * 提供所有业务路由共用的导航、语言选择、网络选择和正文区。
 * Render the shared navigation, language selector, network selector, and content region for business routes.
 */
export function AppLayout() {
  /** 跟随语言变更重新渲染界面文案。 Render updated copy whenever the selected language changes. */
  const { t } = useTranslation();
  /** 导航与网络选择器都从当前 URL 得到网络。 Read the current network from the URL for links and the selector. */
  const { network, changeNetwork } = useNetwork();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t('layout.skipToContent')}</a>
      <aside className="sidebar">
        <Link className="brand" to={withNetwork(paths.overview, network)}>
          <span className="brand-mark" aria-hidden="true" />
          GGBOY
        </Link>
        <nav className="primary-nav" aria-label={t('layout.navigation')}>
          {primaryPages.map((page) => (
            <NavLink className="nav-link" key={page} to={withNetwork(paths[page], network)}>
              {t('pages.' + page + '.title')}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <label className="topbar-field">
            <span>{t('layout.network')}</span>
            <select value={network} onChange={(event) => changeNetwork(event.currentTarget.value)}>
              {networks.map((option) => (
                <option key={option} value={option}>{t('network.' + option)}</option>
              ))}
            </select>
          </label>
          <label className="topbar-field">
            <span>{t('layout.language')}</span>
            <select
              value={resolveLanguage(i18n.resolvedLanguage)}
              onChange={(event) => void i18n.changeLanguage(resolveLanguage(event.currentTarget.value))}
            >
              {languages.map((language) => (
                <option key={language} value={language} lang={language}>
                  {language === 'zh-CN' ? '简体中文' : 'English'}
                </option>
              ))}
            </select>
          </label>
        </header>
        <main className="main-content" id="main-content" tabIndex={-1}>
          {/* 当前匹配的业务页在这里渲染，外层布局随路由保留。 */}
          {/* The matched business page renders here, while the layout persists across routes. */}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

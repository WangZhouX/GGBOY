import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet } from 'react-router';
import { networks, useNetwork, withNetwork } from '../../shared/navigation/network';
import { paths, primaryPages } from '../../shared/navigation/paths';
import { usePhantomWallet } from '../../solana/phantomWallet';
import { i18n, languages, resolveLanguage } from '../i18n/i18n';
import './AppLayout.css';

/**
 * 提供所有业务路由共用的导航、语言、网络、Phantom 连接入口和正文区。
 * Render the navigation, language, network, Phantom connection, and content shared by business routes.
 */
export function AppLayout() {
  /** 跟随语言变更重新渲染界面文案。 Render updated copy whenever the selected language changes. */
  const { t } = useTranslation();
  /** 导航与网络选择器都从当前 URL 得到网络。 Read the current network from the URL for links and the selector. */
  const { network, changeNetwork } = useNetwork();
  /** 顶栏钱包按钮与业务页面共用的连接状态。 Wallet connection shared by the header button and business pages. */
  const wallet = usePhantomWallet();
  /** 等待钱包处理时禁用按钮，避免重复请求。 Disable the button while Phantom processes an action. */
  const walletActionPending = wallet.status === 'connecting' || wallet.status === 'disconnecting';
  /** 顶栏显示简写公钥，完整公钥由提示提供。 Show a shortened public key in the header and expose the full key in the tooltip. */
  const shortWalletAddress = wallet.walletAddress
    ? `${wallet.walletAddress.slice(0, 4)}…${wallet.walletAddress.slice(-4)}`
    : null;
  /** 按当前状态显示的操作文字。 Action label for the current wallet status. */
  const walletLabel = t({
    disconnected: 'wallet.connect',
    connecting: 'wallet.connecting',
    connected: 'wallet.disconnect',
    disconnecting: 'wallet.disconnecting',
  }[wallet.status]);

  /** 从顶栏连接钱包或断开当前连接。 Connect the wallet or end the current connection from the header. */
  function handleWalletAction() {
    void (wallet.walletAddress ? wallet.disconnect() : wallet.connect());
  }

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
          <div className="topbar-wallet">
            {shortWalletAddress && (
              <span className="topbar-wallet__address" title={t('wallet.connectedAddress', { address: wallet.walletAddress })}>
                {shortWalletAddress}
              </span>
            )}
            <button
              className="topbar-wallet__button"
              type="button"
              onClick={handleWalletAction}
              disabled={walletActionPending}
            >
              {walletLabel}
            </button>
            {wallet.error && <p className="topbar-wallet__error" role="alert">{t(`wallet.${wallet.error}`)}</p>}
          </div>
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

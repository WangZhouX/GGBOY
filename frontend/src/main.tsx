import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { i18nReady } from './app/i18n/i18n';
import './app/styles/global.css';

/**
 * 准备选定语言后把 React 应用挂载到 HTML 入口。
 * Mount the React application in its HTML entry after the selected language is ready.
 */
async function mountApp() {
  /** HTML 入口中声明的 React 挂载节点。 React mount node declared by the HTML entry. */
  const rootElement = document.getElementById('root');

  // 挂载点缺失表示 HTML 入口配置错误。
  // A missing mount node signals an error in the HTML entry.
  if (!rootElement) {
    throw new Error('GGBOY mount node #root was not found.');
  }

  // 先完成翻译初始化，避免首屏闪现翻译键或其他语言。
  // Finish translation setup before rendering so translation keys or another language do not flash.
  await i18nReady;
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void mountApp();

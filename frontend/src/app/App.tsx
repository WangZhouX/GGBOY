import { QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BrowserRouter } from 'react-router';
import { PhantomWalletProvider } from '../solana/phantomWallet';
import { AppRoutes } from './AppRoutes';
import { i18n } from './i18n/i18n';
import { queryClient } from './queryClient';

/**
 * 装配全局翻译、查询缓存、Phantom 钱包和浏览器路由。
 * Compose the global translations, query cache, Phantom wallet, and browser routes.
 */
export function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <PhantomWalletProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </PhantomWalletProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * 启用 React 热更新，并将浏览器的同源 API 请求转给本地后端。
 * Enables React Fast Refresh and proxies same-origin browser API requests to the local backend.
 *
 * @param config Vite 的配置环境，模式决定加载哪个本地环境文件。 Vite config environment whose mode selects local env files.
 * @returns 前端插件和仅在开发、预览服务中使用的代理配置。 Frontend plugins and proxy configuration for the dev and preview servers.
 */
export default defineConfig(({ mode }) => {
  // 代理地址属于开发服务器配置。按 GGBOY_ 前缀读取，浏览器继续请求相对路径。
  // The proxy target configures the development server. Load it by the GGBOY_ prefix and keep browser requests relative.
  const env = loadEnv(mode, process.cwd(), 'GGBOY_');
  const apiTarget = env.GGBOY_API_PROXY_TARGET || 'http://127.0.0.1:8080';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
  };
});

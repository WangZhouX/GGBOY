import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 启用 JSX 转换和 React 热更新。
 * Enable JSX transformation and React Fast Refresh.
 */
export default defineConfig({
  plugins: [react()],
});

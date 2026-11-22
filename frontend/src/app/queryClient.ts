import { QueryClient } from '@tanstack/react-query';

/**
 * 全站请求共用一个缓存。同一查询键十秒内可复用结果，错误立即交给已发起请求的页面处理。
 * Shares one cache across the app. A query can reuse data for ten seconds and lets its requesting page handle errors immediately.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: false,
    },
  },
});

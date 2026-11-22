# 应用装配与路由

- [App.tsx](App.tsx) 装配 React Router、i18next 和 TanStack Query 的全局 Provider。
- [AppRoutes.tsx](AppRoutes.tsx) 将 URL 映射到 [pages](../pages/README.md)。从这里可以找到每个页面对应的文件。
- [layout](layout/README.md) 渲染全站导航、语言和网络选择器，并通过 Outlet 显示当前页面。
- [i18n](i18n/README.md) 初始化中英文文案并记住语言选择。
- [queryClient.ts](queryClient.ts) 定义全站查询缓存的默认行为。
- [styles](styles/README.md) 提供站点颜色、基础样式和跨页面的交互样式。

启动顺序为 main.tsx → App.tsx → AppRoutes.tsx → 页面。导航链接通过[共享导航模块](../shared/navigation/README.md)携带当前网络。

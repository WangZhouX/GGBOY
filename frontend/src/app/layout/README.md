# 全站布局

[AppLayout.tsx](AppLayout.tsx) 渲染主导航、语言和网络选择器，以及 Phantom 钱包按钮。按钮与业务页面共用 [Solana 钱包状态](../../solana/README.md)。匹配的路由页面显示在正文 Outlet 中。借贷等业务自己的导航交由对应的 feature 组件维护。

等待 Phantom 授权时，顶栏提示用户打开钱包并确认，可点击「取消等待」返回可重试状态。尚未处理的授权窗口由 Phantom 扩展负责。

[AppLayout.css](AppLayout.css) 定义侧栏、顶栏、正文和移动端布局，颜色使用[应用全局样式](../styles/README.md)的变量。

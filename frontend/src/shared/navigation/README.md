# 路由路径与网络

[paths.ts](paths.ts) 定义供路由表与站内导航共用的路径。[network.ts](network.ts) 优先从 URL 读取网络，缺省时尝试读浏览器偏好，再回退到 Localnet。withNetwork 为站内链接加上网络参数，使分享的回执能打开对应环境。

路由与组件的映射见[应用路由](../../app/AppRoutes.tsx)。网络值与后端协议保持一致。

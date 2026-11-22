# 前端源码

[main.tsx](main.tsx) 初始化翻译并挂载 React。[App.tsx](app/App.tsx) 装配全局 Provider，[AppRoutes.tsx](app/AppRoutes.tsx) 把 URL 映射到页面。

| 模块 | 职责 |
| --- | --- |
| [app](app/README.md) | 应用装配、路由、全站布局、国际化和查询缓存 |
| [pages](pages/README.md) | 路由页面入口，按业务组织界面和数据 |
| [features](features/README.md) | 业务专用组件、查询和交互，由页面按需调用 |
| [shared](shared/README.md) | 多个业务共用的 UI、链接与网络、HTTP 和接口类型 |
| [solana](solana/README.md) | 钱包连接、RPC、Anchor IDL 和交易的接入位置 |

查页面从路由表进入。增加某项业务的查询或交互时，由对应页面组织展示，能在同一业务内独立使用的部分放在 features。公共代码保持独立，可被 app、pages 和 features 使用。启动、构建和阅读顺序见[前端 README](../README.md)。

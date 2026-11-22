# 页面入口

每个页面对应一条路由，负责读取该页面的参数、选择业务组件和安排布局。路由由 [AppRoutes.tsx](../app/AppRoutes.tsx) 装配，共用页面布局位于 [shared/ui](../shared/ui/README.md)，业务组件位于 [features](../features/README.md)。

| 页面目录 | 路径 |
| --- | --- |
| [资产总览](overview/README.md) | `/overview` |
| [策略金库](vault/README.md) | `/vault` |
| [借贷市场](lending/README.md) | `/lend`、`/lend/borrow`、`/lend/supply`、`/lend/liquidations` |
| [策略管理](strategy/README.md) | `/strategy` |
| [交易活动与回执](activity/README.md) | `/activity`、`/activity/:signature/events/:eventIndex` |
| [错误页面](errors/README.md) | 无匹配路由时的 404 页面 |

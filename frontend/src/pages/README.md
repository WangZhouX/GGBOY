# 页面入口

每个页面对应一条路由，负责读取页面参数和安排布局。只供当前路由使用的页面区块和样式跟随该页面。路由由 [AppRoutes.tsx](../app/AppRoutes.tsx) 装配，共用页面布局位于 [shared/ui](../shared/ui/README.md)，可在同一业务的多个页面复用的组件和接口位于 [features](../features/README.md)。

| 页面目录 | 路径 |
| --- | --- |
| [资产总览](overview/README.md) | `/overview` |
| [策略金库](vault/README.md) | `/vault`、`/vault/deposit`、`/vault/redeem` |
| [借贷市场](lending/README.md) | `/lend`、`/lend/borrow`、`/lend/borrow/{collateral,borrow,repay,withdraw}`、`/lend/supply`、`/lend/supply/deposit`、`/lend/supply/withdraw`、`/lend/liquidations` |
| [策略管理](strategy/README.md) | `/strategy` |
| [交易活动与回执](activity/README.md) | `/activity`、`/activity/:signature/events/:eventIndex` |
| [错误页面](errors/README.md) | 无匹配路由时的 404 页面 |

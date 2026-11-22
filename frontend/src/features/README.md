# 业务组件

本目录提供面向单项业务的组件、查询和状态逻辑，由 [页面入口](../pages/README.md) 组合。业务组件可以在同一项业务的多个页面使用，跨业务的通用代码位于 [shared](../shared/README.md)。

- [策略金库](vault/README.md) 按接口维护金库查询的请求和响应类型。
- [借贷业务](lending/README.md) 提供市场概况、借款、出借和清算共用的子导航。

接口契约可通过[后端 Swagger](../../../backend/README.md#在线接口文档)查看。

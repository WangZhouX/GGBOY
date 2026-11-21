# HTTP 控制层

`io.ggboy.backend.controller` 按前端查询的业务资源组织 HTTP 控制器。当前已建立四个 Spring MVC 组件并声明类级路径前缀，具体请求处理方法随业务开发添加。

| 控制器 | 路径前缀 | 规划职责 |
| --- | --- | --- |
| [ActivityController](ActivityController.java) | `/api/v1/activities` | 交易历史、参与方及代币变动 |
| [VaultController](VaultController.java) | `/api/v1/vaults` | 金库概览、净值快照及钱包份额 |
| [LendingMarketController](LendingMarketController.java) | `/api/v1/lending-markets` | 借贷市场及钱包仓位 |
| [RiskAlertController](RiskAlertController.java) | `/api/v1/risk-alerts` | 可选的仓位风险提醒 |

首期规划实现 `GET /api/v1/activities`。届时由控制器接收网络、钱包、业务类型和分页参数，通过[服务层](../service/README.md)获取活动记录，参数错误交给[统一 HTTP 错误处理](../api/README.md)。

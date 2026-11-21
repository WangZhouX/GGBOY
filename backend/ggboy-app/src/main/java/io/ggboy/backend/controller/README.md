# HTTP 控制层

`io.ggboy.backend.controller` 按前端查询的业务资源组织 HTTP 控制器。已实现的业务接口通过 Swagger UI 按中文业务分组展示。

| 控制器 | 路径前缀 | 职责 |
| --- | --- | --- |
| [ActivityController](ActivityController.java) | `/api/v1/activities` | 交易活动分页、单条回执、参与方及代币变动 |
| [VaultController](VaultController.java) | `/api/v1/vaults` | 金库概览、净值快照及钱包份额 |
| [LendingMarketController](LendingMarketController.java) | `/api/v1/lending-markets` | 借贷市场及钱包仓位 |
| [RiskAlertController](RiskAlertController.java) | `/api/v1/risk-alerts` | 可选的仓位风险提醒 |

## Swagger 接口文档

每个已实现的接口用 `@Tag` 标注所属业务，用 `@Operation` 的 `summary` 提供中文名称。`description` 说明接口用途，关键请求参数用 `@Parameter` 标注。添加业务接口时同步填写这些注解，并维护用于前端衔接的中英文 Javadoc。启动与访问方式见[后端运行说明](../../../../../../../../README.md)。

## 已实现的查询

`GET /api/v1/activities` 提供公开的游标分页列表，供「交易活动」页的「活动记录」和「策略金库」页的「最近金库交易」共用。支持网络、钱包、业务主体地址、交易签名和可重复的业务类型筛选。控制器校验参数和游标后通过[服务层](../service/README.md)读取事件，错误文案沿用[统一 HTTP 错误处理](../api/README.md)。

`GET /api/v1/activities/{signature}/events/{eventIndex}` 对应 Swagger 的「查看交易回执」。点击「活动记录」或「最近金库交易」中的「查看回执」，以及直接打开回执链接时，用该条记录的网络、签名和事件序号查询。接口公开，返回事件的交易时间、全部参与角色和资产变动，找不到已索引事件时返回 HTTP 404。

[VaultController](VaultController.java) 提供公开的金库列表 `GET /api/v1/vaults`、钱包持仓 `GET /api/v1/vaults/{address}/positions/{wallet}` 和历史快照 `GET /api/v1/vaults/{address}/snapshots`。历史快照供策略金库页的「每份净值走势」按游标加载，取得选中金库地址后即可调用。持仓查询用于策略金库页的「我的金库份额」，取得已连接的钱包公钥和选中金库后请求。网络或公钥无效时返回 HTTP 400。金库未登记时持仓接口返回 HTTP 404，钱包尚无采集记录时返回 HTTP 200 和空快照。

[LendingMarketController](LendingMarketController.java) 提供 `GET /api/v1/lending-markets`，向借贷市场「市场概况」的「资金池现况」返回指定网络的市场目录、资产精度和最新资金池快照。页面进入、刷新或切换网络时调用，无需连接钱包。

`GET /api/v1/lending-markets/{address}/positions/{wallet}` 供「我的借款」的「借款仓位」「额度与清算条件」和「我的出借」的「个人出借资金」共用。选中市场并连接钱包后调用，切换市场、钱包、网络或者相关交易确认后刷新。

`GET /api/v1/lending-markets/{address}/liquidations` 供「清算市场」（原型 `#lend/liquidations`）的「演示借款仓位」读取公开候选，选中市场后即可调用。进入页面、刷新、切换市场或网络及清算交易确认时重查首屏，继续加载时回传 `nextCursor`。市场与价格状态不可用时，前端显示对应提示并清空候选。

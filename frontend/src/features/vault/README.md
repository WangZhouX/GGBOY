# 策略金库业务

本目录放策略金库的业务请求、读链数据转换和金额计算。页面入口、金库概况、钱包份额和净值走势的组件及样式位于[策略金库页面目录](../../pages/vault/README.md)。

[api](api/README.md) 按接口维护请求与响应类型。[listVaults.ts](api/listVaults.ts) 对应公开金库列表，[getVaultPosition.ts](api/getVaultPosition.ts) 对应指定钱包在选中金库的仓位，[listVaultSnapshots.ts](api/listVaultSnapshots.ts) 对应所选金库的公开历史快照。发送 HTTP 请求时复用[公共 API 层](../../shared/api/README.md)。

[vaultAmounts.ts](vaultAmounts.ts) 按 Mint 精度格式化整数金额，并计算每份净值。[depositQuote.ts](depositQuote.ts) 用整数计算存入报价和最低份额，[redeemQuote.ts](redeemQuote.ts) 计算赎回报价和最低到账。两者共用 [cashVaultAmounts.ts](cashVaultAmounts.ts) 的金额精度与最低值规则。[liveVaultView.ts](liveVaultView.ts) 将确认态的金库和钱包数据转换为页面所需的概况与仓位字段。

[devnetVaultQueryKeys.ts](devnetVaultQueryKeys.ts) 统一金库与资产总览的公开部署校验和实时缓存键。存赎确认后失效同一缓存范围。

[useVaultRecentActivity.ts](useVaultRecentActivity.ts) 复用 [listActivities.ts](../activity/api/listActivities.ts)，查询所选金库与钱包的最近存赎，并管理交易确认后等待后端索引的状态。区块及 CSS 在策略金库页面目录，列表和回执渲染复用活动业务。

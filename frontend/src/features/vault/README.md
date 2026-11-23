# 策略金库业务

本目录放策略金库的业务请求和金额格式化。页面入口、金库概况、钱包份额和净值走势的组件及样式位于[策略金库页面目录](../../pages/vault/README.md)。

[api](api/README.md) 按接口维护请求与响应类型。[listVaults.ts](api/listVaults.ts) 对应公开金库列表，[getVaultPosition.ts](api/getVaultPosition.ts) 对应指定钱包在选中金库的仓位，[listVaultSnapshots.ts](api/listVaultSnapshots.ts) 对应所选金库的公开历史快照。发送 HTTP 请求时复用[公共 API 层](../../shared/api/README.md)。

[vaultAmounts.ts](vaultAmounts.ts) 按 Mint 精度格式化整数金额，并计算每份净值。

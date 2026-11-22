# 策略金库业务

本目录放策略金库的业务请求和后续可复用的金库组件，由[策略金库页面](../../pages/vault/VaultPage.tsx)组织展示。

[api](api/README.md) 按接口维护请求与响应类型。[listVaults.ts](api/listVaults.ts) 定义金库概况接口的参数、响应类型与请求方法。发送 HTTP 请求时复用[公共 API 层](../../shared/api/README.md)。

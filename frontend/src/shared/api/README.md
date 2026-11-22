# 后端 API 客户端

[client.ts](client.ts) 使用 openapi-fetch 根据生成的 [schema.d.ts](schema.d.ts) 推断地址、参数和响应。调用仍经过浏览器原生 fetch，Vite 开发代理负责转发相对的 /api 请求。

- createApiClient 创建客户端，发请求时读取当前语言并写入 Accept-Language。业务查询可传入查询函数提供的 AbortSignal。
- unwrapApiResponse 从后端 ApiResponse 中取出 data。HTTP 错误保留 HTTP 状态、后端错误码和本地化提示，非法响应也有独立分类。断网与取消沿用原生请求行为。
- schema.d.ts 源于 Spring Boot 的 OpenAPI 文档。更新后端契约后按[前端 README](../../../README.md)的命令重新生成。

下面的调用返回活动分页的数据。每个 type 值会作为单独的同名查询参数发送。

```ts
const api = createApiClient(() => i18n.language);
const page = await unwrapApiResponse(api.GET('/api/v1/activities', {
  params: { query: { network: 'localnet', type: ['VAULT_DEPOSIT', 'VAULT_REDEEM'] } },
  signal,
}));
```

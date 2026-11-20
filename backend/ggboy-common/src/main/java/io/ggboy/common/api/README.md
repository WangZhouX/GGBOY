# 公共 API 契约

[ApiResponse](ApiResponse.java) 的两个字段中恰有一个包含值。应用可以用 `ApiResponse.success(data)` 返回成功数据，空集合表示查询成功且无匹配结果。业务 HTTP 错误使用 `ApiResponse.failure(errorCode, locale)` 传入本次请求的语言，Controller 同时设置对应的 HTTP 状态码。无语言参数的重载沿用英文提示。

[ApiError](ApiError.java) 公开 `code` 和 `message`。[ErrorCode](ErrorCode.java) 的枚举名称作为稳定的错误标识，每个枚举项同时声明中文和英文提示。前端可用 `code` 决定操作，并直接展示 `message`。

| 公共错误码 | 中文提示 | 英文提示 |
| --- | --- | --- |
| `INVALID_REQUEST` | 请求参数无效。 | The request is invalid. |
| `NOT_FOUND` | 请求的资源不存在。 | The requested resource was not found. |
| `INTERNAL_ERROR` | 服务端无法完成请求。 | The request could not be completed. |

活动查询等使用游标分页的接口返回 `ApiResponse<CursorPage<T>>`。[CursorPage](CursorPage.java) 的 `items` 保存本页记录。当 `nextCursor` 为 `null` 时，客户端结束翻页。游标由具体查询服务生成和解释。空查询结果是成功的末页。

```json
{"data":{"items":[],"nextCursor":null},"error":null}
```

```json
{"data":null,"error":{"code":"INVALID_REQUEST","message":"The request is invalid."}}
```

如果前端发送 `Accept-Language: zh-CN`，同一个错误在响应中使用简体中文。

```json
{"data":null,"error":{"code":"INVALID_REQUEST","message":"请求参数无效。"}}
```

[SolanaNetwork](SolanaNetwork.java) 提供 `LOCALNET` 和 `DEVNET` 两个共享枚举值。HTTP 适配层用 `SolanaNetwork.fromWireValue(network)` 解析接收到的文本，用 `wireValue()` 输出协议小写字符串。例如 `SolanaNetwork.DEVNET.wireValue()` 的结果为 `"devnet"`。

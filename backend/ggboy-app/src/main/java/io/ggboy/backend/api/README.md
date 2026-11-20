# HTTP 错误处理

本包把业务控制器的输入错误映射为 HTTP 状态码和公共响应类型。入口为 [ApiRequestExceptionHandler](ApiRequestExceptionHandler.java)。业务控制器位于 `io.ggboy.backend` 或其子包时，缺少必填查询参数、参数类型转换失败、绑定对象校验失败和不可读的请求体都返回 HTTP 400，响应使用 `ggboy-common` 的 `ApiResponse` 和 `INVALID_REQUEST` 错误码。

Actuator 使用 Spring Boot 自身的健康检查响应格式。业务控制器成功处理请求时，通过 `ApiResponse.success(data)` 返回业务数据。

前端通过 `Accept-Language` 传入用户选择的语言。[语言配置](ApiLocaleConfiguration.java) 按请求中的优先顺序匹配中文或英文，支持 `zh-CN`、`zh-Hans` 和 `en-US` 等标签。所有中文标签暂时使用简体文案。缺少请求头或指定的语言均不受支持时使用英文。输入错误的 HTTP 响应通过 `Content-Language` 标记所用语言，并通过 `Vary: Accept-Language` 告知缓存按语言区分响应。

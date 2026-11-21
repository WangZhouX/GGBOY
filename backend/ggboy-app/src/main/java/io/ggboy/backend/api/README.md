# HTTP 响应与错误处理

本包把业务控制器的输入错误映射为 HTTP 状态码和公共响应类型。入口为 [ApiRequestExceptionHandler](ApiRequestExceptionHandler.java)。业务控制器位于 `io.ggboy.backend` 或其子包时，缺少必填查询参数、参数类型转换失败、绑定对象校验失败和不可读的请求体都返回 HTTP 400，响应使用 `ggboy-common` 的 `ApiResponse` 和 `INVALID_REQUEST` 错误码。

Actuator 使用 Spring Boot 自身的健康检查响应格式。业务控制器成功处理请求时，通过 `ApiResponse.success(data)` 返回业务数据。

前端通过 `Accept-Language` 传入用户选择的语言。[语言配置](ApiLocaleConfiguration.java) 按请求中的优先顺序匹配中文或英文，支持 `zh-CN`、`zh-Hans` 和 `en-US` 等标签。所有中文标签暂时使用简体文案。缺少请求头或指定的语言均不受支持时使用英文。输入错误的 HTTP 响应通过 `Content-Language` 标记所用语言，并通过 `Vary: Accept-Language` 告知缓存按语言区分响应。

[VaultListResponse](VaultListResponse.java) 定义金库列表及资产、快照的 JSON 字段。最小单位金额和 slot 使用整数字符串，尚未采集的快照用空值表示。[VaultPositionResponse](VaultPositionResponse.java) 描述指定金库和钱包的持有份额、估值、可赎回份额上限和预计到账。

[VaultHistorySnapshotResponse](VaultHistorySnapshotResponse.java) 定义「每份净值走势」历史观测点，保留 UTC 采集时间、原始整数字符串和无法估值的空值。分页使用公共 `CursorPage`，[VaultHistoryCursor](VaultHistoryCursor.java) 负责将续页边界绑定到网络与金库。前端直接回传 `nextCursor`。

[ActivityQuery](ActivityQuery.java) 校验交易活动的网络、钱包、业务主体、交易签名、多个事件类型和页长。[ActivityCursor](ActivityCursor.java) 把交易 slot、签名和事件索引组成续页边界，并绑定同一组筛选条件。[ActivityResponse](ActivityResponse.java) 作为活动列表项和单条回执共享的事件结构，包含父交易信息、完整参与方和资产变动。列表使用公共 `CursorPage`。

[LendingMarketListResponse](LendingMarketListResponse.java) 定义「资金池现况」的市场目录和最新快照。金库与借贷市场共用 [AssetMintResponse](AssetMintResponse.java) 的资产标识和精度，以及 [SnapshotFreshness](SnapshotFreshness.java) 对已观测快照的状态。

[LendingPositionResponse](LendingPositionResponse.java) 定义借款和出借共用的仓位响应，返回最新观测、风险参数和可判定的额度。空快照表示尚未采集，空额度表示当前无法判定。

[LendingLiquidationPageResponse](LendingLiquidationPageResponse.java) 定义「清算市场」的候选页、数据可用状态和已验证的预言机信息。[LendingOraclePriceVersion](LendingOraclePriceVersion.java) 定义行情版本的计算方式。[LiquidationCursor](LiquidationCursor.java) 绑定请求网络、市场、评估 slot、价格版本和本页最后一个位置，前端直接回传 `nextCursor`。

# 借贷市场接口

[listLendingMarkets.ts](listLendingMarkets.ts) 封装市场首页的资金池现况查询。请求参数、市场和资产类型及资金池观测字段都定义在同一文件。调用方提供当前 Solana 网络，发出已登记市场的公开查询，在切换网络或离开页面时可通过 AbortSignal 取消。

[getLendingPosition.ts](getLendingPosition.ts) 为使用索引的市场封装「我的借款」和「我的出借」的仓位查询。已登记的 GGBOY Devnet 借款与出借仓位通过 [Devnet 借贷客户端](../../../solana/lending/README.md) 直接读取。请求提供网络、市场状态账户公钥和钱包公钥。响应包含借款和出借字段，把最小单位金额、份额和 slot 保留为十进制整数字符串。钱包从未观测时整个仓位快照为空，单项额度不可估算时对应字段为空。金额展示所需的 Mint 精度由市场列表提供。

请求使用 [公共 API 层](../../../shared/api/README.md) 的统一响应处理和语言协商。返回的金额与 slot 保留为十进制整数字符串。市场列表为空表示该网络尚未登记市场，市场存在但观测为空表示尚未采集。已采集到的零保留原值，页面可用借款 Mint 精度格式化金额。

[listLendingLiquidations.ts](listLendingLiquidations.ts) 供「清算市场」公开加载同一评估批次的候选。请求传网络、市场与可选游标，响应保留价格来源、发布时间、精确健康度、最小单位金额和可用性状态。实时清算预览直接读取同批 RPC 账户。

# 策略金库接口

本目录按接口组织文件，每个 TypeScript 文件包含对应的请求参数、响应类型和请求方法。页面组件和样式位于[策略金库页面目录](../../../pages/vault/README.md)。

[listVaults.ts](listVaults.ts) 提供 GET /api/v1/vaults 的请求参数、响应字段及 listVaults 方法。[策略金库页面](../../../pages/vault/README.md)打开、刷新或切换网络时使用该网络的查询。调用方必传 network，可传取消信号。方法读取响应的 data，调用方可直接使用 result.items。最新快照尚未同步时为 null，已知为零的金额用字符串 "0" 表示。

[listVaultSnapshots.ts](listVaultSnapshots.ts) 提供 `GET /api/v1/vaults/{address}/snapshots` 的请求参数、响应字段和 `listVaultSnapshots` 方法。「每份净值走势」按 `network` 和金库 `address` 查询。首屏省略 `cursor`，加载更早的记录时原样传入 `nextCursor`，末页的 `nextCursor` 为 `null`。方法保留接口的 slot 倒序及原始金额。图表用 `observedAt` 按时间正序绘制，按计价和份额 Mint 的小数位换算 `navRaw` 与 `totalSharesRaw`，缺少净值或总份额为零时保留缺口。查询无需连接钱包。

[getVaultPosition.ts](getVaultPosition.ts) 提供 `GET /api/v1/vaults/{address}/positions/{wallet}` 的请求参数、响应字段和 `getVaultPosition` 方法。调用方传入站点网络 `network`、所选金库地址 `address` 和已连接的钱包公钥 `wallet`，可传取消信号。方法返回统一响应中的 `data`。`snapshot: null` 表示该钱包尚无观测记录，快照中的 `null` 金额表示估值暂不可用，字符串 `"0"` 表示已知零值。`sharesRaw` 和 `maxRedeemSharesRaw` 按份额资产的小数位显示，`positionValueRaw` 和 `redeemableRaw` 按计价资产的小数位显示。资产精度来自金库概况接口。

请求发送与错误处理使用[公共 API 层](../../../shared/api/README.md)。接口语义与参数见[金库控制器](../../../../../backend/ggboy-app/src/main/java/io/ggboy/backend/controller/VaultController.java)，运行后也可通过[Swagger](../../../../../backend/README.md#在线接口文档)查看。

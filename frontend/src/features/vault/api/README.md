# 策略金库接口

本目录按接口组织文件。打开对应的 TypeScript 文件即可看到该接口的请求参数和响应字段。

[listVaults.ts](listVaults.ts) 提供 GET /api/v1/vaults 的请求参数、响应字段及 listVaults 方法。页面接入后会在打开、刷新或切换网络时查询金库概况。调用方必传 network，可传取消信号。方法读取响应的 data，调用方可直接使用 result.items。最新快照尚未同步时为 null，已知为零的金额用字符串 "0" 表示。

请求发送与错误处理使用[公共 API 层](../../../shared/api/README.md)。接口语义与参数见[金库控制器](../../../../../backend/ggboy-app/src/main/java/io/ggboy/backend/controller/VaultController.java)，运行后也可通过[Swagger](../../../../../backend/README.md#在线接口文档)查看。

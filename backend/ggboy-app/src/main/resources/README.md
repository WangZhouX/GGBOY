# 运行时资源

[application.yml](application.yml) 定义 Spring Boot 应用名、PostgreSQL 环境变量与 Flyway 位置。[db](db/README.md) 存放数据库资源，连接配置由实际环境提供。

| 配置 | 用途 | 默认值 |
| --- | --- | --- |
| ggboy.devnet-vault-indexer.* | 配置 Devnet 金库存赎同步的启用开关、只读 RPC、程序 ID 与轮询延迟。环境变量见[后端 README](../../../../README.md#devnet-金库交易同步)。 | 已开启，每轮完成后等待 20 秒 |
| ggboy.devnet-lending-indexer.* | 控制 Devnet 借款活动同步的开关、程序 ID 与轮询延迟，复用金库索引的只读 RPC。环境变量见[后端 README](../../../../README.md#devnet-借款交易同步)。 | 已开启，每轮完成后等待 20 秒 |
| ggboy.devnet-vault-snapshot.* | 控制已登记 Devnet 纯现金金库的历史快照采集，复用上项的 RPC 和程序配置。 | 已开启，每轮完成后等待 30 秒 |
| ggboy.vault.snapshot-stale-after-seconds | 金库列表和钱包持仓的快照从观测时间起保持新鲜的时长，须为正整数秒。通过 GGBOY_VAULT_SNAPSHOT_STALE_AFTER_SECONDS 覆盖。 | 60 秒 |
| ggboy.lending.snapshot-stale-after-seconds | 借贷市场和钱包仓位快照从观测时间起保持新鲜的时长，须为正整数秒。通过 GGBOY_LENDING_SNAPSHOT_STALE_AFTER_SECONDS 覆盖。 | 60 秒 |
| springdoc.api-docs.enabled 和 springdoc.swagger-ui.enabled | 控制 `/api/v1/**` 的 OpenAPI 文档和 Swagger UI，统一从 `GGBOY_SWAGGER_ENABLED` 读取。 | 开启 |

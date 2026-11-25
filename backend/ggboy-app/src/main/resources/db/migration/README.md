# PostgreSQL 迁移 / PostgreSQL migrations

- [V1](V1__create_indexer_schema.sql) 建立原有的 13 张索引、金库、借贷和风险表。 Creates the original 13 index, vault, lending and risk tables.
- [V2](V2__add_liquidation_oracle_data.sql) 追加借贷市场的价格源配置、报价与风险批次字段，以及清算列表分页索引。 Adds the lending oracle configuration, quote and risk batch fields and the liquidation pagination index.
- [V3](V3__add_liquidation_bad_debt_receipts.sql) 允许清算回执记录以借款资产计价的坏账。 Allows liquidation receipts to record bad debt in the debt asset.
- [V4](V4__add_vault_recall_state.sql) 记录金库的自动收回能力及出借份额状态。旧快照默认关闭自动收回并保留未知的出借份额状态。 Records auto-recall capability and lending share presence. Historical snapshots retain disabled auto recall and unknown share presence.

Spring Boot 将迁移文件打包到可执行 JAR 的 `BOOT-INF/classes/db/migration` 下。通过 [后端运行说明](../../../../../../README.md#构建与运行) 中的命令启动后，Flyway 从 `classpath:db/migration` 读取并执行迁移。

Spring Boot packages migrations under `BOOT-INF/classes/db/migration` in the executable JAR. When started with the [backend launch command](../../../../../../README.md#构建与运行), Flyway reads and applies migrations from `classpath:db/migration`.

## 初始化与升级 / Setup and upgrades

空库由 Spring Boot 启动时依次执行所有已打包的迁移。已有 Flyway 记录的数据库按已登记的版本继续迁移。若库中存在手动通过旧版 `docs/backend/schema.sql` 建好的表且没有 Flyway 记录，备份后确认旧结构与 V1 一致，用同一数据库、schema 和 Flyway 配置显式执行一次 `flyway -baselineVersion=1 baseline`，再启动应用执行后续迁移。若手动创建的是当前完整结构，核对它所包含的迁移版本并显式登记相应版本。应用的 `baseline-on-migrate` 保持关闭。

On an empty database, Spring Boot applies all packaged migrations at startup. A database already tracked by Flyway continues from its recorded version. If the tables were created manually using the legacy `docs/backend/schema.sql` and have no Flyway history, back up the database and verify the schema against V1. Run `flyway -baselineVersion=1 baseline` once using the same database, schema and Flyway configuration, then start the application to apply later migrations. If the current complete schema was applied manually, verify the migrations represented by that schema and explicitly baseline it at the matching version. Application-wide `baseline-on-migrate` stays disabled.

升级只追加结构，旧市场和快照的价格字段为空，旧批次默认为未发布。当前 `docs/backend/schema.sql` 是空白验证库使用的完整参考结构。

The upgrade adds schema fields and an index. It leaves historical quote and configuration fields null and old batches unpublished. The current `docs/backend/schema.sql` is the complete reference schema for an empty verification database.

# PostgreSQL 迁移 / PostgreSQL migrations

- [V1](V1__create_indexer_schema.sql) 建立原有的 13 张索引、金库、借贷和风险表。 Creates the original 13 index, vault, lending and risk tables.
- [V2](V2__add_liquidation_oracle_data.sql) 追加借贷市场的价格源配置、报价与风险批次字段，以及清算列表分页索引。 Adds the lending oracle configuration, quote and risk batch fields and the liquidation pagination index.

打包时迁移文件进入 `ggboy-app/target/lib/` 下的 `*-migrations.jar`，Flyway 从应用的 classpath 读取。启动时保留 [后端运行说明](../../../../../../README.md) 中的 module path 和 classpath。

The build stages migrations in `*-migrations.jar` under `ggboy-app/target/lib/` for Flyway to read from the application classpath. Keep both paths in the [backend launch command](../../../../../../README.md).

## 初始化与升级 / Setup and upgrades

空库由 Spring Boot 启动时依次执行 V1、V2。已有 Flyway 记录的数据库按已登记的版本继续迁移。若库中存在手动通过旧版 `docs/backend/schema.sql` 建好的表且没有 Flyway 记录，备份后确认旧结构与 V1 一致，用同一数据库、schema 和 Flyway 配置显式执行一次 `flyway -baselineVersion=1 baseline`，再启动应用执行 V2。若手动创建的是当前完整结构，核对与 V2 一致并显式登记 V2。应用的 `baseline-on-migrate` 保持关闭。

On an empty database, Spring Boot applies V1 and V2 at startup. A database already tracked by Flyway continues from its recorded version. If the tables were created manually using the legacy `docs/backend/schema.sql` and have no Flyway history, back up the database and verify the schema against V1. Run `flyway -baselineVersion=1 baseline` once using the same database, schema and Flyway configuration, then start the application to apply V2. If the current complete schema was applied manually, verify it against V2 and explicitly baseline it at V2. Application-wide `baseline-on-migrate` stays disabled.

升级只追加结构，旧市场和快照的价格字段为空，旧批次默认为未发布。当前 `docs/backend/schema.sql` 是空白验证库使用的完整参考结构。

The upgrade adds schema fields and an index. It leaves historical quote and configuration fields null and old batches unpublished. The current `docs/backend/schema.sql` is the complete reference schema for an empty verification database.

# PostgreSQL 迁移

Flyway 按版本执行此目录中的 SQL 文件。首个业务迁移以 `V1__<description>.sql` 命名。索引或表结构发生变更时追加迁移。

当前包含迁移入口配置。业务表随索引模块设计加入。

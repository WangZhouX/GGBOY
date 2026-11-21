# 数据库资源 / Database resources

[Flyway 迁移目录](migration/README.md)维护 PostgreSQL 表结构版本。Spring Boot 启动时运行迁移，MyBatis-Plus 使用该结构读取和写入链下索引数据。

The [Flyway migration directory](migration/README.md) maintains the PostgreSQL schema versions. Spring Boot applies the migrations at startup, and MyBatis-Plus uses the schema for off-chain index data.

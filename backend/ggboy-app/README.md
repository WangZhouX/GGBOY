# GGBOY 应用模块

`ggboy-app` 提供后端的 Spring Boot 启动入口。它通过 [ggboy-core](../ggboy-core/README.md) 使用业务类型，通过 [ggboy-common](../ggboy-common/README.md) 使用统一响应和错误契约；数据库访问、HTTP 状态码和 RPC 接入都归应用模块管理。

| 入口 | 职责 |
| --- | --- |
| [Java 源码](src/main/java/README.md) | 启动应用、接收业务请求并组织模块内的三层结构 |
| [应用配置](src/main/resources/application.yml) | 配置唯一的数据源、Flyway 和 Actuator |
| [迁移目录](src/main/resources/db/migration/README.md) | 存放版本化的 PostgreSQL 迁移 |

在后端聚合工程下构建三个模块，随后用 `java -jar` 启动 `ggboy-app/target/ggboy-app-0.1.0-SNAPSHOT.jar`。命令和数据库环境变量见[构建与运行](../README.md#构建与运行)。

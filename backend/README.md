# GGBOY 后端

使用 JDK 25、Spring Boot 4.1.2、Spring Web MVC、Maven、PostgreSQL、MyBatis-Plus 3.5.18 和 Flyway。

后端计划通过 Solana JSON-RPC 和 WebSocket 同步金库和借贷程序的事件与交易，支持去重和断线补扫。Spring Web 提供历史记录、净值快照和仓位查询接口。PostgreSQL 保存索引结果和同步游标，MyBatis-Plus 负责持久化访问，Flyway 管理数据库迁移。

## 工程结构

后端根 [pom.xml](pom.xml) 聚合三个 Maven 子项目，每个子项目都通过自己的 `module-info.java` 声明 Java 模块。

| 子项目 | Java 模块 | 职责 |
| --- | --- | --- |
| [ggboy-app](ggboy-app/README.md) | `io.ggboy.app` | 唯一启动入口与 `application.yml`，装配 Web、数据库、索引服务 |
| [ggboy-core](ggboy-core/README.md) | `io.ggboy.core` | 业务类型与不变量，如 Mint、代币精度和最小单位金额 |
| [ggboy-common](ggboy-common/README.md) | `io.ggboy.common` | 业务 API 响应、错误码、游标分页、网络标识、无符号整数校验与格式转换 |

依赖方向为 `app → core → common`，`app` 也直接使用 `common` 的 API 响应。公共库和核心库均可在纯 JDK 环境下运行。新增工具时按职责归属，例如可复用的整数范围校验属于公共库，Solana Mint 的业务约束属于核心库。

后端以单个 Spring Boot 应用部署。首期交易活动查询按 Controller、Service、Mapper 三层组织。接链后，后台索引任务经模块服务将 Solana 事件写入同一个 PostgreSQL 索引库。应用内的包结构见 [Java 源码索引](ggboy-app/src/main/java/README.md)。

## 构建与运行

在 `backend/` 下运行，Maven 使用的 Java 版本可通过 `mvn -v` 确认。

```sh
mvn clean package
```

构建会运行测试并生成三个模块的 JAR。用于启动的模块和第三方依赖位于 `ggboy-app/target/modules/` 与 `ggboy-app/target/lib/`，部署时保留两个目录。Java 使用 module path 加载项目模块。classpath 加载部分第三方库和独立的 Flyway 迁移资源 JAR，由 Flyway 从其中读取版本化 SQL。启动前准备 PostgreSQL 数据库和具备迁移权限的登录角色，并配置以下环境变量。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `GGBOY_DB_URL` | PostgreSQL JDBC 地址 | `jdbc:postgresql://localhost:5432/ggboy` |
| `GGBOY_DB_USER` | 数据库用户名 | `ggboy` |
| `GGBOY_DB_PASSWORD` | 数据库密码 | 空 |

```sh
java --module-path ggboy-app/target/modules \
     --class-path 'ggboy-app/target/lib/*' \
     --module io.ggboy.app/io.ggboy.backend.GgboyBackendApplication
```

用另一个终端检查服务状态。

```sh
curl --fail http://localhost:8080/actuator/health
```

应用和 PostgreSQL 正常时，健康检查返回 `{"status":"UP"}`。

## 在线接口文档

后端启动后，在 [Swagger UI](http://localhost:8080/swagger-ui.html) 按「策略金库」「借贷市场」「交易活动」浏览接口的中文名称、用途、参数和响应模型。展开接口可以直接向当前后端发请求。供工具读取的 [OpenAPI JSON](http://localhost:8080/v3/api-docs) 与页面使用同一份文档。

文档默认开启。将环境变量 `GGBOY_SWAGGER_ENABLED` 设为 `false` 可同时关闭 Swagger UI 和 OpenAPI 文档端点。打包后的 springdoc 与 Swagger UI 资源由后端启动命令中的 classpath 加载。

## 入口

- [源码与应用入口](ggboy-app/src/README.md)
- [运行时配置](ggboy-app/src/main/resources/README.md)
- [Flyway 迁移](ggboy-app/src/main/resources/db/migration/README.md)

[项目架构](../README.md) · [前端](../frontend/README.md) · [链上程序](../onchain/README.md)

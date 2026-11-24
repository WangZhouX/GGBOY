# GGBOY 后端

使用 JDK 25、Spring Boot 4.1.2、Spring Web MVC、Maven、PostgreSQL、MyBatis-Plus 3.5.18 和 Flyway。

后端通过 Solana JSON-RPC 定时同步 Devnet 金库存赎，以及借贷市场的抵押、借款、还款和取回抵押品，支持去重和断线补扫。Spring Web 提供历史记录、净值快照和仓位查询接口。PostgreSQL 保存索引结果和同步游标，MyBatis-Plus 负责持久化访问，Flyway 管理数据库迁移。

## 工程结构

后端根 [pom.xml](pom.xml) 聚合三个 Maven 子项目，依赖关系由各子项目的 `pom.xml` 管理。Spring Boot 按类路径启动。

| 子项目 | 职责 |
| --- | --- |
| [ggboy-app](ggboy-app/README.md) | 唯一启动入口与 `application.yml`，装配 Web、数据库、索引服务 |
| [ggboy-core](ggboy-core/README.md) | 业务类型与不变量，如 Mint、代币精度和最小单位金额 |
| [ggboy-common](ggboy-common/README.md) | 业务 API 响应、错误码、游标分页、网络标识、无符号整数校验与格式转换 |

依赖方向为 `app → core → common`，`app` 也直接使用 `common` 的 API 响应。公共库和核心库均可在纯 JDK 环境下运行。新增工具时按职责归属，例如可复用的整数范围校验属于公共库，Solana Mint 的业务约束属于核心库。

后端以单个 Spring Boot 应用部署。交易活动查询按 Controller、Service、Mapper 三层组织。后台索引任务将链上事件写入同一个 PostgreSQL 索引库。应用内的包结构见 [Java 源码索引](ggboy-app/src/main/java/README.md)。

## 构建与运行

在 `backend/` 下运行，Maven 使用的 Java 版本可通过 `mvn -v` 确认。

```sh
mvn clean package
```

构建会运行测试，并将 `ggboy-app` 的应用代码、运行依赖和 Flyway 迁移一起打包为 Spring Boot 可执行 JAR。启动前准备 PostgreSQL 数据库和具备迁移权限的登录角色，并配置以下环境变量。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `GGBOY_DB_URL` | PostgreSQL JDBC 地址 | `jdbc:postgresql://localhost:5432/ggboy` |
| `GGBOY_DB_USER` | 数据库用户名 | `ggboy` |
| `GGBOY_DB_PASSWORD` | 数据库密码 | 空 |

```sh
java -jar ggboy-app/target/ggboy-app-0.1.0-SNAPSHOT.jar
```

用另一个终端检查服务状态。

```sh
curl --fail http://localhost:8080/actuator/health
```

应用和 PostgreSQL 正常时，健康检查返回 `{"status":"UP"}`。

### IntelliJ IDEA

以 Maven 项目打开 `backend/pom.xml`，选择 JDK 25 作为项目 SDK。在 Maven 工具窗口重新加载所有 Maven 项目，然后在 `ggboy-app` 运行 `io.ggboy.backend.GgboyBackendApplication`。在运行配置中使用上表的数据库环境变量。

## Devnet 金库交易同步

在 PostgreSQL 已执行 Flyway 迁移后，用 [Devnet 金库登记 SQL](../docs/backend/register-devnet-vault.sql) 登记已部署的金库和两个 Mint。已有登记可直接启动。默认每轮结束后等待 20 秒，本任务从已保存的检查点继续扫描，可在活动页选择 Devnet 并查看两种存赎和各自的回执。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `GGBOY_DEVNET_VAULT_INDEXER_ENABLED` | 是否启用同步 | `true` |
| GGBOY_DEVNET_VAULT_RPC_URL | 只读 Devnet RPC 地址 | https://api.devnet.solana.com |
| GGBOY_DEVNET_VAULT_PROGRAM_ID | 对应数据库中登记的金库程序 ID | 前端 IDL 中当前部署的程序 ID |
| GGBOY_DEVNET_VAULT_POLL_INTERVAL | 每轮结束后的等待时间 | 20s |

同步沿用现有数据库表和 API。可通过 GET /api/v1/activities?network=devnet&category=vault 查看结果。节点限制读取时，任务保留最近已提交的检查点，下轮重试。历史节点须能返回已保存的检查点和后续交易日志，必要时切换 RPC。实现入口见 [Devnet 金库活动索引](ggboy-app/src/main/java/io/ggboy/backend/indexer/README.md)。

## Devnet 借款交易同步

[Devnet 借贷市场登记 SQL](../docs/backend/register-devnet-lending-market.sql) 为已部署市场登记程序与两种 Mint。已有登记可直接启动同步。任务按借贷程序分批回填节点可提供的最终确认历史，使用独立于金库的程序检查点。前端选择 Devnet，在「交易活动」切换到「借贷」，可按借款钱包过滤并打开回执。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| GGBOY_DEVNET_LENDING_INDEXER_ENABLED | 是否启用借款活动同步 | true |
| GGBOY_DEVNET_LENDING_PROGRAM_ID | 必须与市场登记匹配的程序 ID | GGBOY 当前 Devnet 借贷程序 |
| GGBOY_DEVNET_LENDING_POLL_INTERVAL | 每轮结束后的等待时间 | 20s |

借贷与金库共用上述只读 RPC 配置。首次回填时活动会随批次逐步出现。可使用 `GET /api/v1/activities?network=devnet&category=lending` 查看结果。后续新增市场登记如需回填旧交易，应针对相应程序重新扫描已有检查点之前的历史。见[索引实现](ggboy-app/src/main/java/io/ggboy/backend/indexer/README.md#借款活动)。

## Devnet 每份净值走势

启动后，定时任务对已登记的纯现金金库读取同一最终确认 slot 的托管现金和 GG-V 总份额，按照网络、金库公钥与 slot 追加至 vault_snapshot。同一 slot 只保存一次。纯现金金库的 NAV 等于托管现金，前端使用现有金库快照接口计算每份净值。总份额为零的观测保留历史时间，但没有可绘制的每份净值。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| GGBOY_DEVNET_VAULT_SNAPSHOT_ENABLED | 分别控制金库快照任务 | true |
| GGBOY_DEVNET_VAULT_SNAPSHOT_POLL_INTERVAL | 一轮结束之后再次采集的延迟 | 30s |

采集共用上节的 Devnet RPC 地址与金库程序 ID。启动新版后检查 GET /api/v1/vaults/{address}/snapshots?network=devnet 中的 slot、observedAt、cashRaw 和 totalSharesRaw。任务从启动后实际读取的 slot 开始记录。查询与采集均使用现有数据库结构。

## 在线接口文档

后端启动后，在 [Swagger UI](http://localhost:8080/swagger-ui.html) 按「策略金库」「借贷市场」「交易活动」浏览接口的中文名称、用途、参数和响应模型。展开接口可以直接向当前后端发请求。供工具读取的 [OpenAPI JSON](http://localhost:8080/v3/api-docs) 与页面使用同一份文档。

文档默认开启。将环境变量 `GGBOY_SWAGGER_ENABLED` 设为 `false` 可同时关闭 Swagger UI 和 OpenAPI 文档端点。springdoc 与 Swagger UI 资源随可执行 JAR 一起打包。

## 入口

- [源码与应用入口](ggboy-app/src/README.md)
- [运行时配置](ggboy-app/src/main/resources/README.md)
- [Flyway 迁移](ggboy-app/src/main/resources/db/migration/README.md)

[项目架构](../README.md) · [前端](../frontend/README.md) · [链上程序](../onchain/README.md)

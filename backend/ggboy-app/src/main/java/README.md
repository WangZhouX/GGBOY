# Java 源码

`io.ggboy.backend` 是 Spring Boot 扫描的应用包。包目录按 Java 命名空间映射。

当前入口为 [GgboyBackendApplication.java](io/ggboy/backend/GgboyBackendApplication.java)。Controller、Service、Mapper 和实体包直接位于 `io.ggboy.backend` 下。

| 目录 | 职责 | 实现进度 |
| --- | --- | --- |
| [entity](io/ggboy/backend/entity/README.md) | 统一管理数据库持久化对象 | 已映射 13 张表、97 个字段 |
| [controller](io/ggboy/backend/controller/README.md) | 接收业务 HTTP 请求并返回结果 | 已建目录，交易活动接口待开发 |
| [service](io/ggboy/backend/service/README.md) | 编排业务用例、组织数据库事务 | 已建目录，交易活动服务待开发 |
| [mapper](io/ggboy/backend/mapper/README.md) | 通过 MyBatis-Plus 读写 PostgreSQL | 已建目录，交易活动数据访问待开发 |

索引、金库、借贷查询和可选风险提醒的业务代码将分阶段接入。

业务请求的参数错误由 [api](io/ggboy/backend/api/README.md) 转为公共错误响应。

# Java 源码

`io.ggboy.backend` 是 Spring Boot 扫描的应用包。包目录按 Java 命名空间映射。

当前入口为 [GgboyBackendApplication.java](io/ggboy/backend/GgboyBackendApplication.java)。Controller、Service、Mapper 和实体包直接位于 `io.ggboy.backend` 下。

| 目录 | 职责 | 实现进度 |
| --- | --- | --- |
| [entity](io/ggboy/backend/entity/README.md) | 统一管理数据库持久化对象 | 已映射 13 张表、97 个字段 |
| [controller](io/ggboy/backend/controller/README.md) | 交易活动、金库、借贷市场及风险提醒的 HTTP 入口 | 已建立 4 个控制器骨架，具体接口待开发 |
| [service](io/ggboy/backend/service/README.md) | 提供单表服务，承载后续业务用例与事务边界 | 13 个基础接口及实现已建立，交易活动业务方法待开发 |
| [mapper](io/ggboy/backend/mapper/README.md) | 通过 MyBatis-Plus 读写 PostgreSQL | 13 个基础 Mapper 已建立，业务查询待开发 |

[indexer](io/ggboy/backend/indexer/README.md) 负责 Devnet 金库存赎与借款活动同步，以及纯现金金库的净值观测，沿用实体及 Mapper 写入活动、检查点和金库历史。

业务请求的参数错误由 [api](io/ggboy/backend/api/README.md) 转为公共错误响应。

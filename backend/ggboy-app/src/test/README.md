# 应用契约测试

- [ApiErrorLanguageTest](java/io/ggboy/backend/api/ApiErrorLanguageTest.java) 使用 JDK HTTP 客户端请求测试专用控制器，验证中英文错误、语言优先级和默认英文。测试使用回环地址和临时端口。
- [DataObjectMappingTest](java/io/ggboy/backend/persistence/DataObjectMappingTest.java) 验证每个 DO 对应的 Mapper、Service 接口和 Spring 实现的 MyBatis-Plus 泛型绑定，并逐列核对表名、列名、构造顺序、Java 类型和复合主键。测试使用仓库中的[数据库结构草案](../../../../docs/backend/schema.sql)。
- [VaultHistoryCursorTest](java/io/ggboy/backend/api/VaultHistoryCursorTest.java) 验证历史快照游标的网络和金库范围、无符号 slot 边界及异常编码。

- [LiquidationCursorTest](java/io/ggboy/backend/api/LiquidationCursorTest.java) 验证清算游标的查询范围、精确健康度和观测版本变化。 Verifies liquidation cursor scope, exact health factors, and observation changes.

在 `backend/` 目录执行 `mvn -pl ggboy-app -am test`。测试运行无需数据库。

[ActivityQueryTest](java/io/ggboy/backend/api/ActivityQueryTest.java) 验证交易活动筛选、重复类型与 64 字节签名校验。[ActivityCursorTest](java/io/ggboy/backend/api/ActivityCursorTest.java) 验证完整排序键、查询范围和错误编码。

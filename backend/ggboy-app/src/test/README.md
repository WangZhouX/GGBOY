# 应用契约测试

- [ApiErrorLanguageTest](java/io/ggboy/backend/api/ApiErrorLanguageTest.java) 使用 JDK HTTP 客户端请求测试专用控制器，验证中英文错误、语言优先级和默认英文。测试使用回环地址和临时端口。
- [DataObjectMappingTest](java/io/ggboy/backend/persistence/DataObjectMappingTest.java) 验证持久化对象的映射契约，并逐列核对表名、列名、构造顺序、Java 类型和复合主键。测试使用仓库中的[数据库结构草案](../../../../docs/backend/schema.sql)。

在 `backend/` 目录执行 `mvn -pl ggboy-app -am test`。测试运行无需数据库。

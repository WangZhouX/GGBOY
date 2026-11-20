# 共享契约测试

在后端根目录运行 `mvn -pl ggboy-common -am test`。测试使用 JUnit Jupiter。

- [ApiResponseTest](java/io/ggboy/common/api/ApiResponseTest.java) 验证成功与失败的互斥字段、各错误码的中英文提示、跨请求语言隔离和默认英文回退。
- [CursorPageTest](java/io/ggboy/common/api/CursorPageTest.java) 验证游标边界和分页列表的防御性复制。
- [SolanaNetworkTest](java/io/ggboy/common/api/SolanaNetworkTest.java) 验证网络标识的协议文本与非法输入。
- [UnsignedIntegerUtilTest](java/io/ggboy/common/tests/UnsignedIntegerUtilTest.java) 验证 `u64` 的范围、文本格式和无损往返。

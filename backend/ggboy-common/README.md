# ggboy-common

本模块是 JDK 25 的纯 Java 库。公共接口类型放在 `io.ggboy.common.api`，跨模块数值工具放在 `io.ggboy.common.utils`。

| 调用场景 | 公共类型 | 契约 |
| --- | --- | --- |
| 返回一次查询的结果 | `ApiResponse<T>`、`ApiError`、`ErrorCode` | 成功响应携带业务数据，失败响应携带稳定的错误码以及按请求语言选择的中英文提示 |
| 返回一页查询记录 | `CursorPage<T>` | `items` 按调用方提供的顺序保存，`nextCursor` 为空表示末页 |
| 读取或输出接口的网络参数 | `SolanaNetwork` | 使用小写协议值 `localnet` 或 `devnet` |
| 处理链上 slot 或一笔代币变动的最小单位数量 | `UnsignedIntegerUtil` | 在完整 `u64` 范围内校验数值，并在十进制字符串和 `BigInteger` 之间精确转换 |

应用模块负责 HTTP 状态与 JSON 序列化，核心模块负责 Mint、份额和债务等业务语义。配置与启动入口在 `ggboy-app`。可在后端根目录使用 `mvn -pl ggboy-common -am test` 单独运行公共模块的契约测试。

[公共 API 源码](src/main/java/io/ggboy/common/api/README.md) · [公共数值工具](src/main/java/io/ggboy/common/utils/README.md) · [契约测试](src/test/README.md) · [后端构建指南](../README.md)

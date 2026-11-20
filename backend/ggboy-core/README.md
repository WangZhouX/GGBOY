# ggboy-core

纯 Java 的业务模型供查询服务和链上索引复用。模块名为 `io.ggboy.core`，导出 `io.ggboy.core.asset` 包，依赖 JDK 标准库和 [ggboy-common](../ggboy-common/README.md) 提供的无符号整数校验。

[代币金额包](src/main/java/io/ggboy/core/asset/README.md)中的 `TokenAmount` 是不可变的 Java record，表示一次 SPL Token 变动。它保存 Mint、代币小数位和以最小单位表示的数量。Mint 必须是解码后为 32 字节的 Base58 公钥，小数位来自链上 Mint（0 到 255），原始数量使用 `BigInteger` 覆盖整个 `u64` 范围。查询和索引的调用方负责选择网络并核对实际 Mint 账户。

在后端根目录使用 OpenJDK 25 运行 `mvn -pl ggboy-core -am package`，生成核心模块 JAR。金额的持久化精度和十进制传输格式分别见[实体索引](../ggboy-app/src/main/java/io/ggboy/backend/entity/README.md)和[公共数值工具](../ggboy-common/src/main/java/io/ggboy/common/utils/README.md)。

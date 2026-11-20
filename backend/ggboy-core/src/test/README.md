# 核心模块测试

[TokenAmountTest](java/io/ggboy/core/asset/TokenAmountTest.java) 使用 JUnit Jupiter 验证 SPL 数量在 `u64` 边界上的行为，以及 Base58 公钥的前导零处理和解码字节数。测试使用固定输入，在后端根目录执行 `mvn -pl ggboy-core -am test` 即可运行。

[返回核心模块](../../README.md)

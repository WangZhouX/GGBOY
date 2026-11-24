# 链上索引测试

覆盖 RPC 响应、Anchor 事件解码和 Devnet 历史签名分页。单元测试不连接 Devnet 或 PostgreSQL。在后端根目录执行 mvn test 运行。

[VaultSnapshotRpcTest.java](VaultSnapshotRpcTest.java) 覆盖纯现金金库的同一 slot 读取、SPL 账户校验和整数金额解码。

[LendingActivityDecoderTest.java](LendingActivityDecoderTest.java) 使用真实 Devnet 日志中的四类借款事件数据及独立构造的出借提取日志，覆盖签名人、调用来源、原始日志位置和无符号金额精度。[FinalizedSignatureScanTest.java](FinalizedSignatureScanTest.java) 覆盖程序检查点连续性和单轮扫描上限。

# 链上索引测试

覆盖 RPC 响应、Anchor 事件解码和 Devnet 历史签名分页。单元测试不连接 Devnet 或 PostgreSQL。在后端根目录执行 mvn test 运行。

[VaultSnapshotRpcTest.java](VaultSnapshotRpcTest.java) 覆盖纯现金及策略金库的同一 slot 读取、SPL 账户校验、PDA 派生、价格过期与借贷流动性舍入。

[LendingActivityDecoderTest.java](LendingActivityDecoderTest.java) 使用真实 Devnet 日志中的四类借款事件数据及独立构造的出借存取日志，覆盖签名人、调用来源、原始日志位置和无符号金额精度。[FinalizedSignatureScanTest.java](FinalizedSignatureScanTest.java) 覆盖程序检查点连续性和单轮扫描上限。

[LendingLiquidationActivityTest.java](LendingLiquidationActivityTest.java) 覆盖清算签名、两种 Mint、正常清算及单独坏账核销，以及按原始日志序号去重。 Covers the liquidation signer, both mints, standard liquidation and write-off-only activity, and deduplication by the original log index.

[VaultStrategyActivityTest.java](VaultStrategyActivityTest.java) 覆盖策略事件的 Anchor 字段顺序、原始日志序号、无符号金额、Mint 绑定和回滚事件过滤，并用内存 Mapper 核对三种策略动作、参与方、资产变动和去重。

[LendingOraclePublicationTest.java](LendingOraclePublicationTest.java) 覆盖价格发布的身份和原始 slot、已证实交易证据缓存、更新交易无法读取时的缺价行为。[LendingRiskBatchTest.java](LendingRiskBatchTest.java) 覆盖同槽资金分类、健康度阈值、金额舍入与缺少价格的风险状态。[LendingInterestProjectionTest.java](LendingInterestProjectionTest.java) 对照链上计息纪元、向上取整、小端 u128 布局和资金池溢出约束。

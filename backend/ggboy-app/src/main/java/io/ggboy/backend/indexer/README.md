# Devnet 业务索引

## 金库存赎与策略活动

Spring Boot 启动后，定时读取已登记金库程序在 Devnet 上最终确认的交易。该流程独立于前端钱包和余额刷新，沿用 PostgreSQL 活动表和现有列表、回执 API。

- [VaultActivityIndexer.java](VaultActivityIndexer.java) 按 RPC 签名顺序分批补扫。找到已保存的检查点后，从旧到新逐笔处理。
- [VaultActivityRpc.java](VaultActivityRpc.java) 通过只读 JSON-RPC 获取签名页及交易详情。
- [VaultActivityDecoder.java](VaultActivityDecoder.java) 识别 Anchor 金库存赎、兑换、金库出借及资金收回事件，保留事件在原始交易日志中的位置。
- [VaultActivityStore.java](VaultActivityStore.java) 通过现有 Mapper 校验金库和 Mint 登记。在同一个事务里保存活动、参与方、资产明细和新的扫描边界。

首次启动读取节点可提供的历史，之后从检查点补扫离线期间及新确认的交易。失败的链上交易和没有已知金库事件的交易只推进检查点。签名页缺少已保存的边界、交易日志不完整或数据库写入失败时，保留最近已提交的检查点并重试。设置、登记及验收见[后端 README](../../../../../../../../README.md)。

策略管理页以 `category=strategy` 和所选金库 PDA 查询成交。策略动作沿用原有活动表和索引检查点。兑换保存转出和转入两条资产变动，并核对已登记的策略 Mint。出借和收回各保存一条实际结算资产转账。参与角色为策略管理者和受益金库。

## 借款活动

- [LendingActivityIndexer.java](LendingActivityIndexer.java) 分批扫描借贷程序的最终确认签名，使用 [FinalizedSignatureScan.java](FinalizedSignatureScan.java) 找出与持久化检查点相邻的最早待处理记录，每轮最多处理八笔。
- 只读 RPC 核对交易签名、slot、执行结果和消息签名人。[AnchorTransactionLogs.java](AnchorTransactionLogs.java) 跟踪程序调用栈，[LendingActivityDecoder.java](LendingActivityDecoder.java) 识别借贷程序顶层成功调用发出的四类借款动作、出借资金存取和第三方清算，保留原始日志行序号。金库通过 CPI 发出的出借存入由策略索引呈现。
- [LendingActivityStore.java](LendingActivityStore.java) 核对市场和 Mint 登记，核对出借存取和清算事件的 Mint，把参与方及实际资产变动写入活动表。清算记录借款人和清算人，坏账按借款资产单列为账面损失。[ActivityIndexStore.java](ActivityIndexStore.java) 共用检查点和父交易写入逻辑。同一交易的活动和检查点原子提交，RPC 或数据库故障时从上次提交处重试。

交易活动页用 `category=lending` 查询。调度配置和市场登记见[后端 README](../../../../../../../../README.md#devnet-借款交易同步)。

## 每份净值走势数据

[VaultSnapshotCollector.java](VaultSnapshotCollector.java) 默认每轮后等待 30 秒，采集与当前 Devnet 程序匹配的已登记金库。未启用策略的金库沿用现金余额作为净值。[VaultSnapshotRpc.java](VaultSnapshotRpc.java) 核对金库、托管账户和 Mint 绑定，并在一个最终确认 slot 中读取估值输入。

链上启用策略后须在金库登记中关联策略 Mint 和借贷市场。[VaultStrategySnapshot.java](VaultStrategySnapshot.java) 追加核验同槽的策略配置、策略库存、测试预言机、Clock、借贷账本和托管账户。净值是托管现金、策略代币按有效价格折算的价值及金库出借份额账面价值之和。持有策略代币且缺少有效价格时，净值为空。旧池使用已记账资产扣除未偿本金计算可支出现金。已启用计息的池使用同槽 Clock 投影总债务，加上已入账现金计算出借份额价值，可收回现金仍受池中已入账现金和金库出借份额限制。金库快照记录来自链上 Vault 的自动收回能力和是否持有出借份额。自动收回开启后，投资者可在一笔赎回中用金库现金与当前可收回现金支付。测试预言机记录发布时间，快照的预言机发布 slot 字段为空。

采集结果追加至现有 vault_snapshot。本轮失败时历史记录仍可查询，下轮重试。同一或较旧 slot 跳过，复合主键兜底处理并发重复。历史接口按 slot 分页。图表使用观测时间作横轴，按资产与份额各自精度计算单份净值。总供给为零或存在缺价头寸时保留观测并将走势图断开。

## 借贷市场与清算风险观测

[LendingRiskSnapshotCollector.java](LendingRiskSnapshotCollector.java) 每轮读取 Devnet 已登记市场。[LendingRiskSnapshotRpc.java](LendingRiskSnapshotRpc.java) 并行查询托管、Mint 和 Clock 以及市场相关 PDA，再核对两份 RPC 响应的最终确认 slot、账户数据所有者、种子派生地址、市场绑定、借贷债务和出借份额汇总。借贷计息启用后，[LendingInterestProjection.java](LendingInterestProjection.java) 使用同槽 Clock 和与 Rust 一致的整数舍入计算应还债务和账面现金价值。旧版市场继续使用仓位本金。

[LendingOraclePublication.java](LendingOraclePublication.java) 根据链上价格、发布时间和管理员签名还原原始价格发布 slot。每轮重新发现最新最终确认签名，复用按签名和 slot 保存的已证实写入或只读证据，最多 128 笔。新签名无法证实时仍视为缺价。[LendingRiskBatch.java](LendingRiskBatch.java) 统一计算市场现金、可出借现金、钱包份额价值和清算健康度。等于清算阈值时保持安全。有债时缺少可验证价格则健康度为空。[LendingRiskSnapshotStore.java](LendingRiskSnapshotStore.java) 在可串行化事务中补齐缺失的规范价格源登记并发布市场及该槽的全部钱包快照，任何插入失败均回滚本批。

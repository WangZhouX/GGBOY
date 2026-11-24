# Devnet 业务索引

## 存赎活动

Spring Boot 启动后，定时读取已登记金库程序在 Devnet 上最终确认的交易。该流程独立于前端钱包和余额刷新，沿用 PostgreSQL 活动表和现有列表、回执 API。

- [VaultActivityIndexer.java](VaultActivityIndexer.java) 按 RPC 签名顺序分批补扫。找到已保存的检查点后，从旧到新逐笔处理。
- [VaultActivityRpc.java](VaultActivityRpc.java) 通过只读 JSON-RPC 获取签名页及交易详情。
- [VaultActivityDecoder.java](VaultActivityDecoder.java) 识别 Anchor 金库存赎事件，保留事件在原始交易日志中的位置。
- [VaultActivityStore.java](VaultActivityStore.java) 通过现有 Mapper 校验金库和 Mint 登记。在同一个事务里保存活动、参与方、资产明细和新的扫描边界。

首次启动读取节点可提供的历史，之后从检查点补扫离线期间及新确认的交易。失败的链上交易和没有存赎事件的交易只推进检查点。签名页缺少已保存的边界、交易日志不完整或数据库写入失败时，保留最近已提交的检查点并重试。设置、登记及验收见[后端 README](../../../../../../../../README.md)。

## 借款活动

- [LendingActivityIndexer.java](LendingActivityIndexer.java) 分批扫描借贷程序的最终确认签名，使用 [FinalizedSignatureScan.java](FinalizedSignatureScan.java) 找出与持久化检查点相邻的最早待处理记录，每轮最多处理八笔。
- 只读 RPC 核对交易签名、slot、执行结果和消息签名人。[AnchorTransactionLogs.java](AnchorTransactionLogs.java) 跟踪程序调用栈，[LendingActivityDecoder.java](LendingActivityDecoder.java) 识别借贷程序顶层成功调用发出的四类借款动作和出借资金提取，保留原始日志行序号。
- [LendingActivityStore.java](LendingActivityStore.java) 核对市场和 Mint 登记，核对提取事件的付款 Mint，把借款人或出借人及实际资产变动写入原活动表。[ActivityIndexStore.java](ActivityIndexStore.java) 共用检查点和父交易写入逻辑。同一交易的活动和检查点原子提交，RPC 或数据库故障时从上次提交处重试。

交易活动页用 `category=lending` 查询。调度配置和市场登记见[后端 README](../../../../../../../../README.md#devnet-借款交易同步)。

## 每份净值走势数据

[VaultSnapshotCollector.java](VaultSnapshotCollector.java) 默认每轮后等待 30 秒，采集与当前 Devnet 程序匹配且只持有现金的已登记金库。[VaultSnapshotRpc.java](VaultSnapshotRpc.java) 在同一最终确认的 RPC 响应中核对金库、现金托管账户和 Mint 绑定，并取得实际现金与 GG-V 总供给。

采集结果追加至现有 vault_snapshot。本轮失败时历史记录仍可查询，下轮重试。同一或较旧 slot 跳过，复合主键兜底处理并发重复。历史接口按 slot 分页。图表使用观测时间作横轴，按资产与份额各自精度计算单份净值。总供给为零时保留观测并将走势图断开。

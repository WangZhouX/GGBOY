# 策略金库指令

此目录定义 Anchor 指令账户约束、处理函数和交易事件。由 [`lib.rs`](../lib.rs) 接收调用，读取或写入 [`state/`](../state/README.md) 中定义的账户。涉及代币余额时通过 SPL Token 程序执行划转，存赎与策略额度计算共用 [`strategy_valuation.rs`](../strategy_valuation.rs)。

| 文件 | 职责 |
| --- | --- |
| [`initialize.rs`](initialize.rs) | 校验程序升级权限，创建金库、现金托管账户和 GG-V 份额 Mint。 |
| [`deposit.rs`](deposit.rs) | 校验存入账户，按存入前净值计算份额，收取测试 USDC 并铸造 GG-V。 |
| [`redeem.rs`](redeem.rs) | 计算赎回报价，按现金缺口选择是否收回出借资金，同笔销毁 GG-V 并支付测试 USDC。 |
| [`strategy.rs`](strategy.rs) | 初始化策略配置，启用自动收回，处理测试储备兑换和尾仓清理。 |
| [`strategy_lending.rs`](strategy_lending.rs) | 以金库 PDA 通过借贷程序 CPI 出借和收回资金，赎回复用同一提取逻辑。 |
| [`ping.rs`](ping.rs) | 声明用于验证程序调用的空账户上下文。 |

[返回源码说明](../README.md)

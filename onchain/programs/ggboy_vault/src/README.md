# 策略金库源码

- [`lib.rs`](lib.rs) 声明程序 ID 和 Anchor 指令入口，转发到各指令的处理函数。
- [`instructions/`](instructions/README.md) 按业务组织账户约束、处理函数和交易事件。
- [`state/`](state/README.md) 定义金库与策略配置的持久化 PDA 账户及其布局。
- [`errors.rs`](errors.rs) 集中定义链上业务错误。
- [`strategy_valuation.rs`](strategy_valuation.rs) 为存赎和策略资金操作共用，校验估值账户并计算现金、现货和出借份额价值。

[返回程序说明](../README.md)

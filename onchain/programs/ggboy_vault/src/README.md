# 策略金库源码

- `lib.rs` 声明程序 ID、初始化、存赎、策略交换及借贷指令和业务错误。
- `initialize.rs` 定义金库初始化账户约束和处理逻辑，依赖 Anchor、Solana 可升级程序加载器和原版 SPL Token Program。
- `deposit.rs` 定义存入账户约束、按操作前净值向下舍入的份额报价和代币流转。
- `redeem.rs` 定义赎回账户约束、按操作前净值向下舍入的现金报价、可选的出借资金自动收回及同笔销毁份额与付款。
- `state.rs` 定义原始金库状态，记录管理员、结算 Mint、托管账户、份额 Mint 和金库 PDA bump。代币余额和供给量保存在 SPL Token 账户中。
- `strategy.rs` 配置已初始化金库的策略账户与管理者，使用隔离的测试储备执行双向 SPL 转账。
- `strategy_lending.rs` 使用金库 PDA 通过 CPI 出借及收回测试资产，首笔建仓租金由策略管理者支付。管理者收回和投资者赎回复用同一个以金库 PDA 签名的提取 CPI。
- `strategy_valuation.rs` 校验估值账户，从现金、现货持仓、有效预言机价格和出借份额计算金库净值。原纯现金金库保留原调用方式。

[返回程序说明](../README.md)

# 策略金库源码

- `lib.rs` 声明程序 ID、Anchor 指令入口和业务错误。当前入口为 `initialize_vault`、`deposit`、`redeem` 和无需账户的 `ping`。
- `initialize.rs` 定义初始化账户约束和处理逻辑，依赖 Anchor、Solana 可升级程序加载器和原版 SPL Token Program。
- `deposit.rs` 定义存入账户约束、纯现金份额计算和代币流转。
- `redeem.rs` 定义赎回账户约束、纯现金到账金额计算和同笔销毁份额与付款。
- `state.rs` 定义 `Vault` 金库状态，记录管理员、结算 Mint、托管账户、份额 Mint 和金库 PDA bump。代币余额和供给量保存在 SPL Token 账户中。

[返回程序说明](../README.md)

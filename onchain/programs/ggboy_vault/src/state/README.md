# 策略金库状态

此目录定义由金库程序持久化的 Anchor 账户。[`instructions/`](../instructions/README.md) 使用这些账户验证签名人、资产绑定和策略配置，并在对应指令内执行状态变更。代币余额和份额供给量由 SPL Token 程序保存。

| 文件 | 职责 |
| --- | --- |
| [`vault.rs`](vault.rs) | 定义 `Vault`，记录管理员、结算 Mint、现金托管账户、份额 Mint 和金库 PDA bump，并声明策略启用后的扩展布局长度。 |
| [`vault_strategy.rs`](vault_strategy.rs) | 定义 `VaultStrategy`，记录所属金库、策略管理者、策略资产、借贷市场和资金操作上限。 |

[返回源码说明](../README.md)

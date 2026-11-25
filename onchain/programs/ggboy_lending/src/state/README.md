# 借贷市场链上状态

[mod.rs](mod.rs) 汇总按职责定义的 Anchor 账户类型及 PDA 种子，供[指令模块](../instructions/README.md)校验账户并读写状态。

| 模块 | 职责 |
| --- | --- |
| [market.rs](market.rs) | 市场管理员、两类资产 Mint、对应托管账户地址和市场签名 bump。 |
| [supply.rs](supply.rs) | 出借池的记账资产及总份额、出借钱包的份额仓位。 |
| [borrow.rs](borrow.rs) | 全市场借款总账、钱包抵押及债务仓位和执行后的仓位事件。 |
| [oracle.rs](oracle.rs) | 市场绑定的测试报价与链上发布时间。 |

出借份额和债务由各自的 PDA 记账。实际代币余额由市场 PDA 授权的原版 SPL Token 账户托管。可选计息启用时的账户扩展字段由 [interest.rs](../instructions/interest.rs) 读取和更新。

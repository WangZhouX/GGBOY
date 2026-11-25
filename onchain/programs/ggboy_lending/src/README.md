# 抵押借贷市场源码

| 入口 | 职责 |
| --- | --- |
| [lib.rs](lib.rs) | 声明程序地址、Anchor 指令入口和供 CPI 调用方使用的公开类型与查询函数。 |
| [instructions/](instructions/README.md) | 按业务组织交易的账户约束与处理逻辑，从市场初始化到出借、抵押借款与清算。 |
| [state/](state/README.md) | 定义市场、仓位和测试预言机的链上账户布局及 PDA 种子。 |
| [errors.rs](errors.rs) | 集中定义公开的业务校验错误，枚举顺序对应 Anchor 分配的错误编号。 |
| [risk.rs](risk.rs) | 提供借款和抵押提取共用的整数抵押额度计算。 |

业务指令使用 Anchor 账户约束，代币操作调用原版 SPL Token Program。各账户的 Mint、PDA 种子和权限关系见[程序说明](../README.md)。[Localnet 验收](../../../tests/README.md)覆盖市场初始化、出借与提取、抵押借款、计息和清算。

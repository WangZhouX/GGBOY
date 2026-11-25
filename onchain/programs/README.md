# 链上业务程序

| 程序 | 职责 | 源码 |
| --- | --- | --- |
| [ggboy_vault](ggboy_vault/README.md) | 策略金库初始化、存入与赎回、测试调仓、闲置资金出借与收回。 | [指令](ggboy_vault/src/instructions/README.md) · [账户状态](ggboy_vault/src/state/README.md) |
| [ggboy_lending](ggboy_lending/README.md) | 市场初始化、出借与提取、抵押借款、还款、计息和清算。 | [指令](ggboy_lending/src/instructions/README.md) · [账户状态](ggboy_lending/src/state/README.md) |

两个程序使用相同的源码目录结构。

| 路径 | 职责 |
| --- | --- |
| `src/lib.rs` | 声明程序 ID、汇总 Anchor 指令入口并转发到对应处理模块。 |
| `src/instructions/` | 定义指令需要的账户和约束，处理签名、状态更新和代币转移。 |
| `src/state/` | 定义链上持久化账户及其布局。 |
| `src/errors.rs` | 定义程序的自定义错误。 |

金库通过单向 CPI 向借贷池出借或提取资金。构建与本地测试入口见 [Anchor 工作区](../README.md)。

# 借贷市场指令

[lib.rs](../lib.rs) 将 Anchor 指令分发到本目录。每个模块将指令所需的账户约束与交易处理放在一起。[mod.rs](mod.rs) 注册处理模块并汇总客户端和 CPI 使用的账户类型。

| 模块 | 职责 |
| --- | --- |
| [initialize.rs](initialize.rs) | 验证程序升级权限，创建市场与两类 SPL 代币托管账户。 |
| [prepare_supply.rs](prepare_supply.rs) | 由独立签名付款人为市场出借总账和出借人仓位支付首次开户费用。 |
| [supply.rs](supply.rs) | 转入借款资产，按记账资产定价并增加出借份额。 |
| [withdraw_supply.rs](withdraw_supply.rs) | 校验份额、最低到账与资金池现金上限，退回借款资产。 |
| [collateral.rs](collateral.rs) | 追加或取回抵押品，取回时校验剩余抵押是否覆盖债务。 |
| [debt.rs](debt.rs) | 在价格、抵押额度和现金限制内发放借款，结算还款并更新个人与全池账本。 |
| [interest.rs](interest.rs) | 启用可选计息，读取兼容的记账扩展字段并按链上时钟计算债务和出借池估值。 |
| [oracle.rs](oracle.rs) | 由市场管理员发布测试报价，验证风险操作使用的报价时效。 |
| [liquidation.rs](liquidation.rs) | 按清算阈值、代偿限制和最低到账要求转移资产并处理坏账。 |
| [ping.rs](ping.rs) | 验证程序可以调用，无需传入链上账户。 |

指令读取并更新 [state/](../state/README.md) 的账户，复用 [risk.rs](../risk.rs) 的抵押额度计算，通过原版 SPL Token Program 转移代币。

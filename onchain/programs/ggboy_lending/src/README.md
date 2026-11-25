# 抵押借贷市场源码

- [lib.rs](lib.rs) 声明程序地址、Anchor 指令入口和借贷校验错误。`ping` 可用于验证入口。
- [initialize.rs](initialize.rs) 定义管理员、ProgramData、两种 SPL Mint 与三个待创建账户的约束，并将校验后的配置写入市场状态。
- [prepare_supply.rs](prepare_supply.rs) 允许由独立签名付款人出资建立市场总账和签名出借人的仓位。
- [supply.rs](supply.rs) 校验出借账户，按出借前的记账资产计算份额，转入 `mockUSDC` 并更新份额。
- [withdraw_supply.rs](withdraw_supply.rs) 校验出借人仓位与收款账户，按当前池净资产和现金限制赎回份额。
- [collateral.rs](collateral.rs) 校验 `tSOL` 托管与签名钱包，记录追加和取回抵押，取回时检查有债仓位的 LTV。
- [debt.rs](debt.rs) 校验 `mockUSDC` 资金池、出借账本和钱包余额，原子更新借款和还款对应的个人与总本金。
- [liquidation.rs](liquidation.rs) 核对清算钱包和当前价格，按最低到账约束原子偿付债务、扣划抵押，并将无法回收债务冲减出借资产。
- [oracle.rs](oracle.rs) 校验市场管理员签名，发布并验证具备时效性的测试价格。
- [risk.rs](risk.rs) 用整数和精度换算执行借款抵押额度检查。
- [state.rs](state.rs) 定义市场、出借、抵押借款和测试价格 PDA 的种子及持久化布局。托管代币余额由原版 SPL Token 账户持有，份额与债务由各自 PDA 记账。

业务指令使用 Anchor 账户约束，代币操作调用原版 SPL Token Program。各账户的 Mint、PDA 种子和权限关系见[程序说明](../README.md)。[Localnet 抵押借款验收](../../../tests/README.md#localnet-抵押借款全流程)覆盖四条借款指令及价格与流动性限制。

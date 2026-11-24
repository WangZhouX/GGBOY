# Devnet 借贷客户端

[devnetLendingPool.ts](devnetLendingPool.ts) 定义已部署的 Devnet 借贷程序及规范市场 PDA。市场首页通过公开 RPC 核验市场、两枚 Mint 与现金托管，取得已最终确认的池现金。在已连接钱包的出借流程中，同一最终确认观测还包括出借池账本 `SupplyPool`、钱包仓位 `SupplyPosition` 和钱包的关联 `mockUSDC` 代币账户。余额和份额以精确整数最小单位返回，账户布局来自[借贷程序状态](../../../../onchain/programs/ggboy_lending/src/state.rs)。

[supplyLendingPool.ts](supplyLendingPool.ts) 使用池记账资产和总份额预览本次出借。空池按 1:1 计份额，后续按比例向下取整。借款资产按 Mint 精度换算，出借份额为六位小数。交易编码使用整数 `u64` 金额和最低到账份额。客户端按 [Anchor IDL](ggboyLendingIdl.json) 准备指令，使用最新可核验报价模拟交易，再交给 Phantom 签名与广播。

查询回执时核验交易已最终确认且执行成功，并验证 `LendingSupply` 事件的程序、市场、借款 Mint、出借钱包与出借金额。事件的 `shares_out` 只表示本次到账。用户持有的累计份额从交易 slot 或更新位置的 `SupplyPosition.shares_raw` 读取。同一笔签名可用于重查确认状态与回执。

[supplyWithdrawalAmounts.ts](supplyWithdrawalAmounts.ts) 以同一最终确认 slot 的池记账资产、总份额、实际现金和未偿本金计算可提取额度，最大份额满足向下取整后的到账金额不超过池内可支付现金。[supplyLendingPool.ts](supplyLendingPool.ts) 使用同一口径重新校验待扣份额和最低到账，必要时在同一笔交易重建收款关联代币账户。最终确认后验证 `LendingSupplyWithdrawal` 事件中的实际扣减份额和实际到账，按回执 slot 刷新仓位和公共现金。部分或全部提取均更新原有仓位，全部提取后仍能读到零份额。

[borrowLendingPosition.ts](borrowLendingPosition.ts) 读同一最终确认的市场、借款位置、出借账本、现金、测试价格、链上时钟和两个钱包关联代币账户。校验规范 PDA、账户归属、资产 Mint、布局与精度，再以整数计算借款上限、可取回抵押和风险指标。借出由已入账现金覆盖，池会计保留已借出的未偿本金。程序运行时重新校验价格、仓位和流动性。

四类借款操作通过 Anchor 指令构造和无签名模拟，再交给 Phantom 签名与广播。借款和取回抵押品的收款关联账户可随操作创建。最终确认后，从匹配的 `LendingBorrowAction` 事件核对操作及其实际金额。链上读取以交易 slot 为下限。

[readBorrowActivity.ts](readBorrowActivity.ts) 查询当前市场和钱包的规范借款仓位地址所关联的已最终确认交易，并筛选该程序发出的已成功执行的借款操作事件。最多展示最近六条，刷新时复用已经核验的回执，按时间从新到旧逐笔补查缺失回执，取得六条记录后停止。RPC 限流或日志暂时缺失时保留已核验记录，并允许重新拉取缺失回执。

市场目录与索引指标由 HTTP 接口提供。 [借贷页面和操作流程](../../pages/lending/README.md)

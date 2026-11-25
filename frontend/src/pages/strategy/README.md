# 策略管理

[StrategyPage.tsx](StrategyPage.tsx) 对应 `/strategy`。展示金库资产净值、现金、策略现货、出借价值和操作限额。已核验的链上观测用于实时展示，RPC 不可用时可查看带来源标记的最新后端数据。即时赎回额度包括金库现金，以及启用自动收回时能在同一笔交易从借贷池收回的金额。

[StrategyRouteLayout.tsx](StrategyRouteLayout.tsx) 负责在管理首页与各操作页之间保留网络及金库，复用金库目录和链上查询。已部署的策略配置决定管理者、币种与阈值。配置缺失、无管理权限或链上数据不可验证时禁止签名。

[StrategyOperationPage.tsx](StrategyOperationPage.tsx) 组装 `/strategy/swap`、`/strategy/lend` 与 `/strategy/recall` 三个表单。核对后冻结输入、输出下限及方向，用 Phantom 签名。广播后使用原签名核对，不在状态未知时重新提交。实际转账金额取自链上事件。

[StrategyRecentActivity.tsx](StrategyRecentActivity.tsx) 复用共享活动列表及回执，按网络、金库地址和策略分类展示已索引记录。页面样式保存在 [styles](styles/README.md)。

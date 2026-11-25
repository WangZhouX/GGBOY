# 资产总览

[OverviewPage.tsx](OverviewPage.tsx) 对应 <code>/overview</code>。上方显示 Devnet SOL、钱包可用代币和仓位，下方提供金库、借贷、策略管理和交易活动入口。入口随链接传递当前网络，仓位详情同时保留其来源金库或市场。页面样式位于 [styles](styles/README.md)。

[DevnetWalletBalance.tsx](DevnetWalletBalance.tsx) 通过现有 Phantom 连接和 [getDevnetSolBalance.ts](../../solana/getDevnetSolBalance.ts) 读取钱包 SOL 余额。

[DevnetPortfolioPositions.tsx](DevnetPortfolioPositions.tsx) 使用 [useDevnetPortfolio.ts](useDevnetPortfolio.ts) 复用业务页的 Devnet 部署目录和读链缓存，展示钱包关联账户可用的 mockUSDC 与 tSOL、GG-V 份额及估值、出借份额及估值、借款抵押与债务。mockUSDC 兼作结算和借款资产，其钱包余额只显示一次。钱包余额、份额估值和债务各自展示。

钱包连接且顶栏选中 Devnet 时读取这些公开数据。各仓位独立显示加载、失败或部署缺失，失败的读数可用「刷新资产与仓位」重新查询。零余额与无法读取或估值的状态有不同的展示。切换钱包以新公钥查询，断开或切换到 Localnet 时移除仓位。

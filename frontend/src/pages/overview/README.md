# 资产总览

[OverviewPage.tsx](OverviewPage.tsx) 对应 `/overview`，上方是 Devnet 钱包余额，下方提供金库、借贷、策略管理和交易活动入口。入口随链接传递当前网络。页面样式位于 [styles](styles/README.md)。

[DevnetWalletBalance.tsx](DevnetWalletBalance.tsx) 通过现有的 Phantom 连接层取得钱包公钥。顶栏选中 Devnet 且钱包已连接时，调用 [getDevnetSolBalance.ts](../../solana/getDevnetSolBalance.ts) 读取 SOL 余额。查询按公钥切换，离开该网络、断开钱包或切到未授权账户会清空页面上的余额。余额有加载、失败重试和成功状态，成功时可以手动刷新。

# 交易活动与回执

[ActivityPage.tsx](ActivityPage.tsx) 对应公开的 /activity。进入页面按网络加载首屏，分类、钱包公钥、金库或市场公钥及交易签名保存在 URL 中。点击「加载更多」沿用当前筛选和服务端游标。「刷新记录」回到首屏读取新记录。查询与回执均无需钱包连接。

选择 Devnet 和「借贷」分类，可查看后端同步的存入抵押品、借入资金、偿还借款、取回抵押品和提取出借资金。列表和回执显示借款人或出借人、实际代币数量和资产流向。回执还展示完整市场地址、Mint 和交易签名。

[ActivityFiltersForm.tsx](ActivityFiltersForm.tsx) 负责输入校验及提交。[共享活动表格](../../features/activity/components/ActivityRecords.tsx) 展示每条事件的资产变动、参与方和区块时间，并生成到具体事件的回执链接。每条事件由网络、签名和事件序号标识。

[ActivityReceiptPage.tsx](ActivityReceiptPage.tsx) 支持直接打开回执链接。页面使用路由中的签名、事件序号和网络查询。回执显示完整参与方、Mint 地址、实际代币金额和来源程序。从活动列表进入时，「返回交易活动」会恢复列表筛选。从策略金库进入时，「返回策略金库」会恢复所选金库。Devnet 回执可以打开 Solana Explorer；本地回执保留链上身份信息。

请求方法和响应类型放在 [features/activity](../../features/activity/README.md)。样式位于 [styles](styles/README.md)。金库、借贷和策略页面的活动区可使用相同接口传入各自的分类、业务地址和钱包筛选。

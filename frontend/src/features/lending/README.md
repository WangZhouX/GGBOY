# 借贷业务

[LendingNavigation.tsx](LendingNavigation.tsx) 提供市场概况、借款、出借和清算之间的导航。导航保留当前网络和已选市场，并由 React Router 标记所选页面。[lending-navigation.css](lending-navigation.css) 定义子导航的换行和布局。

[api](api/README.md) 按功能维护独立请求。资金池现况调用市场列表接口，返回当前网络登记与最新观测。依赖索引的「我的借款」和「我的出借」调用同一个接口，读取指定网络、市场和钱包的最新仓位。

[useLendingMarket.ts](useLendingMarket.ts) 提供当前网络的市场查询和选中市场解析，由市场首页和仓位页面共用。[useLendingPosition.ts](useLendingPosition.ts) 将当前选择和钱包公钥交给仓位查询，并按网络、市场和钱包隔离缓存。

[useDevnetSupplyPosition.ts](useDevnetSupplyPosition.ts) 为已登记的 GGBOY Devnet 市场提供直接读链。市场首页使用公共现金查询键，「我的出借」和出借操作页共享按市场与钱包隔离的仓位查询。`syncDevnetSupply` 以最终确认交易的 slot 为下限读取账户，把同一次已校验的观测写入两个缓存，并按 [lendingQueryKeys.ts](lendingQueryKeys.ts) 的市场前缀刷新受现金变化影响的借款观测。切换钱包或断开后，页面根据当前钱包读取或清空展示。

[useDevnetBorrowPosition.ts](useDevnetBorrowPosition.ts) 为「我的借款」和四条借款操作路由提供共用的链上状态。按当前网络、市场和钱包分离缓存。交易最终确认后，`syncDevnetBorrow` 以该交易 slot 为下限读取抵押、未偿本金和池内现金，触发对应视图刷新。最近操作读取借款仓位交易历史，切换钱包后只显示新钱包数据。

路由入口位于 [pages/lending](../../pages/lending/README.md)。

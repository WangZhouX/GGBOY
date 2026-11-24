# 交易活动业务

这里提供交易活动、单笔回执的查询，以及列表和回执共用的显示逻辑。路由、筛选表单和对应的页面样式位于[交易活动页面目录](../../pages/activity/README.md)。

- [components](components/README.md) 提供全站交易活动页和策略金库页共用的活动表格。
- [api](api/README.md) 封装两条查询接口及数据契约，可供金库、借贷等业务页复用。
- [activityIdentifiers.ts](activityIdentifiers.ts) 校验 Solana 公钥、交易签名和事件序号。
- [activityDisplay.ts](activityDisplay.ts) 格式化区块时间和代币数量，优先使用后端按网络与 Mint 匹配的代币简称，并在列表和回执中说明借贷资产的实际流向。

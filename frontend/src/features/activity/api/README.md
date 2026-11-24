# 交易活动查询接口

[listActivities.ts](listActivities.ts) 请求活动列表。交易活动页可按分类、钱包、业务地址和签名查询。各业务页可传入自己的钱包、业务状态账户和事件类型使用同一个入口。加载下一页时保留筛选条件并传入后端返回的游标。

[getActivityReceipt.ts](getActivityReceipt.ts) 按网络、交易签名和事件序号读取一条回执。不同业务页可以链接到同一回执路由。

两个请求复用 [公共 HTTP 客户端](../../../shared/api/README.md)，由 [activityResponse.ts](activityResponse.ts) 检查共有的数据结构。金额保留最小单位整数字符串。代币简称来自同一网络与 Mint 的资产目录，旧版响应可缺省。区块时间和末页游标允许为 null。

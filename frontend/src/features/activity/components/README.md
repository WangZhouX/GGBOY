# 交易活动共享组件

[ActivityRecords.tsx](ActivityRecords.tsx) 用于交易活动页和业务页的活动表格，接收已查询的事件，根据路由生成回执链接。它保留实际资产变动、区块时间和回执入口，精简布局省略已由业务页限定的分类和参与方。列表返回条件使用当前页面的筛选或金库地址。

组件通过 [activity API](../api/README.md) 定义的数据类型和业务格式化函数显示记录。查询状态和页面布局由各路由页面管理。样式在 [styles](styles/README.md)。

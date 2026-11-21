# 数据访问层

`io.ggboy.backend.mapper` 集中维护与 13 个持久化对象一一对应的 MyBatis-Plus 接口。每个接口以 `Mapper` 结尾，用 `@Mapper` 标记并继承 `BaseMapper<对应DO>`，由 Spring 注册为可注入的代理。例如 [ChainEventMapper](ChainEventMapper.java) 对应 [ChainEventDO](../entity/ChainEventDO.java)。完整表清单见[实体索引](../entity/README.md)。

这些表都使用复合主键。插入可使用继承的 `insert`。按主键查询、更新或删除单行时，条件须包含该表的全部主键列。MyBatis-Plus 的 `selectById`、`updateById`、`deleteById` 等单 ID 方法不适用于这些表。

首期计划按事件键分页，再加载参与方和资产明细，保证同一事件只占一个分页名额。业务查询将在对应功能实现时添加，事务由[服务层](../service/README.md)组织。

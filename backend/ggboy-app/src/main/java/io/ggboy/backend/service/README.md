# 业务服务层

本包提供 13 个单表服务接口，命名为 `XxxService`，统一继承 MyBatis-Plus 的 `IService<XxxDO>`。调用方通过构造器注入所需的服务接口。例：[ChainEventService](ChainEventService.java) 由 [ChainEventServiceImpl](impl/ChainEventServiceImpl.java) 实现，使用 [ChainEventMapper](../mapper/ChainEventMapper.java) 访问业务事件。

服务继承基础持久化操作，例如 `save(entity)` 和 `count()`。所有表均使用复合主键。对一条记录做查询、更新或删除时，条件应包含全部键列，避免使用依赖单主键的 `getById`、`updateById`、`removeById` 和 `saveOrUpdate(entity)`。

交易活动分页和跨表写入将在对应业务开发阶段实现。事件及其参与方、资产明细的写入应由同一业务事务管理。[实现包](impl/README.md) · [持久化对象与复合键](../entity/README.md)

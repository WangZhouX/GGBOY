# 业务服务层

本包提供 13 个单表服务接口，命名为 `XxxService`，统一继承 MyBatis-Plus 的 `IService<XxxDO>`。调用方通过构造器注入所需的服务接口。例：[ChainEventService](ChainEventService.java) 由 [ChainEventServiceImpl](impl/ChainEventServiceImpl.java) 实现，使用 [ChainEventMapper](../mapper/ChainEventMapper.java) 访问业务事件。

服务继承基础持久化操作，例如 `save(entity)` 和 `count()`。所有表均使用复合主键。对一条记录做查询、更新或删除时，条件应包含全部键列，避免使用依赖单主键的 `getById`、`updateById`、`removeById` 和 `saveOrUpdate(entity)`。

[VaultService](VaultService.java) 提供金库列表、钱包最新持仓和历史快照查询。历史查询确认金库登记后按 slot 分页，并由实际返回的末条记录生成续页游标。持仓使用同一只读事务读取目录、钱包快照和同 slot 的金库快照，并核对可赎回份额与预计到账。

[ChainEventService](ChainEventService.java) 提供交易活动分页和单条回执。列表按游标筛选，回执按网络、签名和事件序号精确匹配。两者各在同一个只读事务中查询，并共享参与方和资产变动的组装。跨表写入将在后续阶段实现，事件和明细的写入使用同一业务事务。[实现包](impl/README.md) · [持久化对象与复合键](../entity/README.md)

[LendingMarketService](LendingMarketService.java) 提供借贷市场目录、资金池现况和钱包借贷仓位。在同一只读事务中读取市场登记、借款及抵押资产精度和最新资金池快照。尚未采集快照的市场仍列在响应中。 钱包仓位先取最后一次观测，再匹配同市场、同网络及同 slot 的市场快照。资料不足的额度返回空值。

[LendingLiquidationService](LendingLiquidationService.java) 为借贷页面的「清算市场」提供首屏和续页查询。用户进入页面、切换网络或市场时加载首页，继续浏览时传入上一页游标。接口返回当前市场观测状态，状态可用时才提供报价和最新可清算仓位。

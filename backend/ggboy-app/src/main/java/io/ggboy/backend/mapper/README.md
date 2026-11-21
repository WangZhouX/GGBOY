# 数据访问层

`io.ggboy.backend.mapper` 集中维护与 13 个持久化对象一一对应的 MyBatis-Plus 接口。每个接口以 `Mapper` 结尾，用 `@Mapper` 标记并继承 `BaseMapper<对应DO>`，由 Spring 注册为可注入的代理。例如 [ChainEventMapper](ChainEventMapper.java) 对应 [ChainEventDO](../entity/ChainEventDO.java)。完整表清单见[实体索引](../entity/README.md)。

这些表都使用复合主键。插入可使用继承的 `insert`。按主键查询、更新或删除单行时，条件须包含该表的全部主键列。MyBatis-Plus 的 `selectById`、`updateById`、`deleteById` 等单 ID 方法不适用于这些表。

活动查询先用 [ChainTransactionMapper](ChainTransactionMapper.java) 按 slot 和签名倒序分批读取交易，再在候选交易内按业务类型、主体和参与钱包确定本页事件。[ChainEventParticipantMapper](ChainEventParticipantMapper.java) 与 [ChainEventAssetMapper](ChainEventAssetMapper.java) 按网络及本页的精确事件键批量补全明细。多个钱包角色或资产变动共享一个事件名额。事务由[服务层](../service/README.md)组织。

「查看交易回执」由 [ChainEventMapper](ChainEventMapper.java) 按网络、交易签名和事件序号精确查询事件，由 [ChainTransactionMapper](ChainTransactionMapper.java) 按同一网络和签名读取父交易。参与方与资产变动复用活动列表的精确事件键查询，只传入该回执的一个事件键。

金库列表查询在 Mapper 接口的 default 方法里使用 MyBatis-Plus LambdaQueryWrapper。目录和 Mint 使用类型安全的条件与排序。快照按网络和金库地址读取，按 slot 降序在数据库取一条。

「我的金库份额」查询按网络和地址读取金库目录，按网络、金库和钱包取最新持仓，再用网络、金库和持仓 slot 匹配估值所需的金库快照。

「每份净值走势」的 [VaultSnapshotMapper](VaultSnapshotMapper.java) 按网络和金库地址读取历史快照，以数值 slot 降序排列。续页只读取严格早于游标 slot 的记录。请求页最多读取页面大小加一条，供服务判断是否有后续记录。

「资金池现况」使用 [LendingMarketMapper](LendingMarketMapper.java) 按网络读取市场登记，并由 [LendingMarketSnapshotMapper](LendingMarketSnapshotMapper.java) 按网络和市场地址查询快照，每个市场按数值 slot 降序在数据库取一条。

「我的借款」与「我的出借」共用借贷仓位查询。先按网络和地址确认市场登记，再由 [LendingPositionSnapshotMapper](LendingPositionSnapshotMapper.java) 按网络、市场和钱包读取最新仓位，最后按完整复合主键匹配同一 slot 的市场快照。

「清算市场」先按网络和市场地址读取最新市场快照，再以该快照的 slot 为基准，按健康度和钱包地址升序分批读取可排序仓位。每批额外查询一次钱包地址，识别在同一市场已存在更高 slot 仓位的钱包。服务层剔除这些钱包后再校验清算资格。

活动候选交易、金库及借贷市场和钱包的最新快照、金库历史快照以及清算仓位扫描使用 MyBatis-Plus Page 限制返回行数。分页由 [QueryPaginationConfiguration](QueryPaginationConfiguration.java) 调用框架的 PostgreSQL 方言处理，查询不计总行数。

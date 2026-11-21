# 基础服务实现

本包中的单表 `XxxServiceImpl` 使用 Spring `@Service` 注册，继承 `ServiceImpl<XxxMapper, XxxDO>`，并实现对应的 [XxxService 接口](../README.md)。基类注入与泛型匹配的 [Mapper](../../mapper/README.md)。例如 [VaultServiceImpl](VaultServiceImpl.java) 将 `VaultService` 绑定到 `VaultMapper` 和 `VaultDO`，并注入金库及钱包快照 Mapper，用于读取历史快照和「我的金库份额」。历史快照每页额外读取一条以判断是否还有下一页，持仓查询计算当前可赎回的份额上限。

[ChainEventServiceImpl](ChainEventServiceImpl.java) 按数据库中的 slot 和签名顺序分批读取父交易，按交易内事件序号倒序收集匹配项。确认一页事件后，按本页事件键批量加载完整的参与方和资产变动。单条回执先按完整事件键查询，再取对应父交易，并复用列表的明细组装。列表与回执均通过服务接口开启独立的只读事务。

[LendingMarketServiceImpl](LendingMarketServiceImpl.java) 按网络读取借贷市场登记，批量加载借款和抵押 Mint 元数据，并按市场地址关联最新池快照。服务保留原始金额和观测利率，为已采集快照附上新鲜度标记。 仓位查询保留钱包最后观测，按钱包和市场观测各自的新鲜度决定可确认的上限。清算临界价格使用市场阈值、计息债务和两种资产精度。

[LendingLiquidationServiceImpl](LendingLiquidationServiceImpl.java) 在同一只读事务中检查市场及预言机观测，再扫描发布批次中的仓位。每批先排除拥有更新观测的钱包，再筛选可清算仓位。结果按健康度和钱包地址升序排列，续页游标绑定已验证的市场 slot 和预言机报价版本。

# 数据库持久化对象

`io.ggboy.backend.entity` 统一维护 13 张表、97 个字段的行映射。每个 record 的名称由表名转为大驼峰并追加 `DO`，通过 `@TableName` 和 `@TableField` 关联 PostgreSQL 表和列。

| PostgreSQL 表 | Java 类型 | 对应数据 |
| --- | --- | --- |
| `chain_transaction` | [ChainTransactionDO](ChainTransactionDO.java) | 交易签名、所在 slot 和时间 |
| `chain_event` | [ChainEventDO](ChainEventDO.java) | 按交易日志序号定位的业务事件 |
| `chain_event_participant` | [ChainEventParticipantDO](ChainEventParticipantDO.java) | 参与事件的钱包或 PDA 及其角色 |
| `chain_event_asset` | [ChainEventAssetDO](ChainEventAssetDO.java) | 一次资产变动的 Mint、精度、数量和方向 |
| `indexer_checkpoint` | [IndexerCheckpointDO](IndexerCheckpointDO.java) | 已连续处理的交易边界与更新时间 |
| `asset_mint` | [AssetMintDO](AssetMintDO.java) | 登记的 Mint、代币程序、符号与精度 |
| `vault` | [VaultDO](VaultDO.java) | 金库地址、计价和份额 Mint、可选借贷市场 |
| `vault_snapshot` | [VaultSnapshotDO](VaultSnapshotDO.java) | 金库净值、策略资产、出借价值和可用现金 |
| `vault_position_snapshot` | [VaultPositionSnapshotDO](VaultPositionSnapshotDO.java) | 钱包持有的份额、份额价值和当前可赎回额 |
| `lending_market` | [LendingMarketDO](LendingMarketDO.java) | 市场地址、借款 Mint 和抵押 Mint |
| `lending_market_snapshot` | [LendingMarketSnapshotDO](LendingMarketSnapshotDO.java) | 市场现金、未偿债务、利率与风险参数 |
| `lending_position_snapshot` | [LendingPositionSnapshotDO](LendingPositionSnapshotDO.java) | 钱包仓位、抵押数量、债务及可清算状态 |
| `risk_alert` | [RiskAlertDO](RiskAlertDO.java) | 触发提醒的市场、钱包、观测 slot、规则类型和创建时间 |

## 读写约定

- 还原 DO 时查询该表的全部列，按列名与构造参数名匹配。自定义 SQL 保留字段对应的列标签。只选取部分字段或跨表聚合时，使用与返回列对应的查询类型。
- 这 13 张表都使用复合主键。按主键读、改、删时，在 Mapper 的条件中逐一指定组成列。例如定位一条交易需要同时传入 `network` 和 `signature`。单 ID 方法无法表达这个条件。每个键列的 `@TableField` 使用 `updateStrategy = FieldStrategy.NEVER`，让 MyBatis-Plus 在根据实体生成 `SET` 时跳过该列。
- 两种零小数位的 `numeric` 均映射为 `BigInteger`，覆盖 Solana u64 及 39 位累计量。`health_factor` 用 `BigDecimal` 保留 12 位小数，`timestamptz` 用 `OffsetDateTime` 表示时刻。可空的 `is_liquidatable` 使用 `Boolean`，区分“尚无法判定”和“不可清算”。

各 DO 的类注释列出完整主键与字段含义。业务库的 Flyway 建表迁移按各业务阶段实施。

# 数据访问层

`io.ggboy.backend.mapper` 放置 MyBatis-Plus Mapper，使用[实体包](../entity/README.md)中的 DO 读写 PostgreSQL。首期交易活动涉及交易、业务事件、参与方和资产变动四张表。分页先取得一页事件的键，再按键读取明细，使同一事件的多条资产变动只占一个分页名额。数据库事务由[服务层](../service/README.md)组织。

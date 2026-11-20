# HTTP 控制层

`io.ggboy.backend.controller` 放置业务 HTTP 控制器。首期规划入口为 `GET /api/v1/activities`。控制器接收网络、钱包、业务类型和分页参数，校验后调用[服务层](../service/README.md)，向前端返回带参与方和资产明细的事件列表。

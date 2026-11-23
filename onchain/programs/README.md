# 链上业务程序

- [ggboy_vault](ggboy_vault/README.md) 负责策略金库与资产份额，已实现金库初始化、存入和纯现金赎回。
- [ggboy_lending](ggboy_lending/README.md) 负责抵押借贷池。

两个程序各自定义账户和指令。集成后，金库通过单向 CPI 调用借贷程序。构建命令见 [Anchor 工作区](../README.md)。

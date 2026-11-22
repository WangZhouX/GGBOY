# Solana 客户端边界

这里留给 Phantom 钱包连接、Solana RPC、Anchor IDL 与交易预览和提交。接入时由业务模块调用这里的客户端，并用当前网络的公开配置选择 RPC、程序 ID 和 Mint。用户钱包负责签名。

业务页面的快照、活动和回执通过 [HTTP 客户端](../shared/api/README.md) 读取。钱包配置、链上交易和后端索引各由对应模块处理。

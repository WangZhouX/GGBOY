# Solana 客户端边界

[phantomWallet.tsx](phantomWallet.tsx) 封装 Phantom 注入的 Solana 接口。应用入口通过 `PhantomWalletProvider` 共享当前已授权的钱包公钥，顶栏和业务页通过 `usePhantomWallet()` 读取。点击连接后取得钱包公钥。Phantom 切换到另一个已授权账户时更新地址，断开或切换到未授权账户时清除地址。连接状态保存在当前页面，整页刷新后可再次点击连接。

本地联调时，在安装 Phantom 的浏览器中通过 `localhost` 或 `127.0.0.1` 打开前端，点击「连接 Phantom」并在钱包中确认。部署页面通过 HTTPS 提供钱包接入。钱包连接提供公开地址，查询所在网络由 GGBOY 顶栏的网络选择器决定。 [Phantom 浏览器接入说明](https://docs.phantom.com/solana/detecting-the-provider)

Solana RPC、Anchor IDL 与交易预览和提交后续也放在这里。业务模块将使用当前网络的公开配置选择 RPC、程序 ID 和 Mint。用户钱包负责签名。

业务页面的快照、活动和回执通过 [HTTP 客户端](../shared/api/README.md) 读取。钱包配置、链上交易和后端索引各由对应模块处理。

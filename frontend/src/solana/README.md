# Solana 客户端边界

[phantomWallet.tsx](phantomWallet.tsx) 封装 Phantom 注入的 Solana 接口。应用入口通过 `PhantomWalletProvider` 共享当前已授权的钱包公钥，顶栏和业务页通过 `usePhantomWallet()` 读取。点击连接后取得钱包公钥。Phantom 切换到另一个已授权账户时更新地址，断开或切换到未授权账户时清除地址。连接状态保存在当前页面，整页刷新后可再次点击连接。

本地联调时，在安装 Phantom 的浏览器中通过 `localhost` 或 `127.0.0.1` 打开前端，点击「连接 Phantom」并在钱包中确认。部署页面通过 HTTPS 提供钱包接入。钱包连接提供公开地址，查询所在网络由 GGBOY 顶栏的网络选择器决定。 [Phantom 浏览器接入说明](https://docs.phantom.com/solana/detecting-the-provider)

连接期间，顶栏提示在 Phantom 解锁和确认，也可以点击「取消等待」。页面等待最多 60 秒，取消或超时后可重新发起连接，旧请求迟到的结果会被忽略。授权窗口由 Phantom 管理，若仍有待处理的弹窗，需要在 Phantom 中关闭或完成它。

[getDevnetSolBalance.ts](getDevnetSolBalance.ts) 通过 Solana 公开 Devnet RPC 的 `getBalance` 查询已确认的 SOL 余额。请求只使用公开钱包地址，返回精确的 `bigint` lamports，1 SOL 等于 10 亿 lamports。调用方可传入取消信号。 [Solana `getBalance` 文档](https://solana.com/docs/rpc/http/getbalance)

[vault](vault/README.md) 使用公开部署配置和 Anchor IDL 读取 Devnet 金库或构造存入和赎回指令。Phantom 适配层确认当前账户后请求签名和广播，金库客户端根据签名检查交易结果。[browserBuffer.ts](browserBuffer.ts) 在应用初始化时提供 SPL Token 编解码所需的浏览器 Buffer 实现。

[lending](lending/README.md) 对已登记的 GGBOY Devnet 借贷市场读取并核验池内现金、出借仓位、借款仓位与测试价格。前端构造并模拟出借和四类借款操作，再通过 Phantom 请求签名和广播。交易回执和最近借款操作来自已最终确认的链上事件。

业务页面的索引快照、活动和历史回执通过 [HTTP 客户端](../shared/api/README.md) 读取。钱包配置、链上交易和后端索引各由对应模块处理。

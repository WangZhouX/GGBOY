# 策略金库

页面、区块和图表组件在本目录，各自的 CSS 位于 [styles](styles/README.md)。HTTP 请求及类型定义在 [features/vault/api](../../features/vault/api/README.md)。

[VaultPage.tsx](VaultPage.tsx) 是 /vault 主页。首屏按原型分为左右两栏。左侧是「我的金库份额」及存赎入口，由 [VaultPositionSection.tsx](VaultPositionSection.tsx) 展示仓位。右侧将所选金库的「金库资产与每份净值」和「即时赎回资金来源」分成上下两组，由 [VaultOverviewCards.tsx](VaultOverviewCards.tsx) 渲染。窄屏按仓位与操作、公开资产与支付来源的顺序折为单列。走势图及最近交易继续在首屏信息下方。

[VaultRouteLayout.tsx](VaultRouteLayout.tsx) 在主页及两个操作页之间共享网络、所选金库、会话钱包和查询缓存。金库目录从当前网络加载。多个已登记金库时显示选择器，选择通过 vault 查询参数保留。匹配公开配置的 Devnet 纯现金金库每 30 秒读取实际账户余额和份额供给，其他金库使用已有后端接口。没有连接钱包也可读公开信息。通过顶栏或份额区连接 Phantom 后展示钱包份额和对应入口。断开钱包后隐藏该钱包的数据。点击「刷新我的份额」会重查当前仓位。

快照中的 `sharesRaw` 使用份额 Mint 的精度。`positionValueRaw` 和 `redeemableRaw` 使用计价 Mint 的精度。尚未读取时提示数据暂未更新，空估值显示「暂无数据」，已知零值显示为 `0`。金库概况和份额均显示上次更新时间。后端标记数据较旧时，赎回资金与钱包可赎回金额标为「上次估算」。

## 存入金库

主页面的「存入金库」打开 /vault/deposit。[VaultOperationPage.tsx](VaultOperationPage.tsx) 负责页面、返回入口和可用性，[VaultDepositSection.tsx](VaultDepositSection.tsx) 渲染独立存入流程，样式见 [vault-transaction.css](styles/vault-transaction.css)。连接启用 Solana Devnet 的 Phantom 后，输入最多六位小数的 mockUSDC，或点击「全部」填入可存余额。扣款从钱包的 mockUSDC 关联账户发起。空金库中，输入 100 应预计收到 100 GG-V，默认最低接受 99.5 GG-V。

点击「下一步，核对交易」先核对支付金额、预计获得和最低获得份额。返回修改可以重新输入，链上报价发生变化时也会要求重新核对。点击「在 Phantom 中确认存入」后，页面才构造并模拟交易。首次存入在同一笔交易里创建 GG-V 关联账户。钱包用 Devnet SOL 支付交易和新账户费用。Phantom 返回签名后，页面查询 Devnet 的执行结果。确认后立即更新概况、钱包份额和钱包余额，且读链 slot 至少达到成交 slot。确认暂时未知时保留签名和有效期，可重新查同一笔交易。用户可以在区块浏览器核对结果。

当前交易入口需要后端目录中的已部署 Devnet 金库（参见 [Devnet 金库登记](../../../../docs/backend/vault-api-design.md#登记-devnet-金库目录)）与公开配置一致。净值历史仍从后端查询。

## 赎回金库份额

「我的金库份额」中的赎回入口打开 /vault/redeem，由 [VaultRedeemSection.tsx](VaultRedeemSection.tsx) 展示独立操作。输入要销毁的 GG-V，或点「全部」填入可用份额。页面用同一确认 slot 的托管余额和份额总量计算预计到账，默认最多允许 0.5% 的报价偏差。mockUSDC 支付到发起钱包的关联账户。首次收款时在同一笔交易中创建该账户。

钱包持有多个 GG-V 代币账户时，优先从单个余额足够的账户赎回。需要合并时，链上交易先把所需份额归集到一个来源账户，再按总输入赎回一次。若单笔交易容纳不下所有账户，页面会提示减少该次赎回的份额。

[VaultTransactionSection.tsx](VaultTransactionSection.tsx) 供存入和赎回共享模拟、签名、按签名查询确认和确认后的刷新流程。同一钱包在该金库有一笔结果未明的交易时，先核对该笔签名。进入确认阶段前须核对金额、预计到账和最少到账。确认后刷新至不早于交易的 slot。从操作页返回会保留网络和所选金库。若当前仍是 100 mockUSDC 对 100 GG-V，先赎回 40 GG-V 应到账 40 mockUSDC，再按「全部」赎回剩余 60 GG-V。

## 每份净值走势

[VaultNavHistorySection.tsx](VaultNavHistorySection.tsx) 使用 [listVaultSnapshots.ts](../../features/vault/api/listVaultSnapshots.ts) 查询历史，所选金库确定后即可加载，无需连接钱包。`useInfiniteQuery` 按网络和金库地址缓存已加载的页。首屏省略 `cursor`，使用后端默认 20 条。点击「加载更早数据」后原样传回 `nextCursor`。点击「刷新净值走势」从首屏开始重查已加载的历史。

Devnet 在页面处于前台且只有首屏时，每隔约 60 秒重查最新观测。加载更早的数据后，切回页面或恢复网络时继续使用已加载的范围，可用「刷新净值走势」主动更新整段历史。所查看的观测仍在已加载范围内时，图表按 slot 保留选择。

[VaultNavChart.tsx](VaultNavChart.tsx) 以 UTC 观测时间排序并绘制快照，使用金库目录中的两种 Mint 精度换算每份净值。净值缺失或总份额为零时断开折线。查询区样式在 [vault-nav-history.css](styles/vault-nav-history.css)，图表样式在 [vault-nav-chart.css](styles/vault-nav-chart.css)。

图表点详情与纵轴使用相同的小数位数，随快照净值之间的差距调整。横轴两端落在同一秒时显示原始小数秒。双圈标记代表多条观测落在同一绘图位置，可用「上一条观测」和「下一条观测」逐条查看。

## 最近金库交易

[VaultRecentActivitySection.tsx](VaultRecentActivitySection.tsx) 位于净值走势下方，样式位于 [vault-recent-activity.css](styles/vault-recent-activity.css)。连接钱包并确定所选金库后，区块按当前网络、金库和钱包查询最近四条存入或赎回。未连接钱包时提示连接。点击「刷新金库交易」可重查，点击「查看全部金库交易」进入带网络、钱包和金库筛选的全站活动页。

存赎成功后，余额按已有读链流程更新，活动列表同时重查。链上已确认但列表尚无记录时，区块每四秒重查，最多自动等九十秒。显示已有记录并提示同步中，超时后可手动刷新。切换网络、钱包或金库时使用不同的查询键。从区块打开回执后，可以返回同一网络和所选金库。

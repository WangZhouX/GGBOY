# 策略金库

页面、区块和图表组件在本目录，各自的 CSS 位于 [styles](styles/README.md)。HTTP 请求及类型定义在 [features/vault/api](../../features/vault/api/README.md)。

[VaultPage.tsx](VaultPage.tsx) 是 /vault 入口。「金库概况」读取站点当前网络，挂载时由 TanStack Query 使用该网络的缓存或调用 [listVaults](../../features/vault/api/listVaults.ts)。切换网络会切换查询键，点击刷新或重试会重新查询当前网络。未连接钱包时也可以查看。

成功返回后，`items` 的每条记录交给同目录的 [VaultOverviewCards.tsx](VaultOverviewCards.tsx) 生成该金库的估值和赎回资金卡片，卡片样式在 [vault-overview-cards.css](styles/vault-overview-cards.css)。页面负责处理加载、接口出错和未登记金库的状态。[vault-page.css](styles/vault-page.css) 定义概况标题、刷新和状态提示的布局。

「我的金库份额」位于概况下方。页面区块写在同目录的 [VaultPositionSection.tsx](VaultPositionSection.tsx)，样式在 [vault-position.css](styles/vault-position.css)。[getVaultPosition.ts](../../features/vault/api/getVaultPosition.ts) 提供 HTTP 请求方法与请求、响应类型。

[VaultPage.tsx](VaultPage.tsx) 维护「所选金库」。默认选择当前网络的首个已登记金库，切换后同时更新「我的金库份额」和「每份净值走势」。通过顶部「连接 Phantom」取得公钥后，且列表已给出金库地址，才查询仓位。更换网络、金库或钱包时读取对应查询。断开钱包后隐藏份额。点击「刷新我的份额」可重查当前仓位。

快照中的 `sharesRaw` 使用份额 Mint 的精度。`positionValueRaw` 和 `redeemableRaw` 使用计价 Mint 的精度。空快照显示等待同步，空估值显示「暂无数据」，已知零值正常显示为 `0`。过期快照展示采集时间及过期状态。

## 每份净值走势

[VaultNavHistorySection.tsx](VaultNavHistorySection.tsx) 使用 [listVaultSnapshots.ts](../../features/vault/api/listVaultSnapshots.ts) 查询历史，所选金库确定后即可加载，无需连接钱包。`useInfiniteQuery` 按网络和金库地址缓存已加载的页。首屏省略 `cursor`，使用后端默认 20 条。点击「加载更早数据」后原样传回 `nextCursor`。点击「刷新净值走势」从首屏开始重查已加载的历史。

[VaultNavChart.tsx](VaultNavChart.tsx) 以 UTC 观测时间排序并绘制快照，使用金库目录中的两种 Mint 精度换算每份净值。净值缺失或总份额为零时断开折线。查询区样式在 [vault-nav-history.css](styles/vault-nav-history.css)，图表样式在 [vault-nav-chart.css](styles/vault-nav-chart.css)。

图表点详情与纵轴使用相同的小数位数，随快照净值之间的差距调整。横轴两端落在同一秒时显示原始小数秒。双圈标记代表多条观测落在同一绘图位置，可用「上一条观测」和「下一条观测」逐条查看。

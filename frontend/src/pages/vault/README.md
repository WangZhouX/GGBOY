# 策略金库

页面、区块和图表组件在本目录，各自的 CSS 位于 [styles](styles/README.md)。HTTP 请求及类型定义在 [features/vault/api](../../features/vault/api/README.md)。

[VaultPage.tsx](VaultPage.tsx) 是 /vault 入口。「金库概况」读取站点当前网络，挂载时由 TanStack Query 使用该网络的缓存或调用 [listVaults](../../features/vault/api/listVaults.ts)。切换网络会切换查询键，点击刷新或重试会重新查询当前网络。未连接钱包时也可以查看。对已登记的 Devnet 现金金库，页面以实际账户余额和份额供给展示概况。前台页面每 30 秒读链，手动刷新也会重读。暂时读链失败时可显示上次已知的数据和更新时间。

成功返回后，`items` 的每条记录交给同目录的 [VaultOverviewCards.tsx](VaultOverviewCards.tsx) 生成该金库的估值和赎回资金卡片，卡片样式在 [vault-overview-cards.css](styles/vault-overview-cards.css)。页面负责处理加载、接口出错和未登记金库的状态。[vault-page.css](styles/vault-page.css) 定义概况标题、刷新和状态提示的布局。

「我的金库份额」位于概况下方。页面区块写在同目录的 [VaultPositionSection.tsx](VaultPositionSection.tsx)，样式在 [vault-position.css](styles/vault-position.css)。[getVaultPosition.ts](../../features/vault/api/getVaultPosition.ts) 提供 HTTP 请求方法与请求、响应类型。

[VaultPage.tsx](VaultPage.tsx) 维护「所选金库」。默认选择当前网络的首个已登记金库，切换后同时更新「我的金库份额」和「每份净值走势」。通过顶部「连接 Phantom」取得公钥后，且列表已给出金库地址，才查询仓位。已支持的 Devnet 金库直接读链，钱包份额、托管现金和总供给取自同一个确认 slot。其他金库按后端仓位接口查询。更换网络、金库或钱包时读取对应查询。断开钱包后隐藏份额。点击「刷新我的份额」可重查当前仓位。

快照中的 `sharesRaw` 使用份额 Mint 的精度。`positionValueRaw` 和 `redeemableRaw` 使用计价 Mint 的精度。尚未读取时提示数据暂未更新，空估值显示「暂无数据」，已知零值显示为 `0`。金库概况和份额均显示上次更新时间。后端标记数据较旧时，赎回资金与钱包可赎回金额标为「上次估算」。

## 存入金库

[VaultDepositSection.tsx](VaultDepositSection.tsx) 是已登记 Devnet 金库的存入入口，样式见 [vault-transaction.css](styles/vault-transaction.css)。连接启用 Solana Devnet 的 Phantom 后，输入最多六位小数的 mockUSDC，或点击「全部」填入可存余额。扣款从钱包的 mockUSDC 关联账户发起。空金库中，输入 100 应预计收到 100 GG-V，默认最低接受 99.5 GG-V。

点击「在 Phantom 中确认存入」后，页面先构造并模拟交易。首次存入在同一笔交易里创建 GG-V 关联账户。钱包用 Devnet SOL 支付交易和新账户费用。Phantom 返回签名后，页面查询 Devnet 的执行结果。确认后立即更新概况、钱包份额和钱包余额，且读链 slot 至少达到成交 slot。确认暂时未知时保留签名和有效期，可重新查同一笔交易。用户可以在区块浏览器核对结果。

当前交易入口需要后端目录中的已部署 Devnet 金库（参见 [Devnet 金库登记](../../../../docs/backend/vault-api-design.md#登记-devnet-金库目录)）与公开配置一致。净值历史仍从后端查询。

## 赎回金库份额

[VaultRedeemSection.tsx](VaultRedeemSection.tsx) 位于「我的金库份额」下方。输入要销毁的 GG-V，或点「全部」填入可用份额。页面用同一确认 slot 的托管余额和份额总量计算预计到账，默认最多允许 0.5% 的报价偏差。mockUSDC 支付到发起钱包的关联账户。首次收款时在同一笔交易中创建该账户。

钱包持有多个 GG-V 代币账户时，优先从单个余额足够的账户赎回。需要合并时，链上交易先把所需份额归集到一个来源账户，再按总输入赎回一次。若单笔交易容纳不下所有账户，页面会提示减少该次赎回的份额。

[VaultTransactionSection.tsx](VaultTransactionSection.tsx) 供存入和赎回共享模拟、签名、按签名查询确认和确认后的刷新流程。同一钱包在该金库有一笔结果未明的交易时，先核对该笔签名。确认后刷新至不早于交易的 slot。若当前仍是 100 mockUSDC 对 100 GG-V，先赎回 40 GG-V 应到账 40 mockUSDC，再按「全部」赎回剩余 60 GG-V。

## 每份净值走势

[VaultNavHistorySection.tsx](VaultNavHistorySection.tsx) 使用 [listVaultSnapshots.ts](../../features/vault/api/listVaultSnapshots.ts) 查询历史，所选金库确定后即可加载，无需连接钱包。`useInfiniteQuery` 按网络和金库地址缓存已加载的页。首屏省略 `cursor`，使用后端默认 20 条。点击「加载更早数据」后原样传回 `nextCursor`。点击「刷新净值走势」从首屏开始重查已加载的历史。

[VaultNavChart.tsx](VaultNavChart.tsx) 以 UTC 观测时间排序并绘制快照，使用金库目录中的两种 Mint 精度换算每份净值。净值缺失或总份额为零时断开折线。查询区样式在 [vault-nav-history.css](styles/vault-nav-history.css)，图表样式在 [vault-nav-chart.css](styles/vault-nav-chart.css)。

图表点详情与纵轴使用相同的小数位数，随快照净值之间的差距调整。横轴两端落在同一秒时显示原始小数秒。双圈标记代表多条观测落在同一绘图位置，可用「上一条观测」和「下一条观测」逐条查看。

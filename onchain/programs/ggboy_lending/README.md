# 抵押借贷市场

`ggboy_lending` 是独立的 Anchor 借贷程序。`initialize_lending_market` 在同一笔交易中建立市场和两类托管账户，每个程序部署对应一个市场。

## 初始化账户

| 账户 | 地址或来源 | 职责 |
| --- | --- | --- |
| 市场状态 `LendingMarket` | PDA 种子 `["lending_market"]` | 借贷程序记录管理员、两种 Mint、两个托管账户和规范 bump。 |
| 借款资金池 `cash_vault` | PDA 种子 `["cash_vault", market]` | 托管六位小数的借款资产 `mockUSDC`，初始余额为零。 |
| 抵押托管账户 `collateral_vault` | PDA 种子 `["collateral_vault", market]` | 托管测试抵押资产 `tSOL`，初始余额为零，精度沿用所选 Mint。 |

两类托管账户均由原版 SPL Token Program 持有账户数据，代币操作权限由市场 PDA 持有。初始化前需准备两个不同且已初始化的原版 SPL Token Mint，均为非原生代币。市场以 Mint 公钥标识资产。`mockUSDC` 和 `tSOL` 是测试中的显示名称。

管理员必须持有当前借贷部署的升级权限，由该部署的 ProgramData 验证。管理员签名并支付三个新账号的免租金余额。重复初始化会失败。账户地址或 Mint 校验失败会回滚同一笔交易中的账户创建。

## 出借

出借人签名调用 `supply(assets_in, min_shares_out)`。指令从签名人持有的原版 SPL 代币账户转入市场已经绑定的六位小数 `mockUSDC`，并增加个人的借贷池份额。两项参数均为非零 `u64`，分别按资产和份额的最小单位计。出借人支付首次创建所需的免租金余额。

| 账户 | PDA 种子 | 记录内容 |
| --- | --- | --- |
| `SupplyPool` | `["supply_pool", market]` | 市场公钥、已计入份额定价的资产 `accounted_assets_raw` 和总出借份额 `total_shares_raw`。 |
| `SupplyPosition` | `["supply_position", market, supplier]` | 市场公钥、出借人公钥和持有份额 `shares_raw`。 |

首次成功出借时创建份额汇总和出借人的仓位，其他钱包首次成功出借时创建其各自的仓位。份额以六位小数计，是借贷程序内不可转让的记录，与策略金库的 `GG-V` 份额独立。升级沿用原有市场、两类 Mint 和托管 PDA，保留 `LendingMarket` 的 169 字节布局。

以出借前的记账资产 `A` 和总份额 `S` 定价。空池 `A = S = 0` 时，收到的资产最小单位与新增份额最小单位一比一。已有出借时，按 `floor(assets_in × S ÷ A)` 计算，乘法使用 `u128`，商向下取整，结果与累加值受 `u64` 范围约束。记账资产与总份额只有一项为零，或报价向下取整后为零时，指令会拒绝。当前出借仍按 1:1 记账。例如存入 100 mockUSDC 得到 100 份。直接调用 SPL 转账转入池内的代币只增加托管现金，未计入出借份额定价。

程序校验市场和托管地址、签名人与来源账户的归属、绑定的 Mint、余额及最低到账份额。转账、池份额与个人仓位更新，以及 `LendingSupply` 事件在同一笔交易中完成。事件按顺序记录 `market`、`supplier`、`debt_mint`、`assets_in` 和 `shares_out`。任何校验或代币操作失败时，整笔出借回滚。

贷款发放和偿还只在池内现金与借款本金之间划转价值，`SupplyPool.accounted_assets_raw` 和总份额保持其原有会计口径。出借人可以在池中仍有未还本金时继续出借，份额仍按已记账资产计算。

## 提取出借资金

出借人签名调用 `withdraw_supply(shares_raw, min_amount_out_raw)`。两个参数分别以六位份额最小单位和借款 Mint 最小单位计，均须大于零。指令按市场、出借钱包核对原有 `SupplyPool` 与 `SupplyPosition`；收款账户须持有市场绑定的 `mockUSDC` 并由该出借人控制。程序以市场 PDA 授权托管账户付款。`BorrowMarket` 采用规范 PDA，尚未建立的旧市场按零本金处理。

设 `A` 为池记账资产，`S` 为池总份额，`D` 为全池未偿本金，`C` 为托管现金，`q` 为提取份额。使用最小单位与整数计算。

```text
到账金额 = floor(q × A ÷ S)
当前可支付现金 = min(C, A − D)
```

链上检查份额属于签名钱包，到账非零且不低于指令指定的最低额，并且不超过当前可支付现金。成功后同一笔交易减少个人份额、池总份额和记账资产，并将 `mockUSDC` 从托管账户转回钱包。全额提取使个人份额归零，保留原仓位 PDA，已登记账户布局无需迁移。现金不足时整笔拒绝，借款人还款可恢复可提取额。提取无需测试价格。

成功时发出 `LendingSupplyWithdrawal`，依次记录市场、出借人、借款 Mint、实际扣除份额、实际到账和剩余份额。后端用实际到账建立「交易活动」回执。

## 抵押与借款

新增账户保留已有市场和出借账户的 PDA 与序列化布局，兼容已完成初始化和出借的市场。

| 账户 | 规范 PDA 种子 | 字段布局 |
| --- | --- | --- |
| `BorrowPosition` | `["borrow_position", market, borrower]` | 市场公钥、借款人公钥、抵押最小单位 `collateral_raw: u64`、未偿本金 `debt_raw: u64`。共 88 字节，含 Anchor 判别符。 |
| `BorrowMarket` | `["borrow_market", market]` | 市场公钥、合计未偿本金 `total_debt_raw: u64`。共 48 字节，含 Anchor 判别符。 |
| `MockCollateralPrice` | `["mock_collateral_price", market]` | 市场公钥、价格 `price_raw: u64`、链上发布时间 `published_at: i64`。共 56 字节，含 Anchor 判别符。 |

借款人签名并使用本人对应 Mint 的代币账户。所有指令负责检查规范 PDA、绑定市场与 Mint、代币权限、账户余额和正整数 `u64` 金额。代币转账和状态更新在一笔交易中原子处理。

| 指令 | 资产动作 | 记账与限制 |
| --- | --- | --- |
| `deposit_collateral(amount_raw)` | 将 `tSOL` 转入抵押托管 | 新用户首次成功存入创建 `BorrowPosition`。按抵押 Mint 的精度增加抵押品。 |
| `borrow(amount_raw)` | 从池转出 `mockUSDC` 到钱包 | 增加个人和市场本金。要求有效价格，并同时覆盖可借现金和借款后 LTV 上限。 |
| `repay(amount_raw)` | 将 `mockUSDC` 转回池 | 同时减少个人和市场本金，恢复现金。每笔金额最多为当前本金。 |
| `withdraw_collateral(amount_raw)` | 从抵押托管转出 `tSOL` 到钱包 | 有债务时按有效价格校验取回后的 LTV。无债务时允许取回该仓位全部抵押。 |

`set_mock_collateral_price(price_raw)` 由 `LendingMarket.administrator` 签名。操作时用链上 Clock 写入发布时间。价格为每 1 整单位 `tSOL` 对应的六位小数 `mockUSDC` 金额，须大于零，在 7 天有效期内方可增加债务或从有债务的仓位取回抵押。追加抵押、还款和无债务取回的校验无需价格。

设 `C` 为抵押最小单位，`D` 为个人本金最小单位，`P` 为 `price_raw`，`Q = 10^抵押 Mint 精度`。借款 LTV 上限为 7000 基点，健康度参考的清算阈值为 8000 基点。

```text
池可供借出 = min(托管现金, 出借记账资产 − 全池未偿本金)
最高本金 = floor(C × P × 7000 ÷ (Q × 10000))
可新增本金 = min(池可供借出, max(0, 最高本金 − D))
有债务需保留抵押 = ceil(D × Q × 10000 ÷ (P × 7000))
健康度 = C × P × 8000 ÷ (Q × 10000 × D)，其中 D > 0
```

托管现金与全池未偿本金须覆盖出借账本的资产。单纯通过 SPL 转账增加现金不会提高已记账的可借上限。借款本金与全池本金同时变化，偿还时方向相反。当前版本按本金结算，80% 阈值用于健康度展示。

每笔成功的四类操作发出一个 `LendingBorrowAction`，字段依次为 `market`、`borrower`、`kind: u8`、`amount_raw`、`collateral_raw`、`debt_raw`。操作代码 0、1、2、3 分别对应追加抵押、借款、还款和取回抵押品。事件的两项余额反映执行后的仓位。

- [源码结构](src/README.md)
- [工作区构建](../../README.md)
- [Localnet 借贷市场初始化验收](../../tests/README.md#localnet-借贷市场初始化)
- [Localnet 出借和程序升级验收](../../tests/README.md#localnet-借贷市场出借与升级)
- [Localnet 抵押借款全流程验收](../../tests/README.md#localnet-抵押借款全流程)
- [已部署的 Devnet 市场及公开地址](../../README.md#devnet-借贷市场部署与登记)

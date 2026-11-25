# 链上初始化与测试价格脚本

## 策略金库

`initialize-vault.mjs` 向已部署的 GGBOY 金库程序发送 `initialize_vault`。程序在同一笔交易内创建金库状态、测试 USDC 托管账户及 GG-V 份额 Mint。资产创建和测试币发放由部署者通过 `spl-token` 完成。

### 准备

- 使用 Node.js 22 或更高版本。在 `onchain` 根目录运行 `anchor build`，生成 `target/idl/ggboy_vault.json`。
- 已在目标测试环境部署可升级的金库程序，本地管理员 keypair 持有这份部署的升级权限，钱包有足够的对应网络测试 SOL 支付初始化。
- 已在同一网络创建六位小数的经典 SPL 测试 USDC Mint。记录其公钥作为 `GGBOY_ASSET_MINT`，并将部署钱包的绝对路径设为 `GGBOY_ADMIN_KEYPAIR`。

### 初始化 Devnet

在 `onchain` 目录执行：

```bash
npm --prefix scripts ci
node scripts/initialize-vault.mjs \
  --network devnet \
  --rpc-url https://api.devnet.solana.com \
  --admin-keypair "$GGBOY_ADMIN_KEYPAIR" \
  --asset-mint "$GGBOY_ASSET_MINT"
```

默认程序公钥来自构建后的 IDL，也可以用 `--program-id` 明确传入。初始化成功后，标准输出为 JSON，包括程序地址、两种 Mint、金库状态及托管账户地址、已确认的交易签名。现金及份额供给均以最小单位字符串输出。相同参数重跑会读取并校验已有配置，返回 `already-initialized`。配置不匹配时停止，并输出错误信息。

脚本先从 RPC 读创世哈希确认连接的是 Devnet。Localnet 用相同参数运行，将网络改为 `localnet`，RPC 改为本机验证器地址，例如 `http://127.0.0.1:8899`。程序的 Localnet 预载与验收见 [Localnet 验收](../tests/README.md)。

## 启用金库策略

[initialize-vault-strategy.mjs](initialize-vault-strategy.mjs) 为已存在的金库启用策略管理和测试兑换。脚本要求同一测试网络已部署支持此功能的金库与借贷程序，并已初始化金库与借贷市场。使用当前构建的 `target/idl/ggboy_vault.json` 和 `target/idl/ggboy_lending.json`。启用交易由原金库管理员签名，创建策略配置、金库的策略资产托管和两个独立兑换储备。管理员一次性配置管理者钱包、出借后的最低现金储备、出借估值上限和单笔兑换上限。

在 `onchain/` 运行。结算资产参数使用金库和借贷市场共同绑定的六位小数测试 Mint，策略资产参数使用该市场绑定的九位小数测试抵押 Mint。以下比例是演示设置，三个基点参数分别代表 10%、70% 和 50%。

```bash
strategy_args=(
  --network devnet
  --rpc-url "$GGBOY_RPC_URL"
  --asset-mint "$GGBOY_ASSET_MINT"
  --strategy-mint "$GGBOY_TSOL_MINT"
  --manager "$GGBOY_MANAGER_ADDRESS"
  --reserve-bps 1000
  --lending-cap-bps 7000
  --max-trade-bps 5000
)
node scripts/initialize-vault-strategy.mjs "${strategy_args[@]}"
node scripts/initialize-vault-strategy.mjs "${strategy_args[@]}" --execute --admin-keypair "$GGBOY_ADMIN_KEYPAIR"
```

只读命令验证网络、账户与资产对，输出公开地址、配置和两类储备余额。省略管理者和三个比例可查看当前设置。首次启用前返回 `not-initialized`。带 `--execute` 的命令完成交易后返回 `initialized` 和签名。相同设置已生效时返回 `already-initialized`，配置不同会报错。Localnet 设置 `--network localnet`、本机回环 RPC 和该环境的两枚 Mint。

首次配置后的测试兑换储备余额为零。将只读 JSON 中的 `swapCash` 和 `swapStrategy` 分别保存为 `GGBOY_SWAP_CASH` 和 `GGBOY_SWAP_STRATEGY`，再由持有测试代币的测试钱包补足两边储备。下面是补充 200 mockUSDC 和 2 tSOL 的示例，金额以完整代币为单位。

```bash
spl-token --url "$GGBOY_RPC_URL" transfer "$GGBOY_ASSET_MINT" 200 "$GGBOY_SWAP_CASH" \
  --owner "$GGBOY_RESERVE_FUNDER_KEYPAIR" --fee-payer "$GGBOY_RESERVE_FUNDER_KEYPAIR"
spl-token --url "$GGBOY_RPC_URL" transfer "$GGBOY_TSOL_MINT" 2 "$GGBOY_SWAP_STRATEGY" \
  --owner "$GGBOY_RESERVE_FUNDER_KEYPAIR" --fee-payer "$GGBOY_RESERVE_FUNDER_KEYPAIR"
```

策略兑换使用借贷市场的[测试价格](#借贷市场测试价格)。对已启用策略的金库，`initialize-vault.mjs` 也能读取原管理员、现金和份额绑定。

## 借贷市场

[initialize-lending-market.mjs](initialize-lending-market.mjs) 向已部署的借贷程序发送 `initialize_lending_market`。准备同一测试网络上的六位小数经典 SPL `mockUSDC` Mint、独立的经典 SPL 测试 `tSOL` Mint，以及持有借贷程序升级权限和测试 SOL 的本地管理员。完成 `anchor build` 以生成借贷 IDL。

在 `onchain` 目录执行下列命令。变量分别设为测试管理员密钥文件及两枚 Devnet Mint 的公钥。

```bash
npm --prefix scripts ci
node scripts/initialize-lending-market.mjs \
  --network devnet \
  --rpc-url https://api.devnet.solana.com \
  --admin-keypair "$GGBOY_ADMIN_KEYPAIR" \
  --debt-mint "$GGBOY_MOCK_USDC_MINT" \
  --collateral-mint "$GGBOY_TSOL_MINT"
```

传入的两个 Mint 都应已达到最终确认。脚本根据创世哈希核对网络，读取已部署程序的升级权限，通过 IDL 编码指令，并等待初始化交易最终确认。JSON 结果包含市场 PDA、两类托管地址、两个 Mint 和各自精度、初始化签名，以及同一最终确认 slot 的两类托管余额和 UTC 观测时间。余额以各自资产的最小单位表示。用相同配置重跑会校验现有市场并返回 `already-initialized`，无需再提交交易。

Localnet 可以将网络和 RPC 改为 `localnet` 和本机验证器地址，同时传入该环境的管理员及测试 Mint。Localnet 验证器配置见[借贷初始化验收](../tests/README.md#localnet-借贷市场初始化)。

## 借贷市场测试价格

[set-lending-mock-price.mjs](set-lending-mock-price.mjs) 为 GGBOY 借贷市场发布和查询测试价格。准备当前借贷 IDL、脚本依赖、市场登记的两枚 Mint，以及用于发布的市场管理员文件。以下从 `onchain/` 运行，示例价格为每 1 tSOL 等于 100 mockUSDC。

```bash
npm --prefix scripts ci
node scripts/set-lending-mock-price.mjs \
  --network devnet \
  --rpc-url https://api.devnet.solana.com \
  --admin-keypair "$GGBOY_ADMIN_KEYPAIR" \
  --debt-mint "$GGBOY_MOCK_USDC_MINT" \
  --collateral-mint "$GGBOY_TSOL_MINT" \
  --price 100
```

用 `--read-only` 替代 `--admin-keypair` 及 `--price` 连同两者的参数，就可以只读核验同一市场价格。输出包含价格、发布时间、最后确认的 slot 和交易签名。对同一价格再次发布会更新有效期。Localnet 使用 `--network localnet`、本机回环 RPC 和该环境的两枚 Mint。借款规则见[借贷程序](../programs/ggboy_lending/README.md#抵押与借款)。

## 启用自动收回和计息

[enable-finance-features.mjs](enable-finance-features.mjs) 读取链上启用状态，也可由原账户管理员显式提交启用交易。在已存在的 Devnet 部署上，先升级金库和借贷程序，再启用自动收回与计息。自动收回要求金库已经启用策略。计息要求出借池已经创建、旧借款本金余额为零，且代币托管余额覆盖旧账本。脚本使用当前 Anchor 构建产出的 IDL。

在 `onchain/` 运行下面的只读检查：

```bash
finance_args=(--network devnet --rpc-url "$GGBOY_RPC_URL")
node scripts/enable-finance-features.mjs "${finance_args[@]}" --feature auto-recall
node scripts/enable-finance-features.mjs "${finance_args[@]}" --feature interest
```

输出 JSON 包含网络、创世哈希、管理员、状态账户和最终确认 slot。`ready` 表示账户满足启用条件。`blocked-*` 说明需先处理的账户状态。`already-enabled` 表示功能已生效。需要正式启用时，在对应命令后加上 `--execute --admin-keypair "$GGBOY_ADMIN_KEYPAIR"`。脚本先核验 RPC 和管理员公钥，再签名发送，并在最终确认后读回状态。启用成功返回 `enabled` 和交易签名。重复执行已启用的功能会返回 `already-enabled`。

Localnet 改用 `--network localnet --rpc-url http://127.0.0.1:8899` 及本地管理员文件。

[链上项目](../README.md)

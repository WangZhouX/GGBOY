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

[链上项目](../README.md)

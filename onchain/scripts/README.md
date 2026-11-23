# 金库初始化脚本

`initialize-vault.mjs` 向已部署的 GGBOY 金库程序发送 `initialize_vault`。程序在同一笔交易内创建金库状态、测试 USDC 托管账户及 GG-V 份额 Mint。资产创建和测试币发放由部署者通过 `spl-token` 完成。

## 准备

- 使用 Node.js 22 或更高版本。在 `onchain` 根目录运行 `anchor build`，生成 `target/idl/ggboy_vault.json`。
- 已在目标测试环境部署可升级的金库程序，本地管理员 keypair 持有这份部署的升级权限，钱包有足够的对应网络测试 SOL 支付初始化。
- 已在同一网络创建六位小数的经典 SPL 测试 USDC Mint。记录其公钥作为 `GGBOY_ASSET_MINT`，并将部署钱包的绝对路径设为 `GGBOY_ADMIN_KEYPAIR`。

## 初始化 Devnet

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

[链上项目](../README.md)

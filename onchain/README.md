# GGBOY 链上程序

使用 Rust 和 Anchor 1.2.2。工作区包含两个独立程序。策略金库初始化、存入和赎回使用原版 SPL Token Program。

- **策略金库**管理资产托管、份额铸销、存款、赎回和调仓。金库 PDA 通过 CPI 向借贷池供给和提取闲置资金。
- **抵押借贷市场**管理出借资金池、抵押仓位、借款、还款、计息和清算。两个程序分别管理各自的状态和资产。

Localnet 用于开发和集成测试，Devnet 用于公开演示。演示使用自铸的六位小数 `mockUSDC`、测试抵押币、测试预言机和测试兑换程序。

## 构建

在 WSL/Linux 准备 Rust、Anchor CLI 1.2.2 和 Agave/Solana CLI 4.1.2。已验证的宿主 Rust 版本为 1.100.0。进入本目录，运行以下命令。

```sh
anchor build --ignore-keys
```

成功后会在 `target/deploy/` 生成 `ggboy_vault.so` 和 `ggboy_lending.so`，在 `target/idl/` 生成对应的 JSON 接口文件。构建使用 Anchor 1.2.2 默认的 platform-tools v1.57 和 SBPF v3。初次运行需要联网下载依赖和工具链。

公开仓库记录程序公钥。使用 `--ignore-keys` 可以直接构建对应的程序产物，供 Localnet 测试验证器按公开地址在创世时加载。如果使用本机程序密钥另行执行部署，先通过 `anchor keys sync` 同步程序公钥，再用 `anchor build` 检查地址并重新构建。

策略金库提供 `initialize_vault`、`deposit` 和 `redeem`。初始化创建金库状态、空托管账户和六位小数的 `GG-V` 份额 Mint。存入和赎回按执行前的现金余额和份额供给量定价，各在一笔交易中完成资金与份额结算。策略兑换和借贷池联动属于后续阶段。两个程序均保留无状态的 `ping` 指令。

## Localnet 金库初始化与存赎

初始化需通过 Solana 的可升级加载器部署金库程序，由程序升级权限持有人签名，并提供已创建的六位小数原版 SPL Token 测试 USDC Mint。存赎由投资者签名，使用该钱包已有的测试 USDC 和 `GG-V` 代币账户。账户约束和定价规则见[策略金库程序说明](programs/ggboy_vault/README.md)，复现命令见[Localnet 测试说明](tests/README.md)。

## Devnet 纯现金金库部署

Devnet 使用独立的 CLI 管理员钱包支付部署、Mint 和金库账户创建费用。管理员持有程序升级权限，用它签名初始化。给管理员公钥充值后再部署。公共 RPC 空投不可用时，可使用 [Solana Devnet 网页水龙头](https://faucet.solana.com/)。

在 WSL 创建或复用 GGBOY 的部署钱包，并设置单独的 Solana CLI 配置文件。

```sh
GGBOY_DEVNET_ADMIN="$HOME/.config/solana/ggboy-devnet.json"
GGBOY_DEVNET_CONFIG="$HOME/.config/solana/ggboy-devnet.yml"
mkdir -p "$HOME/.config/solana"
if [ ! -f "$GGBOY_DEVNET_ADMIN" ]; then
  solana-keygen new --silent --no-bip39-passphrase -o "$GGBOY_DEVNET_ADMIN"
fi
solana --config "$GGBOY_DEVNET_CONFIG" config set --url devnet --keypair "$GGBOY_DEVNET_ADMIN"
solana-keygen pubkey "$GGBOY_DEVNET_ADMIN"
solana --config "$GGBOY_DEVNET_CONFIG" balance
```

### 已确认的部署与初始化

| 项目 | Devnet 值 |
| --- | --- |
| 金库程序 ID | `FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75` |
| ProgramData 地址 | `7ph8TVvncE85B6gbdnyiD8jBzr3NSieZzmWTa27MGMrT` |
| 部署管理员和升级权限 | `8a6tkp7G5SKjXwQncu8vykXPGz7qyKgwGkEZB9MuKKaY` |
| 部署交易 | [在 Solana Explorer 查看](https://explorer.solana.com/tx/5FETbvd4axqBjhpDvGHc4EKos4tqEuWfaYSs8CNzKNLbSAw1H1bS1ciL3EjxPHDutXXZLTVvHG3htcYV5moog16u?cluster=devnet) |
| 部署 slot | `525357500` |
| `mockUSDC` Mint | `62vB22oh8fjXtitpKX3nLKyk9J7CVKb4ueKZcDGP1o1X` |
| 金库 PDA | `FnumrXNQLu5t1tLE9xJaVZiqGuDw5iyfQpo18j25ztP9` |
| 现金托管账户 | `CbbK9qcgDqpdewW8C64vb2zWXf65zcztWND22R3Zf6rZ` |
| `GG-V` 份额 Mint | `J1wgRZWWpB11ZYRD1fymCzCgnWA9ZihgqtaUUVpbWVNd` |
| 创建测试 Mint 的交易 | [在 Solana Explorer 查看](https://explorer.solana.com/tx/2hQDAPsZRmxnfdpiwSft5jM8JXVcYfH7WRApz8i9yg6wtJr5gHVc3PWF2Unefd2WJXNNa66sjrcX95kR2BydA4TA?cluster=devnet) |
| 金库初始化交易 | [在 Solana Explorer 查看](https://explorer.solana.com/tx/3zw6eknYyBghRrkWDkDvQHJZB7CuszdjeHEfUoZe4WSrF34fg622YKsRX9YsJxFocWX4ndCmvbLvGg4UyDcCsLXp?cluster=devnet) |
| 初始化 slot | `525357660` |

初始化完成时，已核对金库托管现金和 `GG-V` 份额供给均为零。下面的命令用于复现部署流程或核验这份部署。

### 构建和部署

在 `onchain/` 中执行。用 `solana-keygen pubkey target/deploy/ggboy_vault-keypair.json` 读取程序公钥，构建时使用的 `declare_id!` 必须与该公钥一致。

```sh
anchor build --ignore-keys
GGBOY_DEPLOY_BUFFER="$HOME/.config/solana/ggboy-devnet/deploy-buffer-keypair.json"
mkdir -p "$(dirname "$GGBOY_DEPLOY_BUFFER")"
if [ ! -f "$GGBOY_DEPLOY_BUFFER" ]; then
  solana-keygen new --silent --no-bip39-passphrase -o "$GGBOY_DEPLOY_BUFFER"
fi
solana --url devnet --keypair "$GGBOY_DEVNET_ADMIN" program deploy \
  target/deploy/ggboy_vault.so --program-id target/deploy/ggboy_vault-keypair.json \
  --upgrade-authority "$GGBOY_DEVNET_ADMIN" --buffer "$GGBOY_DEPLOY_BUFFER" --use-tpu-client
```

公共 RPC 若在写入期间返回 HTTP 429，可用 `--buffer` 指回同一个部署缓冲区，并改用 `--use-tpu-client` 续传。这次部署使用该方式完成。

### 创建测试资产和初始化

使用原版 SPL Token Program 创建六位小数的 `mockUSDC`，铸造权限留给 CLI 管理员。

```sh
GGBOY_CLASSIC_TOKEN_PROGRAM=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
spl-token --config "$GGBOY_DEVNET_CONFIG" create-token \
  --program-id "$GGBOY_CLASSIC_TOKEN_PROGRAM" --decimals 6
```

将创建命令输出的 Mint 公钥设为 `GGBOY_MOCK_USDC_MINT`，再初始化金库。

```sh
npm --prefix scripts ci
node scripts/initialize-vault.mjs --network devnet --rpc-url https://api.devnet.solana.com \
  --admin-keypair "$GGBOY_DEVNET_ADMIN" --asset-mint "$GGBOY_MOCK_USDC_MINT"
```

脚本默认读取构建产物 IDL 中的程序公钥。成功后输出程序 ID、金库 PDA、现金托管地址、两种 Mint 及交易签名。新建账户的现金余额和份额供给均为零。再次核验同一金库时使用原有 Mint。参数和输出见[金库初始化脚本说明](scripts/README.md)。

### 给 Phantom 发放测试币

将演示钱包的 Devnet 公钥设为 `GGBOY_PHANTOM_WALLET`。关联代币账户尚不存在时先创建，再以管理员的铸造权限向其发放测试币。以下用 100 枚作为示例。

```sh
spl-token --config "$GGBOY_DEVNET_CONFIG" create-account "$GGBOY_MOCK_USDC_MINT" \
  --program-id "$GGBOY_CLASSIC_TOKEN_PROGRAM" --owner "$GGBOY_PHANTOM_WALLET" \
  --fee-payer "$GGBOY_DEVNET_ADMIN"
spl-token --config "$GGBOY_DEVNET_CONFIG" mint "$GGBOY_MOCK_USDC_MINT" 100 \
  --program-id "$GGBOY_CLASSIC_TOKEN_PROGRAM" --recipient-owner "$GGBOY_PHANTOM_WALLET" \
  --mint-authority "$GGBOY_DEVNET_ADMIN" --fee-payer "$GGBOY_DEVNET_ADMIN"
spl-token --config "$GGBOY_DEVNET_CONFIG" balance "$GGBOY_MOCK_USDC_MINT" \
  --owner "$GGBOY_PHANTOM_WALLET"
```

发放的目标是 Phantom 的关联代币账户，供其钱包签名发起首笔存款。Phantom 使用自身的 Devnet SOL 支付交易手续费。Localnet 仍是 Anchor 工作区的默认环境，部署记录只保存公开地址和交易签名。

[程序目录](programs/README.md)

[项目架构](../README.md) · [前端](../frontend/README.md) · [后端](../backend/README.md)

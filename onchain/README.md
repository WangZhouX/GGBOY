# GGBOY 链上程序

使用 Rust 和 Anchor 1.2.2。工作区包含两个独立程序。策略金库初始化、存入和赎回，以及借贷市场的初始化、出借和抵押借贷均使用原版 SPL Token Program。

- **策略金库**管理资产托管、份额铸销、存款、赎回和调仓。金库 PDA 通过 CPI 向借贷池供给和提取闲置资金。
- **抵押借贷市场**提供市场和托管账户初始化、出借份额记账、存抵押、借款、按本金还款和取回抵押品。利率模型、出借资金提取、清算和核销属于后续阶段。两个程序分别管理各自的状态和资产。

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

## Localnet 借贷市场初始化

借贷程序提供 `initialize_lending_market`。当前部署的程序升级权限持有人签名，绑定已创建的六位小数借款 Mint 和测试抵押 Mint，同时创建市场 PDA、空借款资金池和空抵押托管账户。市场 PDA 持有两个托管账户的代币操作权限。账户约束见[借贷程序说明](programs/ggboy_lending/README.md)，复现命令见 [Localnet 借贷市场验收](tests/README.md#localnet-借贷市场初始化)。

## Localnet 借贷市场出借与升级验收

出借指令 `supply` 使用原有市场与现金托管账户，首次出借时创建独立的份额汇总和出借人仓位。程序升级保留原市场的 169 字节布局，可在同一程序地址和市场上继续操作。详见[出借业务规则](programs/ggboy_lending/README.md#出借)和 [Localnet 出借验收](tests/README.md#localnet-借贷市场出借与升级)。

## Localnet 提取出借资金验收

`withdraw_supply` 复用已有市场、现金托管账户和出借仓位，校验份额、最低到账和池内可支付现金。验收从旧版程序已出借的仓位开始，同地址升级后覆盖部分提取、全部提取和流动性不足回滚。 [链上提取规则](programs/ggboy_lending/README.md#提取出借资金) · [Localnet 验收脚本](tests/README.md#localnet-提取出借资金)

## Localnet 抵押借款验收

抵押、借款、还款和取回抵押品使用同一借款仓位。借款与有债务时取回抵押品需校验正值测试价格、7 天有效期和 70% 借款 LTV。市场和原有出借账户布局升级后继续复用。 [程序规则](programs/ggboy_lending/README.md#抵押与借款) · [独立验证器验收](tests/README.md#localnet-抵押借款全流程)

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

## Devnet 借贷市场部署与登记

借贷程序由 GGBOY 的 Devnet 部署钱包部署并初始化，复用了策略金库的六位小数 `mockUSDC`，独立创建九位小数的测试 `tSOL` Mint。以下记录链上公开地址。

| 项目 | Devnet 值 |
| --- | --- |
| 借贷程序 ID | `8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H` |
| ProgramData 地址 | `4gfh4nLgZJ6j7MS1XDEH7AK5tXqU5fe21zmZZkjLG3Ts` |
| 管理员与升级权限 | `8a6tkp7G5SKjXwQncu8vykXPGz7qyKgwGkEZB9MuKKaY` |
| 市场 PDA | `HzzMy19zYvQ6ZKfEgeMwuin3eMp8RFBWeRar9vzncUvE` |
| `mockUSDC` Mint | `62vB22oh8fjXtitpKX3nLKyk9J7CVKb4ueKZcDGP1o1X` |
| `tSOL` Mint | `AfJQ7YcnvUDncihfh9NoeF41Bw6eiB1eFcubmdw9fAg1` |
| `mockUSDC` 资金池 | `77qJXzwVHTVs5Pny98WKyVMu895C6WBNSwtqHuXdCvz1` |
| `tSOL` 抵押托管 | `9HHy2Z214uqcJdq5QjUvCS6TsPYpX9utBP4E1hnZ8Qf9` |
| 部署交易 | [Solana Explorer](https://explorer.solana.com/tx/3X23Vs79azPJifQMKFj7wBSYo4zi6zYG5xcVArXyotjh1KYGYDmNSrWjt5gDXWiNp1iUX2wQyM3WLVWfmYaydEy4?cluster=devnet) |
| 创建 `tSOL` Mint | [Solana Explorer](https://explorer.solana.com/tx/FNEVeX6aq2B7cKJKvJt9JKN24PEasjTC8kovzomCk3cvVDTjpbYYWYAwAEX9NDTecAw22NzfAY9qiq9AK8xwGCm?cluster=devnet) |
| 初始化市场交易 | [Solana Explorer](https://explorer.solana.com/tx/3X1ruxhy2fkzMqx88jmmyZXVg51kMbMeS7Xjdcz12R8CEJiBMMVN2FVghDSkCtfPomM5SMujGdmE8jiqafV36gd1?cluster=devnet) |
| 出借指令升级交易 | [Solana Explorer](https://explorer.solana.com/tx/H4JUdKWonCuPJ5CBs1MnmGKTgNRuvugq1vRJnN5DSBjDDktUGmwiarT4UyZxYSsUzsghiWiuZRskjSdNXeMjNKE?cluster=devnet) |
| 出借指令升级 slot | `525420417` |
| 抵押借款指令升级 | [Solana Explorer](https://explorer.solana.com/tx/2VGaVNtABeKuV6BkPr1Q3vtCMtZg5U858XurTN8c325CG1rT9DZr635ngNft3YdBV2wrUYnykuDbDmxjEScCrSec?cluster=devnet) |
| 抵押借款升级 slot | `525433231` |
| 提取出借资金升级 | [Solana Explorer](https://explorer.solana.com/tx/5E1h2VdJgohjXawpUyaaN9cmYZpYKxBipdfBFPtXvP1D6RVhWVJqunSPtdURWBQEgQ8e1h1mdq5XBo9VMq9XCExf?cluster=devnet) |
| 提取出借资金升级 slot | `525644144` |
| 测试价格 PDA | `4NeM7WfjHBxwFzScEeGX7TAUc7FeMDrvKBf1f6iN9znw` |
| 初次发布测试价格（100 mockUSDC/tSOL） | [Solana Explorer](https://explorer.solana.com/tx/54kq38KvZswXsCXR3ELZLwhcTKh3guAzLDv5LBYJD11w3himTM2NMEmkwo5LdKEUptaK1FHhzYiDuoHUY2FPgb6c?cluster=devnet) |

初始化后在最终确认 slot `525417695` 读取了市场与两类托管账户，核对了 Mint、PDA 权限和零余额。可用 [初始化脚本](scripts/README.md#借贷市场) 重读和验证同一部署。用 [登记 SQL](../docs/backend/register-devnet-lending-market.sql) 将实际 Devnet 市场登记到 PostgreSQL。

借贷首页的「资金池现况」用后端登记识别市场，页面可直接读取已验证的托管现金。「我的借款」直接读取本金、抵押、风险和价格。用户借款需要由出借人提供已记账的 `mockUSDC` 流动性，以及由市场管理员发布有效期内的测试价格。 [价格发布和查询命令](scripts/README.md#借贷市场测试价格)

Devnet 已完成抵押借款的同地址升级。最终确认后核对了程序文件、市场和两类托管账户。无签名模拟在 slot `525433379` 验证了抵押 1 tSOL、借出并还清 25 mockUSDC 和取回 1 tSOL，模拟结果的债务和抵押均为零，实际资金池仍为 100 mockUSDC。测试价格自发布时间起 7 天内有效。

Devnet 完成同程序地址的出借升级。升级后的可执行文件与 Localnet 通过验收的产物逐字节一致，市场状态及两个已存在的托管账户保持原有内容。升级后模拟存入 100 mockUSDC，验证出借份额增加 100，模拟没有提交链上转账。

提取出借资金在同一程序地址升级。最终确认后，使用已有的 100 份出借仓位模拟提取 1 份和全部 100 份，预期到账分别为 1 和 100 mockUSDC。超份额及最低到账超出报价均被拒绝。模拟保留仓位与资金池的实际状态。

[程序目录](programs/README.md)

[项目架构](../README.md) · [前端](../frontend/README.md) · [后端](../backend/README.md)

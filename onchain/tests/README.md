# Localnet 验收

[initialize-vault.mjs](initialize-vault.mjs) 验证策略金库 `initialize_vault` 指令。[deposit-vault.mjs](deposit-vault.mjs) 复用初始化验收，随后验证 `deposit` 指令。[redeem-vault.mjs](redeem-vault.mjs) 创建独立金库并验证 `redeem` 指令。脚本直接向本机验证器发送并确认交易，读取真实的 Anchor 状态、SPL 账户、Mint 和交易日志。测试依赖由本目录管理。

## 运行

需要 Node.js 22 或更高版本、[链上工作区工具链](../README.md)、测试用管理员密钥和一个全新的 Localnet 金库部署。程序需以可升级模式运行，并将该管理员设为升级权限地址。下面的命令使用新账本，保留现有账本。

可以使用已有的本地测试钱包，也可以创建一次性管理员密钥。若使用临时密钥，将下面两个终端中的 `GGBOY_TEST_ADMIN_FILE` 都设为其实际文件路径。

```bash
GGBOY_TEST_ADMIN_FILE="$(mktemp -d -t ggboy-vault-admin.XXXXXX)/admin-keypair.json"
solana-keygen new --silent --no-bip39-passphrase -o "$GGBOY_TEST_ADMIN_FILE"
```

在 `onchain/` 构建并启动验证器。

```bash
anchor build --ignore-keys
GGBOY_TEST_ADMIN_FILE="${GGBOY_TEST_ADMIN_FILE:-$HOME/.config/solana/id.json}"
GGBOY_TEST_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_vault.json').address")
solana-test-validator --bind-address 127.0.0.1 --rpc-port 8899 \
  --ledger "$(mktemp -d -t ggboy-vault-ledger.XXXXXX)" \
  --upgradeable-program "$GGBOY_TEST_PROGRAM_ID" target/deploy/ggboy_vault.so "$GGBOY_TEST_ADMIN_FILE"
```

在另一个终端，从 `onchain/` 给同一管理员发放本地测试 SOL 并运行验收。

```bash
GGBOY_TEST_ADMIN_FILE="${GGBOY_TEST_ADMIN_FILE:-$HOME/.config/solana/id.json}"
GGBOY_TEST_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_vault.json').address")
GGBOY_TEST_RPC_URL=http://127.0.0.1:8899
solana --url "$GGBOY_TEST_RPC_URL" --keypair "$GGBOY_TEST_ADMIN_FILE" airdrop 10
npm --prefix tests ci
node tests/initialize-vault.mjs "$GGBOY_TEST_PROGRAM_ID" "$GGBOY_TEST_ADMIN_FILE" "$GGBOY_TEST_RPC_URL"
```

带第四个参数可以校验错配的 ProgramData。先在同一验证器以可升级方式载入另一程序，例如 `ggboy_lending`，再将其程序公钥传给脚本。脚本只接受本机的 HTTP RPC 地址。

在另一个新账本上运行存入验收时，将前面最后一条命令替换为下方命令。该脚本会先执行初始化验收，启动验证器后无需单独初始化金库。

```bash
node tests/deposit-vault.mjs "$GGBOY_TEST_PROGRAM_ID" "$GGBOY_TEST_ADMIN_FILE" "$GGBOY_TEST_RPC_URL"
```

在独立的新账本上运行赎回验收时，替换为下方命令。脚本会创建带冻结权限的测试结算 Mint，初始化金库并准备两笔存款。

```bash
node tests/redeem-vault.mjs "$GGBOY_TEST_PROGRAM_ID" "$GGBOY_TEST_ADMIN_FILE" "$GGBOY_TEST_RPC_URL"
```

## 初始化验收

- 普通签名人和错误精度的结算 Mint 均得到相应的链上错误码，且三类 PDA 保持未创建。指定另一可升级程序时，同时核对错配的 ProgramData。
- 管理员初始化成功后，核对金库状态账户归属、管理员与资产配置、托管账户 Mint 与 PDA 权限、六位小数份额 Mint 的铸造权和冻结权限。托管余额和份额供应量均为零。
- 再次初始化失败，三个账户的配置与余额保持原样。脚本通过时打印初始化交易签名，每次重跑使用新账本。

## 存入验收

- 钱包 A 首存 100 mockUSDC 得到 100 GG-V。直接转入 20 mockUSDC 后，金库现金增至 120，份额供给仍为 100。
- 钱包 B 存入 100 mockUSDC 得到 83.333333 GG-V。最低份额填写 83.333334 时拒绝。两笔成功交易的 `VaultDeposit` 事件分别核对投资者、Mint 和实际成交量。
- 验证输入为零、最低份额为零、舍入后为零、余额不足、来源或接收账户归属不符，以及托管有现金但份额供应量为零时的错误。每个拒绝用例都会核对金库、Mint 与关联代币账户保持原样。

## 赎回验收

- 两个钱包各存入 100 mockUSDC，额外直接转入 20.000001 mockUSDC 后，钱包 A 赎回 40 GG-V 得到 44 mockUSDC，余下 60 GG-V 赎回得到 66 mockUSDC。钱包 B 赎回最后 100 GG-V 得到 110.000001 mockUSDC，托管现金和份额总供应量同时归零。
- 核对每次成功交易的 `VaultRedeem` 事件。零输入、零最低到账、超持有份额、未达到最低到账与账户归属不符均触发相应错误，金库和关联代币账户维持原值。
- 冻结到账账户后提交赎回。解析交易的内部指令和日志，核对份额销毁 CPI 成功、随后的 `TransferChecked` 失败。整笔交易回滚份额余额和总供应量，资金余额保持原值，无成功事件。解冻后以相同金额成功赎回。

[返回链上工作区](../README.md)

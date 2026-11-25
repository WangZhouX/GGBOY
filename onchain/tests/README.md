# Localnet 验收

[initialize-vault.mjs](initialize-vault.mjs) 验证策略金库 `initialize_vault` 指令。[deposit-vault.mjs](deposit-vault.mjs) 复用初始化验收，随后验证 `deposit` 指令。[redeem-vault.mjs](redeem-vault.mjs) 创建独立金库并验证 `redeem` 指令。[initialize-lending-market.mjs](initialize-lending-market.mjs) 验证独立的借贷市场初始化。[supply-lending-market.mjs](supply-lending-market.mjs) 在已初始化的市场验收出借与份额记账。脚本直接向本机验证器发送并确认交易，读取真实的 Anchor 状态、SPL 账户、Mint 和交易日志。测试依赖由本目录管理。

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

## Localnet 借贷市场初始化

从 `onchain/` 构建程序，在新账本上启动验证器。这里创建独立的测试管理员，并把两个程序都按可升级模式加载。测试使用金库程序的 ProgramData 验证错配的升级数据会被拒绝。

```bash
anchor build --ignore-keys
GGBOY_LENDING_TEST_ADMIN_FILE="$(mktemp -d -t ggboy-lending-admin.XXXXXX)/admin-keypair.json"
solana-keygen new --silent --no-bip39-passphrase -o "$GGBOY_LENDING_TEST_ADMIN_FILE"
GGBOY_LENDING_TEST_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_lending.json').address")
GGBOY_LENDING_TEST_OTHER_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_vault.json').address")
solana-test-validator --bind-address 127.0.0.1 --rpc-port 8899 \
  --ledger "$(mktemp -d -t ggboy-lending-ledger.XXXXXX)" \
  --upgradeable-program "$GGBOY_LENDING_TEST_PROGRAM_ID" target/deploy/ggboy_lending.so "$GGBOY_LENDING_TEST_ADMIN_FILE" \
  --upgradeable-program "$GGBOY_LENDING_TEST_OTHER_PROGRAM_ID" target/deploy/ggboy_vault.so "$GGBOY_LENDING_TEST_ADMIN_FILE"
```

另开终端进入 `onchain/`，将 `GGBOY_LENDING_TEST_ADMIN_FILE` 设为上一步的密钥文件路径，再发放本地测试 SOL 并运行验收。

```bash
GGBOY_LENDING_TEST_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_lending.json').address")
GGBOY_LENDING_TEST_OTHER_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_vault.json').address")
GGBOY_LENDING_TEST_RPC_URL=http://127.0.0.1:8899
solana --url "$GGBOY_LENDING_TEST_RPC_URL" --keypair "$GGBOY_LENDING_TEST_ADMIN_FILE" airdrop 10
npm --prefix tests ci
node tests/initialize-lending-market.mjs "$GGBOY_LENDING_TEST_PROGRAM_ID" \
  "$GGBOY_LENDING_TEST_ADMIN_FILE" "$GGBOY_LENDING_TEST_RPC_URL" "$GGBOY_LENDING_TEST_OTHER_PROGRAM_ID"
```

脚本使用本机 HTTP RPC，创建六位小数的测试 `mockUSDC` Mint 和九位小数的测试 `tSOL` Mint。末尾的其他可升级程序地址可以省略。重跑使用新账本。

- 成功时核对市场状态的程序归属、管理员、两种 Mint、两个托管地址和规范 bump。两个托管账户均绑定对应 Mint，由市场 PDA 授权，余额为零。
- 普通签名人、错配的 ProgramData、错误的借款精度、重复的 Mint、原生 Mint、Token-2022 Mint 和错误的抵押托管 PDA 均被拒绝。错误的抵押托管 PDA 在已尝试创建市场和资金池后触发校验失败。通过交易日志和账户读取检查两步创建均回滚。
- 再次初始化会被拒绝，并保留原账户数据与余额。成功时脚本打印初始化交易签名。

## Localnet 借贷市场出借与升级

准备一份升级前仅支持初始化的借贷程序 SBF 产物。若待升级版本仍在 Devnet，可在升级前用 `solana --url devnet program dump <程序地址> <路径>` 保存公开的程序字节，供本机验证器加载。在 `onchain/` 中设置旧版产物的实际路径，随后构建现版并用旧版启动独立账本。两份产物使用同一程序地址。

```bash
GGBOY_LENDING_OLD_SO=/absolute/path/to/ggboy_lending_before_supply.so
GGBOY_LENDING_TEST_DIR="$(mktemp -d -t ggboy-lending-supply.XXXXXX)"
GGBOY_LENDING_TEST_ADMIN_FILE="$GGBOY_LENDING_TEST_DIR/admin-keypair.json"
solana-keygen new --silent --no-bip39-passphrase -o "$GGBOY_LENDING_TEST_ADMIN_FILE"
anchor build --ignore-keys
GGBOY_LENDING_TEST_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_lending.json').address")
printf '%s\n' "$GGBOY_LENDING_TEST_DIR"
solana-test-validator --bind-address 127.0.0.1 --rpc-port 18999 --faucet-port 19900 --gossip-port 18100 \
  --ledger "$GGBOY_LENDING_TEST_DIR/ledger" \
  --upgradeable-program "$GGBOY_LENDING_TEST_PROGRAM_ID" "$GGBOY_LENDING_OLD_SO" "$GGBOY_LENDING_TEST_ADMIN_FILE"
```

另开终端进入 `onchain/`，将目录变量设为上一步打印的路径。下列步骤在旧版程序上创建市场。出借验收使用带冻结权限的六位借款 Mint 触发真实的 SPL 转账失败。管理员同时持有该 Mint 的铸造和冻结权限。

```bash
GGBOY_LENDING_TEST_DIR=/tmp/ggboy-lending-supply.XXXXXX
GGBOY_LENDING_TEST_ADMIN_FILE="$GGBOY_LENDING_TEST_DIR/admin-keypair.json"
GGBOY_LENDING_TEST_RPC_URL=http://127.0.0.1:18999
GGBOY_LENDING_TEST_CLI_CONFIG="$GGBOY_LENDING_TEST_DIR/cli.yml"
GGBOY_LENDING_TEST_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_lending.json').address")
GGBOY_LENDING_TEST_TOKEN_PROGRAM=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
GGBOY_LENDING_TEST_MINT_AUTHORITY=$(solana-keygen pubkey "$GGBOY_LENDING_TEST_ADMIN_FILE")
set -o pipefail
solana --config "$GGBOY_LENDING_TEST_CLI_CONFIG" config set \
  --url "$GGBOY_LENDING_TEST_RPC_URL" --keypair "$GGBOY_LENDING_TEST_ADMIN_FILE" --commitment finalized
solana --config "$GGBOY_LENDING_TEST_CLI_CONFIG" airdrop 10
npm --prefix scripts ci
npm --prefix tests ci
GGBOY_LENDING_TEST_DEBT_MINT=$(spl-token create-token --config "$GGBOY_LENDING_TEST_CLI_CONFIG" \
  --program-id "$GGBOY_LENDING_TEST_TOKEN_PROGRAM" --fee-payer "$GGBOY_LENDING_TEST_ADMIN_FILE" \
  --mint-authority "$GGBOY_LENDING_TEST_MINT_AUTHORITY" --decimals 6 --enable-freeze \
  --output json | node -pe "JSON.parse(require('node:fs').readFileSync(0, 'utf8')).commandOutput.address")
GGBOY_LENDING_TEST_COLLATERAL_MINT=$(spl-token create-token --config "$GGBOY_LENDING_TEST_CLI_CONFIG" \
  --program-id "$GGBOY_LENDING_TEST_TOKEN_PROGRAM" --fee-payer "$GGBOY_LENDING_TEST_ADMIN_FILE" \
  --mint-authority "$GGBOY_LENDING_TEST_MINT_AUTHORITY" --decimals 9 \
  --output json | node -pe "JSON.parse(require('node:fs').readFileSync(0, 'utf8')).commandOutput.address")
node scripts/initialize-lending-market.mjs --network localnet \
  --rpc-url "$GGBOY_LENDING_TEST_RPC_URL" --admin-keypair "$GGBOY_LENDING_TEST_ADMIN_FILE" \
  --debt-mint "$GGBOY_LENDING_TEST_DEBT_MINT" --collateral-mint "$GGBOY_LENDING_TEST_COLLATERAL_MINT" \
  --program-id "$GGBOY_LENDING_TEST_PROGRAM_ID" > "$GGBOY_LENDING_TEST_DIR/initialized.json"
```

用同一地址与升级权限部署新程序。升级前后读取市场状态，核对程序归属和状态原始字节保持一致，再用原有市场执行出借验收。

```bash
GGBOY_LENDING_TEST_MARKET=$(node -pe "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).market" "$GGBOY_LENDING_TEST_DIR/initialized.json")
solana --config "$GGBOY_LENDING_TEST_CLI_CONFIG" \
  account "$GGBOY_LENDING_TEST_MARKET" --output json > "$GGBOY_LENDING_TEST_DIR/market-before.json"
solana --url "$GGBOY_LENDING_TEST_RPC_URL" --keypair "$GGBOY_LENDING_TEST_ADMIN_FILE" \
  --commitment finalized program deploy target/deploy/ggboy_lending.so \
  --program-id "$GGBOY_LENDING_TEST_PROGRAM_ID" --upgrade-authority "$GGBOY_LENDING_TEST_ADMIN_FILE"
solana --config "$GGBOY_LENDING_TEST_CLI_CONFIG" \
  account "$GGBOY_LENDING_TEST_MARKET" --output json > "$GGBOY_LENDING_TEST_DIR/market-after.json"
cmp "$GGBOY_LENDING_TEST_DIR/market-before.json" "$GGBOY_LENDING_TEST_DIR/market-after.json"
node tests/supply-lending-market.mjs "$GGBOY_LENDING_TEST_PROGRAM_ID" \
  "$GGBOY_LENDING_TEST_ADMIN_FILE" "$GGBOY_LENDING_TEST_DEBT_MINT" "$GGBOY_LENDING_TEST_RPC_URL"
```

验收脚本只向本机 RPC 发交易，从已初始化、池内现金为零且尚无出借汇总的市场开始。重跑使用新账本。

- 读取首存、追加出借和不同出借人的仓位，核对 `LendingSupply` 事件中的签名人、市场、Mint、资产和份额。
- 验证首存 100 mockUSDC 得到 100 份，核对托管现金与份额记账资产的区别。直接转入托管的代币不影响新增份额。
- 验证零输入、最低份额、余额、账户绑定和代币转账失败都能原子回滚。检查失败交易后的代币余额、已存在的份额状态和新 PDA 创建情况。

## Localnet 抵押借款全流程

[borrow-lending-market.mjs](borrow-lending-market.mjs) 使用独立本机验证器和六位 mockUSDC 与九位 tSOL 的测试 Mint。以确认后的代币余额、PDA 和事件作为断言来源。

在 `onchain/` 构建当前程序并启动新账本。终端输出的密钥路径用于下一步。

```bash
anchor build --ignore-keys
GGBOY_BORROW_TEST_DIR="$(mktemp -d -t ggboy-lending-borrow.XXXXXX)"
GGBOY_LENDING_TEST_ADMIN_FILE="$GGBOY_BORROW_TEST_DIR/admin-keypair.json"
solana-keygen new --silent --no-bip39-passphrase -o "$GGBOY_LENDING_TEST_ADMIN_FILE"
GGBOY_LENDING_TEST_PROGRAM_ID=$(node -p "require('./target/idl/ggboy_lending.json').address")
printf '%s\n' "$GGBOY_LENDING_TEST_ADMIN_FILE"
solana-test-validator --bind-address 127.0.0.1 --rpc-port 28919 --faucet-port 29919 --gossip-port 28119 \
  --ledger "$GGBOY_BORROW_TEST_DIR/ledger" \
  --upgradeable-program "$GGBOY_LENDING_TEST_PROGRAM_ID" target/deploy/ggboy_lending.so "$GGBOY_LENDING_TEST_ADMIN_FILE"
```

另开终端进入 `onchain/`，用实际输出路径替换下方的管理员文件，给这枚本地测试钱包发放 SOL。

```bash
GGBOY_LENDING_TEST_ADMIN_FILE=/tmp/ggboy-lending-borrow.XXXXXX/admin-keypair.json
GGBOY_LENDING_TEST_RPC_URL=http://127.0.0.1:28919
solana --url "$GGBOY_LENDING_TEST_RPC_URL" --keypair "$GGBOY_LENDING_TEST_ADMIN_FILE" airdrop 10
npm --prefix tests ci
node tests/borrow-lending-market.mjs "$GGBOY_LENDING_TEST_ADMIN_FILE" "$GGBOY_LENDING_TEST_RPC_URL"
```

脚本创建市场和测试资产，并通过出借交易提供 100 mockUSDC。需要验收升级时，用同一程序 ID 的出借版 ELF 启动新账本，并给测试脚本加上第三个参数 `target/deploy/ggboy_lending.so`。脚本在原版市场完成出借后升级，再继续借款验收。重复验收使用一个新的账本。

- 通过抵押、借款、部分还款、全额还款和取回抵押，核对个人本金、市场合计本金及两个托管余额。
- 测试管理员发布价格、缺价时拒绝借款、抵押和现金上限、超过额度后的原子回滚，以及无债仓位取回抵押。
- 借款后仍可继续出借，已借出的本金继续为份额记账提供会计覆盖。
- 将价格降到恰好达到 80% 清算阈值，核对拒绝和回滚；继续降价，验证第三方部分清算、最低到账量、代偿上限、借款人禁止自我清算和规范代币账户。
- 验证抵押品价值暴跌后的坏账冲销、抵押零头归借款人，以及双零清算冲销不会转账。逐项核对实际事件、池资产、总债务、原有池份额和未入账的托管现金。
- 清偿旧债务后启用计息，验证同一清算指令对扩展账本正确扣减归一化债务。核对清算人的实际代偿和到账、池记账现金、原有出借份额以及池资产会计等式。

## Localnet 提取出借资金

[withdraw-lending-supply.mjs](withdraw-lending-supply.mjs) 在独立账本验证从已有出借仓位部分及全部提取。验收同地址升级时，准备一份支持出借和借款的旧版 ELF。在 `onchain/` 构建现版后，使用旧版产物启动新账本，把升级权限交给新建的测试管理员。

```bash
GGBOY_WITHDRAW_OLD_ELF=/absolute/path/to/ggboy_lending_before_withdraw.so
GGBOY_WITHDRAW_TEST_DIR="$(mktemp -d -t ggboy-lending-withdraw.XXXXXX)"
GGBOY_WITHDRAW_ADMIN="$GGBOY_WITHDRAW_TEST_DIR/admin-keypair.json"
solana-keygen new --silent --no-bip39-passphrase -o "$GGBOY_WITHDRAW_ADMIN"
anchor build --ignore-keys
GGBOY_WITHDRAW_PROGRAM=$(node -p "require('./target/idl/ggboy_lending.json').address")
printf '%s\n' "$GGBOY_WITHDRAW_TEST_DIR"
solana-test-validator --bind-address 127.0.0.1 --rpc-port 39117 --faucet-port 39119 --gossip-port 39120 \
  --dynamic-port-range 39121-39199 --ledger "$GGBOY_WITHDRAW_TEST_DIR/ledger" \
  --upgradeable-program "$GGBOY_WITHDRAW_PROGRAM" "$GGBOY_WITHDRAW_OLD_ELF" "$GGBOY_WITHDRAW_ADMIN"
```

在另一个终端进入 `onchain/`。替换为上方打印的实际路径，准备 Localnet 测试 SOL 后运行验收。脚本先初始化并出借 100 mockUSDC，再使用相同程序地址升级，并对照升级前后的原始账户数据。

```bash
GGBOY_WITHDRAW_TEST_DIR=/tmp/ggboy-lending-withdraw.XXXXXX
GGBOY_WITHDRAW_ADMIN="$GGBOY_WITHDRAW_TEST_DIR/admin-keypair.json"
GGBOY_WITHDRAW_RPC=http://127.0.0.1:39117
solana --url "$GGBOY_WITHDRAW_RPC" --keypair "$GGBOY_WITHDRAW_ADMIN" --commitment finalized airdrop 20
npm --prefix tests ci
node tests/withdraw-lending-supply.mjs "$GGBOY_WITHDRAW_ADMIN" "$GGBOY_WITHDRAW_RPC" target/deploy/ggboy_lending.so
```

也可用现版 ELF 启动一个新账本，运行时省略最后一个参数。脚本仅接受本机 HTTP RPC，每次重跑使用新账本。

- 先提取 25 mockUSDC。随后借款人借出 60 mockUSDC，可提额度受未偿本金约束降到 15。即使向托管额外转入 7 mockUSDC，超过限额一个最小单位也会被拒绝。
- 提取到流动性上限后，借款人归还本金，再用所有剩余份额取回资金。逐笔核对事件中的注销份额、实际到账与剩余份额。最后总份额与总债务均为零，未记账的 7 mockUSDC 留在托管。
- 验证零输入、超份额、超流动性、最低到账、错误签名人、错误接收账户、错配借款总账和真实 SPL Token 冻结转账。失败后逐字节核对业务账户没有变化。

## Localnet 策略管理

[strategy-vault.mjs](strategy-vault.mjs) 在新账本上部署两份程序的当前构建，创建同一组测试 Mint，并使用独立的管理员、策略管理者、投资者与借款人钱包。

从 `onchain/` 构建并启动独立验证器。

```bash
anchor build --ignore-keys
GGBOY_STRATEGY_TEST_DIR="$(mktemp -d -t ggboy-strategy.XXXXXX)"
GGBOY_STRATEGY_TEST_ADMIN="$GGBOY_STRATEGY_TEST_DIR/admin-keypair.json"
solana-keygen new --silent --no-bip39-passphrase -o "$GGBOY_STRATEGY_TEST_ADMIN"
GGBOY_STRATEGY_VAULT_PROGRAM=$(node -p "require('./target/idl/ggboy_vault.json').address")
GGBOY_STRATEGY_LENDING_PROGRAM=$(node -p "require('./target/idl/ggboy_lending.json').address")
printf '%s\n' "$GGBOY_STRATEGY_TEST_ADMIN"
solana-test-validator --bind-address 127.0.0.1 --rpc-port 44119 --faucet-port 44121 --gossip-port 44122 \
  --dynamic-port-range 44123-44199 --ledger "$GGBOY_STRATEGY_TEST_DIR/ledger" \
  --upgradeable-program "$GGBOY_STRATEGY_VAULT_PROGRAM" target/deploy/ggboy_vault.so "$GGBOY_STRATEGY_TEST_ADMIN" \
  --upgradeable-program "$GGBOY_STRATEGY_LENDING_PROGRAM" target/deploy/ggboy_lending.so "$GGBOY_STRATEGY_TEST_ADMIN"
```

另开终端进入 `onchain/`。把管理员文件路径替换为上一步打印的路径。

```bash
GGBOY_STRATEGY_TEST_ADMIN=/tmp/ggboy-strategy.XXXXXX/admin-keypair.json
GGBOY_STRATEGY_TEST_RPC=http://127.0.0.1:44119
solana --url "$GGBOY_STRATEGY_TEST_RPC" --keypair "$GGBOY_STRATEGY_TEST_ADMIN" --commitment finalized airdrop 10
npm --prefix tests ci
node tests/strategy-vault.mjs "$GGBOY_STRATEGY_TEST_ADMIN" "$GGBOY_STRATEGY_TEST_RPC"
```

- 原有现金金库在启用策略前仍能按原指令存入。调仓将 20 mockUSDC 换成 0.2 tSOL，核对两种实际余额及 `VaultStrategyAction` 事件。启用策略后，省略或替换估值账户会被拒绝。二次存入 25 mockUSDC 仍按总净值取得 25 GG-V。
- 管理者将 30 mockUSDC 分配到借贷池，核对份额归金库 PDA。借款人借出 20 mockUSDC 后只能收回 10，验证超出可用流动性和金库现金不足的赎回都回滚。
- 借款人还款后，管理者收回余款，再把策略持仓兑换回现金。外部转入量按测试价格向下舍入为零时，由管理者清理后才可结算最后份额。投资者全部赎回后金库现金、策略资产、池内份额和 GG-V 总供给同时归零。
- 新策略金库保留原 137 字节并追加自动收回功能位。管理者调用启用指令被拒绝，原金库管理员重复调用保持全账户字节一致。
- 自动收回场景重新存入 100 mockUSDC，出借 40，借款人借出 35。金库现金 60，池里可提 5。赎回 66 会回滚，赎回 63 恰好收回 3。还款前剩余可提 2，拒绝赎回 3。借款人还款后，由管理员给仍有 37 池份额的账本启用计息，核对原字段不变。最后一次赎回走扩展后的账本，同时清空金库出借份额和 GG-V 供给，无需策略管理者签名。
- 冻结投资者收款账户，确认借贷 CPI 成功后，支付失败仍会回滚收回、份额销毁及余额变动。
- 验证非管理者、最低到账保护和出借限额。失败前后逐字节对照业务账户。

[返回链上工作区](../README.md)

## Localnet 可选计息

复用独立借贷市场验证器和临时管理员密钥，在借贷生命周期命令末尾传入 `--interest`。测试先验证旧版本金结算，随后清偿旧债务并启用固定利率。它等待链上时钟越过首个完整的计息分钟，再校验新旧债务约束、实际还款、利息收益以及出借人取回资金。启用标志的测试会改变本地市场的账户布局，请在新启动的独立 Localnet 账本运行。

```bash
node tests/borrow-lending-market.mjs "$GGBOY_LENDING_TEST_ADMIN_FILE" "$GGBOY_LENDING_TEST_RPC_URL" --interest
```

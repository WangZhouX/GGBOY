import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createMint, freezeAccount, getAccount, getMint, getOrCreateAssociatedTokenAccount, mintTo, thawAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';

/** 本地确认级别，六位现金及九位策略资产的整数精度，可升级加载器。 Local commitment, six-decimal cash and nine-decimal strategy units, and upgradeable loader. */
const commitment = 'confirmed';
const cashUnit = 1_000_000n;
const spotUnit = 1_000_000_000n;
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/**
 * 返回账户、指令或事件的八字节 Anchor 判别符。
 * Return the eight-byte Anchor discriminator for an account, instruction, or event.
 * @param {string} name 含命名空间的 Anchor 名称。 Namespaced Anchor name.
 */
function discriminator(name) {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}

/**
 * 用公开 IDL 构造调用并独立核对判别符和最小单位编码。
 * Build a public IDL invocation, independently checking its discriminator and base-unit encoding.
 * @param {object} idl 已生成的程序 IDL。 Generated program IDL.
 * @param {string} name 指令名称。 Instruction name.
 * @param {(bigint|number|boolean|PublicKey)[]} args 对应 IDL 参数顺序。 Values in IDL argument order.
 * @param {Record<string, PublicKey>} addresses 该测试使用的账户公钥。 Account keys in this test.
 * @param {(PublicKey|import('@solana/web3.js').AccountMeta)[]} [remaining] 估值和自动收回账户，按协议顺序提供。 Valuation and recall accounts in protocol order.
 */
function instruction(idl, name, args, addresses, remaining = []) {
  /** IDL 定义及编码后的参数，其中金额使用 u64，策略比例使用 u16 基点。 IDL definition and encoded values using u64 base units and u16 basis points. */
  const spec = idl.instructions.find((entry) => entry.name === name);
  assert.ok(spec, 'Missing instruction in generated IDL: ' + name);
  assert.deepEqual(Buffer.from(spec.discriminator), discriminator('global:' + name));
  assert.equal(args.length, spec.args.length);
  const encoded = spec.args.map(({ type }, index) => {
    /** 配合此类型的参数和固定长度的小端缓冲区。 Value for this type and fixed-size little-endian encoding. */
    const value = args[index];
    if (type === 'bool') {
      assert.equal(typeof value, 'boolean');
      return Buffer.from([value ? 1 : 0]);
    }
    if (type === 'pubkey') {
      assert.ok(value instanceof PublicKey);
      return value.toBuffer();
    }
    const units = Buffer.alloc(type === 'u64' ? 8 : 2);
    if (type === 'u64') units.writeBigUInt64LE(value);
    else if (type === 'u16') units.writeUInt16LE(value);
    else throw new Error('Unsupported argument type for ' + name + ': ' + type);
    return units;
  });
  /** IDL 指定基本账户权限，额外账户按估值及 CPI 需要声明。 The IDL sets base privileges. Extra accounts declare valuation or CPI permissions. */
  const keys = spec.accounts.map(({ name: key, signer, writable }) => {
    const pubkey = addresses[key];
    assert.ok(pubkey instanceof PublicKey, 'Missing account ' + key + ' for ' + name);
    return { pubkey, isSigner: !!signer, isWritable: !!writable };
  });
  keys.push(...remaining.map((account) => account instanceof PublicKey
    ? { pubkey: account, isSigner: false, isWritable: false }
    : account));
  return new TransactionInstruction({
    programId: new PublicKey(idl.address), keys, data: Buffer.concat([Buffer.from(spec.discriminator), ...encoded]),
  });
}

/**
 * 读取金库顶层调用发出的实际策略事件。
 * Read actual strategy events emitted by the top-level vault invocation.
 * @param {string[]} logs 已确认交易的调用日志。 Invocation logs from a confirmed transaction.
 * @param {PublicKey} programId 预期事件所属的金库程序。 Vault program expected to emit the event.
 */
function strategyEvents(logs, programId) {
  /** 调用栈排除借贷及代币 CPI 事件。 The invocation stack excludes lending and token CPI events. */
  const stack = [];
  const events = [];
  const prefix = discriminator('event:VaultStrategyAction');
  for (const line of logs) {
    /** 运行时记录的程序入口。 Program entry recorded by the runtime. */
    const invocation = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invocation) {
      stack.push(invocation[1]);
      continue;
    }
    if (/^Program \S+ (?:success$|failed:)/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.length !== 1 || stack[0] !== programId.toBase58() || !line.startsWith('Program data: ')) continue;
    /** 判别符之后是四个公钥、操作类型和两个成交 u64。 The discriminator is followed by four keys, the action kind, and two executed u64 amounts. */
    const data = Buffer.from(line.slice('Program data: '.length), 'base64');
    if (!data.subarray(0, 8).equals(prefix)) continue;
    assert.equal(data.length, 153);
    events.push({
      vault: new PublicKey(data.subarray(8, 40)).toBase58(),
      manager: new PublicKey(data.subarray(40, 72)).toBase58(),
      kind: data[72],
      inputMint: new PublicKey(data.subarray(73, 105)).toBase58(),
      outputMint: new PublicKey(data.subarray(105, 137)).toBase58(),
      input: data.readBigUInt64LE(137),
      output: data.readBigUInt64LE(145),
    });
  }
  return events;
}

/**
 * 派生测试部署中的规范账户地址。
 * Derive a canonical account address in the test deployment.
 * @param {PublicKey} program PDA 所属程序。 Program that owns the PDA namespace.
 * @param {string} seed 固定种子前缀。 Fixed seed prefix.
 * @param {...PublicKey} keys 顺序参与派生的账户。 Accounts in derivation order.
 */
function pda(program, seed, ...keys) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map((key) => key.toBuffer())], program)[0];
}

/** 使用一次性账本实际验收策略管理及投资者存赎。 Verify strategy management and investor settlement on a disposable ledger. */
async function verifyVaultStrategy() {
  /** 一次性管理员密钥与回环 RPC 地址。 Disposable administrator key and loopback RPC address. */
  const [adminFile, rpcUrl = 'http://127.0.0.1:8899'] = process.argv.slice(2);
  assert.ok(adminFile, 'Usage: node strategy-vault.mjs <admin-keypair-file> [loopback-rpc-url]');
  const endpoint = new URL(rpcUrl);
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Use an HTTP Localnet endpoint on localhost.');

  /** 本地构建 IDL、程序公钥与临时操作钱包。 Local build IDLs, program addresses, and disposable operation signers. */
  const vaultIdl = JSON.parse(await readFile(new URL('../target/idl/ggboy_vault.json', import.meta.url), 'utf8'));
  const lendingIdl = JSON.parse(await readFile(new URL('../target/idl/ggboy_lending.json', import.meta.url), 'utf8'));
  const vaultProgram = new PublicKey(vaultIdl.address);
  const lendingProgram = new PublicKey(lendingIdl.address);
  const rpc = new Connection(endpoint.href, commitment);
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(adminFile, 'utf8'))));
  const manager = Keypair.generate();
  const investor = Keypair.generate();
  const borrower = Keypair.generate();

  /** 两个程序的状态、托管、价格及仓位 PDA。 State, custody, oracle and position PDAs for both programs. */
  const vault = pda(vaultProgram, 'vault');
  const vaultCash = pda(vaultProgram, 'cash_vault', vault);
  const shareMint = pda(vaultProgram, 'share_mint', vault);
  const strategy = pda(vaultProgram, 'strategy', vault);
  const custody = pda(vaultProgram, 'strategy_custody', strategy);
  const swapCash = pda(vaultProgram, 'swap_cash', strategy);
  const swapSpot = pda(vaultProgram, 'swap_strategy', strategy);
  const market = pda(lendingProgram, 'lending_market');
  const lendingCash = pda(lendingProgram, 'cash_vault', market);
  const lendingCollateral = pda(lendingProgram, 'collateral_vault', market);
  const oracle = pda(lendingProgram, 'mock_collateral_price', market);
  const supplyPool = pda(lendingProgram, 'supply_pool', market);
  const supplyPosition = pda(lendingProgram, 'supply_position', market, vault);
  const borrowMarket = pda(lendingProgram, 'borrow_market', market);
  const borrowPosition = pda(lendingProgram, 'borrow_position', market, borrower.publicKey);
  const [existingVault, existingMarket, vaultBinary, lendingBinary] =
    await rpc.getMultipleAccountsInfo([vault, market, vaultProgram, lendingProgram]);
  assert.ok(vaultBinary?.executable && lendingBinary?.executable, 'Load both current programs into the disposable Localnet ledger.');
  assert.deepEqual([existingVault, existingMarket], [null, null], 'Start with an empty disposable Localnet ledger.');

  /** 两种项目测试资产和投资者、借款人的代币账户。 Both project test assets and the investor/borrower token accounts. */
  // 冻结权限仅用于验收支付阶段失败后池 CPI 与份额销毁的原子回滚。
  // The test-only freeze authority lets a downstream payment fail so we can verify rollback of the pool CPI and burn.
  const cashMint = await createMint(rpc, admin, admin.publicKey, admin.publicKey, 6);
  const spotMint = await createMint(rpc, admin, admin.publicKey, null, 9);
  const investorCash = (await getOrCreateAssociatedTokenAccount(rpc, admin, cashMint, investor.publicKey)).address;
  const borrowerCash = (await getOrCreateAssociatedTokenAccount(rpc, admin, cashMint, borrower.publicKey)).address;
  const borrowerSpot = (await getOrCreateAssociatedTokenAccount(rpc, admin, spotMint, borrower.publicKey)).address;
  await mintTo(rpc, admin, cashMint, investorCash, admin, 200n * cashUnit);
  await mintTo(rpc, admin, spotMint, borrowerSpot, admin, spotUnit);

  /** 用微 Lamport 计算单价区分同一区块内其他内容相同的验证交易。 Use compute-unit prices in micro-lamports to distinguish otherwise identical test transactions in one block. */
  let sequence = 0;

  /**
   * 执行本地交易，包括验证回滚所需的失败交易。
   * Execute a local transaction, including failing transactions required to verify rollback.
   * @param {TransactionInstruction[]} inputs 要执行的业务操作或夹具操作。 Operation or fixture instructions.
   * @param {Keypair} [signer] 业务签名者，测试管理员支付手续费。 Business signer, with the test administrator paying fees.
   */
  async function submit(inputs, signer = admin) {
    /** 当前区块哈希、签名和执行回执用于比较真实链上结果。 Current blockhash, signature and receipt used to compare actual execution results. */
    const lifetime = await rpc.getLatestBlockhash();
    const transaction = new Transaction({ ...lifetime, feePayer: admin.publicKey }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: sequence++ }), ...inputs,
    );
    transaction.sign(...(signer === admin ? [admin] : [admin, signer]));
    const signature = await rpc.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const confirmation = await rpc.confirmTransaction({ signature, ...lifetime }, commitment);
    const receipt = await rpc.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
    assert.ok(receipt?.meta?.logMessages, 'Missing transaction logs: ' + signature);
    assert.deepEqual(receipt.meta.err, confirmation.value.err);
    return { signature, logs: receipt.meta.logMessages, error: receipt.meta.err };
  }

  /**
   * 核对已执行交易成功。
   * Require a successful executed transaction.
   * @param {object} receipt 链上交易错误及日志。 On-chain error and logs.
   */
  function succeeded(receipt) {
    assert.equal(receipt.error, null, receipt.logs.join('\n'));
  }

  // 首次建仓由单独的管理或借款人钱包支付租金。
  // Separate manager and borrower wallets pay their first-position rent.
  succeeded(await submit([manager, investor, borrower].map((wallet) =>
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wallet.publicKey, lamports: LAMPORTS_PER_SOL }),
  )));

  /** 程序账户名称绑定使用各自的现金托管公钥。 Separate account mappings bind each program's own cash custody address. */
  const common = { token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId };
  const lendingAccounts = {
    ...common, administrator: admin.publicKey, lending_program: lendingProgram,
    program_data: PublicKey.findProgramAddressSync([lendingProgram.toBuffer()], loader)[0],
    market, debt_mint: cashMint, collateral_mint: spotMint, cash_vault: lendingCash, collateral_vault: lendingCollateral,
    supply_pool: supplyPool, borrow_market: borrowMarket, borrow_position: borrowPosition, mock_collateral_price: oracle,
    borrower: borrower.publicKey, destination: borrowerCash,
  };
  const vaultAccounts = {
    ...common, administrator: admin.publicKey, vault_program: vaultProgram, lending_program: lendingProgram,
    program_data: PublicKey.findProgramAddressSync([vaultProgram.toBuffer()], loader)[0],
    vault, cash_vault: vaultCash, share_mint: shareMint, asset_mint: cashMint, strategy, strategy_mint: spotMint,
    manager: manager.publicKey, market, price: oracle, lending_cash: lendingCash, borrow_market: borrowMarket,
    strategy_custody: custody, swap_cash: swapCash, swap_strategy: swapSpot,
    supply_pool: supplyPool, supply_position: supplyPosition,
  };
  succeeded(await submit([instruction(lendingIdl, 'initialize_lending_market', [], lendingAccounts)]));
  succeeded(await submit([instruction(lendingIdl, 'set_mock_collateral_price', [100n * cashUnit], lendingAccounts)]));
  succeeded(await submit([instruction(vaultIdl, 'initialize_vault', [], vaultAccounts)]));
  const investorShares = (await getOrCreateAssociatedTokenAccount(rpc, admin, shareMint, investor.publicKey)).address;

  /** 投资者代币账户和启用策略后必须提供的只读估值账户。 Investor token accounts and required read-only valuation accounts after activation. */
  const investorAccounts = {
    ...vaultAccounts, investor: investor.publicKey, investor_asset: investorCash, investor_shares: investorShares,
  };
  const valuation = [strategy, custody, market, oracle, supplyPool, supplyPosition];
  /** 自动收回沿用前六个账户，并以可写权限传入三处会被借贷 CPI 更新的账户。 Automatic recall preserves the first six accounts and marks the three lending CPI accounts writable. */
  const recallValuation = [
    ...valuation.slice(0, 4),
    ...[supplyPool, supplyPosition, lendingCash].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    borrowMarket,
    lendingProgram,
  ];

  /**
   * 调用存赎。负例可省略或替换策略估值账户。
   * Invoke deposits/redemptions with optional omissions or substitutions for negative tests.
   * @param {'deposit'|'redeem'} name 投资者指令。 Investor instruction.
   * @param {bigint} amount 本操作的最小单位输入。 Input in base units for this operation.
   * @param {bigint} minimum 输出代币的最小单位下限。 Minimum output in the output token's base units.
   * @param {(PublicKey|import('@solana/web3.js').AccountMeta)[]} [extra] 策略估值及可选的自动收回账户，纯现金时省略。 Strategy valuation and optional automatic recall accounts, omitted in cash-only mode.
   */
  function invest(name, amount, minimum, extra) {
    return submit([instruction(vaultIdl, name, [amount, minimum], investorAccounts, extra)], investor);
  }

  /**
   * 以借款人签名执行借贷池操作。
   * Execute a lending market action as the borrower.
   * @param {string} name 借贷指令。 Lending instruction.
   * @param {bigint} amount 对应代币最小单位。 Amount in the applicable token's base units.
   * @param {PublicKey} [source] 指令需扣款时的来源账户。 Source token account for debit instructions.
   */
  function borrow(name, amount, source) {
    return submit([instruction(lendingIdl, name, [amount], { ...lendingAccounts, source })], borrower);
  }

  /**
   * 提交策略操作，负例可替换签名者。
   * Submit a strategy operation, allowing negative cases to substitute its signer.
   * @param {string} name 策略指令。 Strategy instruction.
   * @param {(boolean|bigint)[]} args 可选的方向、最小单位输入、最小单位下限。 Optional direction, input in base units, and minimum in base units.
   * @param {Keypair} [signer] 管理者或用于负例的签名人。 Manager or signer used for a negative test.
   */
  function manage(name, args, signer = manager) {
    return submit([instruction(vaultIdl, name, args, { ...vaultAccounts, manager: signer.publicKey })], signer);
  }

  /** 比较失败前后的资产、份额和业务状态，手续费及钱包 SOL 排除在外。 Compare asset, share and ledger accounts around failed operations, excluding fees and wallet SOL. */
  const watched = [vault, strategy, vaultCash, shareMint, custody, swapCash, swapSpot, investorCash, investorShares,
    lendingCash, lendingCollateral, supplyPool, supplyPosition, borrowMarket, borrowPosition, borrowerCash, borrowerSpot];

  /**
   * 验证错误、无策略成交事件和业务账户原子回滚。
   * Verify the failure, absence of successful strategy events, and atomic rollback.
   * @param {() => Promise<object>} attempt 会被明确拒绝的交易。 Transaction expected to reject for a specific reason.
   * @param {RegExp} reason 链上日志中的错误。 Failure in actual on-chain logs.
   */
  async function reject(attempt, reason) {
    /** 逐字节比较链上账户，验证失败没有留下首次创建的账户或部分划转。 Compare on-chain bytes to rule out retained allocations or partial transfers. */
    const prior = await rpc.getMultipleAccountsInfo(watched);
    const result = await attempt();
    assert.equal(result.error?.InstructionError?.[0], 1, result.logs.join('\n'));
    assert.match(result.logs.join('\n'), reason);
    assert.deepEqual(strategyEvents(result.logs, vaultProgram), []);
    assert.deepEqual(await rpc.getMultipleAccountsInfo(watched), prior);
    return result;
  }

  /**
   * 核验策略成功回执的全部成交字段。
   * Verify every execution field in a successful strategy receipt.
   * @param {object} receipt 实际链上回执。 Actual on-chain receipt.
   * @param {number} kind 0 调仓、1 出借、2 收回。 0 swap, 1 lend, 2 recall.
   * @param {PublicKey} inputMint 输入或出借资金的 Mint。 Input or supplied cash mint.
   * @param {PublicKey} outputMint 输出或收回资金的 Mint。 Output or recalled cash mint.
   * @param {bigint} input 执行输入，以对应最小单位计。 Executed input in its base units.
   * @param {bigint} output 执行输出，以对应最小单位计。 Executed output in its base units.
   */
  function expectAction(receipt, kind, inputMint, outputMint, input, output) {
    succeeded(receipt);
    assert.deepEqual(strategyEvents(receipt.logs, vaultProgram), [{
      vault: vault.toBase58(), manager: manager.publicKey.toBase58(), kind,
      inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), input, output,
    }]);
  }

  /**
   * 直接核对金库现金、策略余额、份额供给、借贷池现金和金库出借份额。
   * Verify vault cash, spot balance, share supply, lending cash, and vault-owned supply shares.
   * @param {bigint[]} expected 以上顺序的预期最小单位余额。 Expected balances in base units, in the order listed.
   */
  async function verifyBalances(expected) {
    /** 验证仓位归金库 PDA，管理者钱包只授权和支付首次创建。 Verify that the vault PDA owns the position; the manager signs and pays first-position rent. */
    const position = await rpc.getAccountInfo(supplyPosition);
    if (position) {
      assert.ok(position.owner.equals(lendingProgram));
      assert.deepEqual(position.data.subarray(0, 8), discriminator('account:SupplyPosition'));
      assert.deepEqual(position.data.subarray(8, 40), market.toBuffer());
      assert.deepEqual(position.data.subarray(40, 72), vault.toBuffer());
    }
    assert.deepEqual([
      (await getAccount(rpc, vaultCash)).amount,
      (await getAccount(rpc, custody)).amount,
      (await getMint(rpc, shareMint)).supply,
      (await getAccount(rpc, lendingCash)).amount,
      position?.data.readBigUInt64LE(72) ?? 0n,
    ], expected);
  }

  // 先按原 ABI 现金存入，再对同一个金库启用管理者策略。
  // Deposit cash through the original ABI, then activate manager strategy on the same vault.
  /** 保留原纯现金金库状态字节，用于确认启用功能后原字段仍未移动。 Preserve cash-vault bytes to verify that activation leaves the original fields in place. */
  const legacyVaultData = (await rpc.getAccountInfo(vault)).data;
  assert.equal(legacyVaultData.length, 137);
  succeeded(await invest('deposit', 100n * cashUnit, 100n * cashUnit));
  assert.equal((await getAccount(rpc, investorShares)).amount, 100n * cashUnit);

  /** 最低现金留存 20%、出借上限 40%、调仓额度 50%，均为净值比例。 Minimum 20% cash reserve, 40% lending cap, and 50% swap limit, each relative to NAV. */
  const settings = [manager.publicKey, 2_000, 4_000, 5_000];
  await reject(() => submit([instruction(vaultIdl, 'initialize_vault_strategy', settings, {
    ...vaultAccounts, administrator: manager.publicKey,
  })], manager), /Unauthorized|ConstraintHasOne/);
  succeeded(await submit([instruction(vaultIdl, 'initialize_vault_strategy', settings, vaultAccounts)]));

  // 初始化仅追加一字节，新策略金库默认开放自动收回，保留原字段的字节内容。
  // Initialization appends one byte, with new vaults defaulting to automatic recall and retaining their original fields.
  const activeVaultData = (await rpc.getAccountInfo(vault)).data;
  assert.equal(activeVaultData.length, 138);
  assert.deepEqual(activeVaultData.subarray(0, 137), legacyVaultData);
  assert.equal(activeVaultData[137] & 1, 1);

  // 管理者签名不能启用功能；金库管理员可重复调用且账户内容保持一致。
  // The strategy manager cannot enable the capability. Repeated calls by the vault administrator preserve the account bytes.
  await reject(() => submit([instruction(vaultIdl, 'enable_auto_recall', [], {
    ...vaultAccounts, administrator: manager.publicKey,
  })], manager), /ConstraintHasOne/);
  for (const attempt of [1, 2]) {
    succeeded(await submit([instruction(vaultIdl, 'enable_auto_recall', [], vaultAccounts)]));
    assert.deepEqual((await rpc.getAccountInfo(vault)).data, activeVaultData, 'Enablement changed vault bytes on attempt ' + attempt);
  }

  /** 20 mockUSDC 按测试价兑换 0.2 tSOL，全部以整数最小单位计。 Swap 20 mockUSDC for 0.2 tSOL at the test price, using integer base units. */
  const swapIn = 20n * cashUnit;
  const swapOut = spotUnit / 5n;

  // 储备不足拒绝成交。注入两种测试资产后，实际成交发生 SPL 代币划转。
  // Reject swaps while reserves are empty. Executed swaps transfer SPL tokens from funded reserves.
  await reject(() => manage('strategy_swap', [true, swapIn, swapOut]), /InsufficientStrategyLiquidity/);
  await mintTo(rpc, admin, cashMint, swapCash, admin, 300n * cashUnit);
  await mintTo(rpc, admin, spotMint, swapSpot, admin, 3n * spotUnit);
  await reject(() => manage('strategy_swap', [true, swapIn, swapOut], investor), /ConstraintHasOne/);
  await reject(() => manage('strategy_swap', [true, swapIn, swapOut + 1n]), /MinimumStrategyOutputNotMet/);
  expectAction(await manage('strategy_swap', [true, swapIn, swapOut]), 0, cashMint, spotMint, swapIn, swapOut);
  await verifyBalances([80n * cashUnit, swapOut, 100n * cashUnit, 0n, 0n]);

  // 激活后必须带正确估值依赖，第二笔存入仍应按 1:1 计价。
  // After activation, require correct valuation inputs. The second deposit still prices shares at 1:1.
  await reject(() => invest('deposit', cashUnit, cashUnit), /InvalidStrategyAccounts/);
  await reject(() => invest('redeem', cashUnit, cashUnit), /InvalidStrategyAccounts/);
  await reject(() => invest('deposit', cashUnit, cashUnit, [strategy, swapSpot, ...valuation.slice(2)]), /InvalidStrategyAccounts/);
  succeeded(await invest('deposit', 25n * cashUnit, 25n * cashUnit, valuation));
  assert.equal((await getAccount(rpc, investorShares)).amount, 125n * cashUnit);

  // 首次出借创建金库 PDA 份额；超过净值 40% 的分配失败。
  // First supply creates vault-PDA shares. Allocating more than 40% of NAV fails.
  await reject(() => manage('strategy_lend', [51n * cashUnit, 51n * cashUnit]), /StrategyLimitExceeded/);
  expectAction(await manage('strategy_lend', [30n * cashUnit, 30n * cashUnit]), 1,
    cashMint, cashMint, 30n * cashUnit, 30n * cashUnit);
  await verifyBalances([75n * cashUnit, swapOut, 125n * cashUnit, 30n * cashUnit, 30n * cashUnit]);

  // 借款提走池现金后只能收回余额，现金不足时投资者份额不能被销毁。
  // Following a borrow, recalls are liquidity-limited. Shares cannot burn while cash is too low to settle.
  succeeded(await borrow('deposit_collateral', spotUnit, borrowerSpot));
  succeeded(await borrow('borrow', 20n * cashUnit));
  await reject(() => manage('strategy_recall', [11n * cashUnit, 11n * cashUnit]), /InsufficientSupplyWithdrawalLiquidity/);
  expectAction(await manage('strategy_recall', [10n * cashUnit, 10n * cashUnit]), 2,
    cashMint, cashMint, 10n * cashUnit, 10n * cashUnit);
  await verifyBalances([85n * cashUnit, swapOut, 125n * cashUnit, 0n, 20n * cashUnit]);
  await reject(() => invest('redeem', 100n * cashUnit, 100n * cashUnit, valuation), /InsufficientVaultCash/);
  await reject(() => invest('redeem', 125n * cashUnit, 125n * cashUnit, valuation), /StrategyPositionsRemain|InsufficientVaultCash/);
  await reject(() => invest('redeem', 125n * cashUnit, 125n * cashUnit, recallValuation), /StrategyPositionsRemain/);

  // 还款恢复池现金，资金收回并卖出全部 tSOL 后可完整赎回。
  // Repayment restores liquidity. Recall the rest of the lending position and sell all tSOL before full redemption.
  succeeded(await borrow('repay', 20n * cashUnit, borrowerCash));
  expectAction(await manage('strategy_recall', [20n * cashUnit, 20n * cashUnit]), 2,
    cashMint, cashMint, 20n * cashUnit, 20n * cashUnit);
  await reject(() => manage('clear_strategy_dust', []), /StrategyDustHasValue/);
  expectAction(await manage('strategy_swap', [false, swapOut, swapIn]), 0, spotMint, cashMint, swapOut, swapIn);
  await verifyBalances([125n * cashUnit, 0n, 125n * cashUnit, 0n, 0n]);

  // 一单位最小粒度的外部捐入按价格向下舍入为零。管理者清理后才能结算最后份额。
  // A one-base-unit donation rounds to zero at the test price. A manager cleanup is required before the final redemption.
  await mintTo(rpc, admin, spotMint, custody, admin, 1n);
  await reject(() => invest('redeem', 125n * cashUnit, 125n * cashUnit, valuation), /StrategyPositionsRemain/);
  await reject(() => manage('clear_strategy_dust', [], investor), /ConstraintHasOne/);
  /** 清理把最小单位现货转入约定的测试储备账户。 Cleanup transfers the dust unit to the canonical test reserve. */
  const reserveBeforeCleanup = (await getAccount(rpc, swapSpot)).amount;
  succeeded(await manage('clear_strategy_dust', []));
  assert.equal((await getAccount(rpc, swapSpot)).amount, reserveBeforeCleanup + 1n);
  await verifyBalances([125n * cashUnit, 0n, 125n * cashUnit, 0n, 0n]);
  const redeemed = await invest('redeem', 125n * cashUnit, 125n * cashUnit, valuation);
  succeeded(redeemed);
  await verifyBalances([0n, 0n, 0n, 0n, 0n]);
  assert.equal((await getAccount(rpc, investorCash)).amount, 200n * cashUnit);
  assert.equal((await getAccount(rpc, investorShares)).amount, 0n);
  // 再存入 100、出借 40 和借出 35 mockUSDC，金库现金与池内可提额分别为 60 和 5。
  // Start a second lifecycle with a 100 mockUSDC deposit, 40 supplied, and 35 borrowed, leaving 60 in custody and 5 recallable.
  succeeded(await invest('deposit', 100n * cashUnit, 100n * cashUnit, valuation));
  expectAction(await manage('strategy_lend', [40n * cashUnit, 40n * cashUnit]), 1,
    cashMint, cashMint, 40n * cashUnit, 40n * cashUnit);
  succeeded(await borrow('borrow', 35n * cashUnit));
  await verifyBalances([60n * cashUnit, 0n, 100n * cashUnit, 5n * cashUnit, 40n * cashUnit]);

  // 只读估值保留现金支付行为。附加 CPI 账户后，超出现金与可提流动性总额仍拒绝且无业务变化。
  // Read-only valuation preserves cash settlement. Even with CPI accounts, an amount above cash plus recallable liquidity fails without changing accounts.
  await reject(() => invest('redeem', 63n * cashUnit, 63n * cashUnit, valuation), /InsufficientVaultCash/);
  await reject(() => invest('redeem', 66n * cashUnit, 66n * cashUnit, recallValuation),
    /InsufficientVaultCash|InsufficientSupplyWithdrawalLiquidity/);
  await reject(() => invest('redeem', 63n * cashUnit, 63n * cashUnit, [...recallValuation.slice(0, -1), vaultProgram]),
    /InvalidStrategyAccounts/);

  // 冻结投资者收款账户，使借贷 CPI 已成功后最后的代币转账失败，检查所有账户原子回滚。
  // Freeze the investor destination so settlement fails after a successful lending CPI, then verify every changed account rolls back.
  await freezeAccount(rpc, admin, investorCash, cashMint, admin);
  const frozenPayout = await reject(() => invest('redeem', 63n * cashUnit, 63n * cashUnit, recallValuation), /account is frozen/i);
  assert.ok(frozenPayout.logs.includes('Program ' + lendingProgram.toBase58() + ' success'), frozenPayout.logs.join('\n'));
  await thawAccount(rpc, admin, investorCash, cashMint, admin);

  // 精确补足 3 mockUSDC 缺口，检查池现金、金库出借份额和投资者余额按实际数量变动。
  // Recall exactly the 3 mockUSDC shortfall, checking actual pool cash, vault supply shares, and investor proceeds.
  const partialRecall = await invest('redeem', 63n * cashUnit, 63n * cashUnit, recallValuation);
  succeeded(partialRecall);
  assert.deepEqual(strategyEvents(partialRecall.logs, vaultProgram), []);
  await verifyBalances([0n, 0n, 37n * cashUnit, 2n * cashUnit, 37n * cashUnit]);
  assert.equal((await getAccount(rpc, investorCash)).amount, 163n * cashUnit);
  await reject(() => invest('redeem', 3n * cashUnit, 3n * cashUnit, recallValuation),
    /InsufficientVaultCash|InsufficientSupplyWithdrawalLiquidity/);

  // 还款恢复流动性，无需管理者额外签名，最后一笔赎回收回剩余全部池份额。
  // Repayment restores liquidity. The final redemption recalls all remaining pool shares without an additional manager signature.
  succeeded(await borrow('repay', 35n * cashUnit, borrowerCash));

  // 在零旧债、仍有 37 池份额时启用计息。扩展账本保留旧字段，之后的自动收回使用新布局。
  // Enable interest with zero legacy debt and 37 live pool shares. The expanded ledger retains its fields, and auto recall then uses the new layout.
  const legacyPoolData = (await rpc.getAccountInfo(supplyPool)).data;
  assert.equal(legacyPoolData.length, 56);
  succeeded(await submit([instruction(lendingIdl, 'enable_interest', [], lendingAccounts)]));
  const interestPoolData = (await rpc.getAccountInfo(supplyPool)).data;
  assert.equal(interestPoolData.length, 88);
  assert.deepEqual(interestPoolData.subarray(0, legacyPoolData.length), legacyPoolData);
  await verifyBalances([0n, 0n, 37n * cashUnit, 37n * cashUnit, 37n * cashUnit]);

  const finalRecall = await invest('redeem', 37n * cashUnit, 37n * cashUnit, recallValuation);
  succeeded(finalRecall);
  await verifyBalances([0n, 0n, 0n, 0n, 0n]);
  assert.equal((await getAccount(rpc, investorCash)).amount, 200n * cashUnit);
  assert.equal((await getAccount(rpc, investorShares)).amount, 0n);
  console.log('Vault strategy, manual recall and legacy redemption passed on Localnet:', redeemed.signature);
  console.log('Automatic recall, settlement rollback and repayment recovery passed on Localnet:', finalRecall.signature);
}

await verifyVaultStrategy();

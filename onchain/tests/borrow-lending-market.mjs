import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  createMint, createTransferCheckedInstruction, getAccount, getOrCreateAssociatedTokenAccount,
  mintTo, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';

/** 两类代币的最小单位和链上借款上限，以整单位和基点表示。 Mint scales in base units per token and the on-chain borrowing cap in basis points. */
const debtUnit = 1_000_000n;
const collateralUnit = 1_000_000_000n;
const borrowLtvBps = 7_000n;
const bpsUnit = 10_000n;
/** 使用已确认的账本状态。 Read confirmed ledger state. */
const commitment = 'confirmed';
/** 用于派生市场初始化所需的 ProgramData。 Upgradeable loader used to derive ProgramData for market initialization. */
const loaderId = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/**
 * 根据命名空间和名称计算 Anchor 的八字节判别符。
 * Compute an eight-byte Anchor discriminator from its namespace and name.
 * @param {string} name 带命名空间的名称。 Namespaced name.
 * @returns {Buffer} 八字节判别符。 Eight-byte discriminator.
 */
function discriminator(name) {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}

/**
 * 解码序列化数据中指定位置的公钥。
 * Decode a public key at the given offset in serialized data.
 * @param {Buffer} data 账户或事件字节。 Account or event bytes.
 * @param {number} offset 32 字节公钥的起始偏移量。 Starting offset of the 32-byte key.
 * @returns {string} Base58 公钥。 Base58 public key.
 */
function readKey(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

/**
 * 验证独立市场的借款生命周期，可在旧版初始化和出借后原位升级。
 * Verify the borrowing lifecycle on a disposable market, optionally upgrading in place after initialization and supply on the previous version.
 */
async function verifyBorrowing() {
  /** 测试管理员密钥、回环 RPC 和可选的新版程序 ELF 路径。 Test administrator key, loopback RPC, and optional upgraded ELF path. */
  const [administratorFile, rpcUrl = 'http://127.0.0.1:8899', upgradedProgramFile] = process.argv.slice(2);
  assert.ok(administratorFile,
    'Usage: node borrow-lending-market.mjs <admin-keypair-file> [local-rpc-url] [upgraded-elf]');
  const endpoint = new URL(rpcUrl);
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Use an HTTP Localnet endpoint on localhost.');

  /** 使用构建生成的 IDL，接入本地验证器和市场管理签名人。 Load the generated IDL and bind the local validator and administrative signer. */
  const idl = JSON.parse(await readFile(new URL('../target/idl/ggboy_lending.json', import.meta.url), 'utf8'));
  const programId = new PublicKey(idl.address);
  const connection = new Connection(endpoint.href, commitment);
  const administrator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(administratorFile, 'utf8'))));
  const programData = PublicKey.findProgramAddressSync([programId.toBuffer()], loaderId)[0];

  /**
   * 按公开种子派生借贷程序 PDA。
   * Derive a lending program PDA from the public seeds.
   * @param {string} seed 固定种子。 Static seed.
   * @param {...PublicKey} keys 依次附加的种子公钥。 Public keys appended to the seed in order.
   */
  function pda(seed, ...keys) {
    return PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map((key) => key.toBuffer())], programId)[0];
  }

  // CLI 以最终确认状态检查升级资金，先明确要求测试资金也已最终确认。
  // The upgrade CLI checks finalized funds, so require finalized test funding before setting up the fixture.
  if (upgradedProgramFile) {
    assert.ok(await connection.getBalance(administrator.publicKey, 'finalized') >= 10 * LAMPORTS_PER_SOL,
      'Airdrop at least 10 finalized Localnet SOL to the test administrator.');
  }

  /** 出借、借款和预言机共享同一市场地址，两类抵押和资金托管保持独立。 Supply, borrowing, and oracle use the same market with separate cash and collateral custodies. */
  const market = pda('lending_market');
  const cashVault = pda('cash_vault', market);
  const collateralVault = pda('collateral_vault', market);
  const supplyPool = pda('supply_pool', market);
  const borrowMarket = pda('borrow_market', market);
  const mockPrice = pda('mock_collateral_price', market);
  const originalAccounts = [market, cashVault, collateralVault, supplyPool];
  assert.deepEqual(await connection.getMultipleAccountsInfo([...originalAccounts, borrowMarket, mockPrice]), Array(6).fill(null),
    'Use a disposable ledger with an uninitialized lending market.');

  /** 资产 Mint 的小数位固定为 6 和 9，用于验证精度归一化。 Use 6 and 9 decimals on the two test mints to verify decimal normalization. */
  const debtMint = await createMint(connection, administrator, administrator.publicKey, null, 6);
  const collateralMint = await createMint(connection, administrator, administrator.publicKey, null, 9);
  const shared = {
    market, lending_program: programId, program_data: programData, debt_mint: debtMint,
    collateral_mint: collateralMint, cash_vault: cashVault, collateral_vault: collateralVault,
    supply_pool: supplyPool, borrow_market: borrowMarket, mock_collateral_price: mockPrice,
    token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
  };
  /** 用不同的微 lamport 计算价格区分输入相同的交易。 Distinguish repeated inputs by assigning a unique compute price in micro-lamports. */
  let transactionNumber = 0;

  /**
   * 在账本执行测试指令，管理员支付手续费以便检查玩家租金回滚。
   * Execute a test instruction on the ledger with administrator-paid fees to isolate user rent rollback.
   * @param {TransactionInstruction} instruction 业务或测试准备指令。 Business or test funding instruction.
   * @param {Keypair} [signer] 业务指令的签名人。 Business instruction signer.
   */
  async function submit(instruction, signer = administrator) {
    /** 保留区块哈希有效期，跳过预检确保失败用例也会真实执行并写日志。 Retain the blockhash lifetime and skip preflight so negative cases execute and log on the validator. */
    const lifetime = await connection.getLatestBlockhash();
    const transaction = new Transaction({ ...lifetime, feePayer: administrator.publicKey }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: transactionNumber++ }), instruction,
    );
    transaction.sign(...(signer === administrator ? [administrator] : [administrator, signer]));
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const status = await connection.confirmTransaction({ signature, ...lifetime }, commitment);
    const record = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
    assert.ok(record?.meta?.logMessages, 'Missing transaction metadata for ' + signature);
    assert.deepEqual(record.meta.err, status.value.err);
    return { signature, logs: record.meta.logMessages, error: record.meta.err };
  }

  /**
   * 按公开 IDL 构造指令，并核对 u64 最小单位参数编码。
   * Construct an instruction from the public IDL and check its u64 base-unit argument encoding.
   * @param {string} name 指令名称。 Instruction name.
   * @param {bigint[]} amounts u64 数量，单位由对应的 Mint 决定。 u64 amounts in the relevant mint's base units.
   * @param {Record<string, PublicKey>} accounts 本次操作的账户或负例替换项。 Action-specific addresses or negative-case substitutions.
   * @param {Keypair} [signer] 本次业务签名者。 Signer for this action.
   */
  function execute(name, amounts, accounts, signer) {
    /** IDL 提供账户顺序和权限，判别符另按名称核对。 The IDL provides account order and permissions; check the discriminator independently by name. */
    const definition = idl.instructions.find((entry) => entry.name === name);
    assert.ok(definition, 'Missing built IDL instruction ' + name);
    assert.deepEqual(Buffer.from(definition.discriminator), discriminator('global:' + name));
    assert.deepEqual(definition.args.map((argument) => argument.type), amounts.map(() => 'u64'));
    const data = Buffer.alloc(8 + 8 * amounts.length);
    Buffer.from(definition.discriminator).copy(data);
    amounts.forEach((amount, index) => data.writeBigUInt64LE(amount, 8 + 8 * index));
    const addresses = { ...shared, ...accounts };
    const keys = definition.accounts.map((account) => {
      /** 子操作覆盖后确定的实际账户。 Actual account after applying action-specific substitutions. */
      const pubkey = addresses[account.name];
      assert.ok(pubkey instanceof PublicKey, 'Missing account ' + account.name);
      return { pubkey, isSigner: account.signer === true, isWritable: account.writable === true };
    });
    return submit(new TransactionInstruction({ programId, data, keys }), signer);
  }

  /** 创建有关联账户、初始资产和规范 PDA 的独立测试钱包。 Create an isolated and funded test wallet with ATAs and canonical PDAs. */
  async function createWallet() {
    /** 临时签名人用本地 SOL 支付第一次记账的租金。 The ephemeral signer pays first-use account rent with Localnet SOL. */
    const signer = Keypair.generate();
    const funded = await submit(SystemProgram.transfer({
      fromPubkey: administrator.publicKey, toPubkey: signer.publicKey, lamports: LAMPORTS_PER_SOL,
    }));
    assert.equal(funded.error, null);
    /** 使用 Phantom 正常流程依赖的两枚经典关联代币账户。 Use the same two classic associated token accounts as the normal Phantom workflow. */
    const debt = (await getOrCreateAssociatedTokenAccount(connection, administrator, debtMint, signer.publicKey)).address;
    const collateral = (await getOrCreateAssociatedTokenAccount(connection, administrator, collateralMint, signer.publicKey)).address;
    await mintTo(connection, administrator, debtMint, debt, administrator, 200n * debtUnit);
    await mintTo(connection, administrator, collateralMint, collateral, administrator, 3n * collateralUnit);
    return {
      signer, debt, collateral,
      borrowPosition: pda('borrow_position', market, signer.publicKey),
      supplyPosition: pda('supply_position', market, signer.publicKey),
    };
  }

  /**
   * 按一比一份额把测试资产存入市场。
   * Place test assets in the market at the expected 1:1 share rate.
   * @param {object} wallet 钱包签名人、来源账户及出借仓位。 Wallet signer, source account and supply position.
   * @param {bigint} amount mockUSDC 最小单位金额。 mockUSDC base-unit amount.
   */
  async function supply(wallet, amount) {
    /** 只把真实成功的出借记入验收结果。 Count only actual successful supply execution. */
    const result = await execute('supply', [amount, amount], {
      supplier: wallet.signer.publicKey, source: wallet.debt, supply_position: wallet.supplyPosition,
    }, wallet.signer);
    assert.equal(result.error, null, result.logs.join('\n'));
  }

  /** 建立历史市场和份额，需要时在出借后以相同地址升级。 Establish market and shares, optionally upgrading in place after supply. */
  const initialized = await execute('initialize_lending_market', [], { administrator: administrator.publicKey });
  assert.equal(initialized.error, null, initialized.logs.join('\n'));
  const alice = await createWallet();
  const bob = await createWallet();
  await supply(bob, 100n * debtUnit);
  console.log('Localnet mints: debt=' + debtMint.toBase58() + ' collateral=' + collateralMint.toBase58());
  if (upgradedProgramFile) {
    /** 保存旧市场、托管及已有出借账本的账户字节。 Capture original account bytes, including the existing supply ledger. */
    const preserved = [...originalAccounts, bob.supplyPosition];
    const before = await connection.getMultipleAccountsInfo(preserved);
    // CLI 严格使用脚本之前已校验的 HTTP 回环 RPC。
    // The CLI uses only the HTTP loopback RPC validated above.
    await promisify(execFile)('solana', [
      '--url', endpoint.href, '--keypair', administratorFile, '--commitment', 'finalized',
      'program', 'deploy', upgradedProgramFile, '--program-id', programId.toBase58(),
      '--upgrade-authority', administratorFile,
    ], { timeout: 180_000 }).catch((error) => {
      /** CLI 可附带临时缓冲区密钥说明，只显示工具返回的故障摘要。 CLI recovery output can contain a temporary buffer key, so retain only the failure summary. */
      const summary = error.stderr?.split('\n').findLast((line) => line.startsWith('Error: '));
      throw new Error(summary ?? 'Localnet in-place upgrade failed.');
    });
    assert.deepEqual(await connection.getMultipleAccountsInfo(preserved), before);
    console.log('Same-address upgrade preserved the original market, custodies, and supplier state.');
  }

  /** 跟踪所有资产、仓位及租金付款账户以核对失败回滚。 Watch token, position, and rent payer accounts to verify failure rollback. */
  const watched = [...originalAccounts, borrowMarket, mockPrice,
    alice.borrowPosition, bob.borrowPosition, alice.supplyPosition, bob.supplyPosition,
    alice.debt, alice.collateral, bob.debt, bob.collateral, alice.signer.publicKey, bob.signer.publicKey];

  /**
   * 从借贷程序顶层调用读取实际成交事件。
   * Decode actual settlement events from top-level lending program invocations.
   * @param {string[]} logs 验证器记录的真实交易日志。 Actual transaction logs recorded by the validator.
   * @returns {object[]} 已匹配布局的动作和数量。 Actions and amounts matching the expected layout.
   */
  function borrowEvents(logs) {
    /** 调用栈排除来自其他程序或 CPI 的事件。 The invocation stack excludes other programs and CPI events. */
    const stack = [];
    const prefix = discriminator('event:LendingBorrowAction');
    const events = [];
    for (const line of logs) {
      /** 跟踪运行时记录的程序调用。 Track invocations recorded by the runtime. */
      const invocation = /^Program (\S+) invoke \[\d+]$/.exec(line);
      if (invocation) {
        stack.push(invocation[1]);
        continue;
      }
      if (/^Program \S+ (?:success$|failed:)/.test(line)) {
        stack.pop();
        continue;
      }
      if (stack.length !== 1 || stack[0] !== programId.toBase58() || !line.startsWith('Program data: ')) continue;
      /** 两把公钥后的动作位于字节 72，后接三个小端 u64 最小单位数量。 The action is at byte 72 after both keys, followed by three little-endian u64 base-unit amounts. */
      const bytes = Buffer.from(line.slice('Program data: '.length), 'base64');
      if (!bytes.subarray(0, 8).equals(prefix)) continue;
      assert.equal(bytes.length, 97);
      events.push({
        market: readKey(bytes, 8), borrower: readKey(bytes, 40), kind: bytes[72],
        amount: bytes.readBigUInt64LE(73), collateral: bytes.readBigUInt64LE(81), debt: bytes.readBigUInt64LE(89),
      });
    }
    return events;
  }

  /**
   * 通过测试钱包签名发起借款操作，允许指定不匹配账户测试权限。
   * Submit a signed borrowing action with optional account substitutions for access-control tests.
   * @param {string} name 指令名称。 Instruction name.
   * @param {object} wallet 发起操作的钱包。 Wallet initiating the operation.
   * @param {bigint} amount 对应 Mint 的最小单位数量。 Amount in the relevant mint's base units.
   * @param {Record<string, PublicKey>} [overrides] 负例的账户覆盖。 Account overrides for rejection tests.
   */
  function action(name, wallet, amount, overrides) {
    return execute(name, [amount], {
      borrower: wallet.signer.publicKey, borrow_position: wallet.borrowPosition,
      source: name === 'deposit_collateral' ? wallet.collateral : wallet.debt,
      destination: name === 'withdraw_collateral' ? wallet.collateral : wallet.debt,
      ...overrides,
    }, wallet.signer);
  }

  /**
   * 验证成功操作实际发出的事件及执行后数量。
   * Verify the event emitted after a successful operation and its resulting amounts.
   * @param {string} name 指令名称。 Instruction name.
   * @param {object} wallet 发起操作的钱包。 Initiating wallet.
   * @param {number} kind 链上事件中的动作编号。 On-chain event action ID.
   * @param {bigint} amount 实际操作数量，按对应 Mint 最小单位。 Operation amount in the relevant mint's base units.
   * @param {bigint} collateral 操作后抵押 Mint 的最小单位量。 Post-operation collateral in base units.
   * @param {bigint} debt 操作后借款 Mint 的最小单位量。 Post-operation debt in base units.
   */
  async function accept(name, wallet, kind, amount, collateral, debt) {
    /** 对照实际日志和预期链上结果。 Compare actual logs with expected on-chain results. */
    const result = await action(name, wallet, amount);
    assert.equal(result.error, null, result.logs.join('\n'));
    assert.deepEqual(borrowEvents(result.logs), [{
      market: market.toBase58(), borrower: wallet.signer.publicKey.toBase58(), kind, amount, collateral, debt,
    }]);
    console.log(name + ' confirmed: ' + result.signature);
  }

  /**
   * 验证负例的错误原因、业务账户和租金余额全部回滚。
   * Verify rejection reason and rollback of all business accounts and rent balances.
   * @param {() => Promise<object>} operation 提交负例交易的方法。 Function submitting the negative test transaction.
   * @param {RegExp} reason 预期错误日志模式。 Expected error log pattern.
   */
  async function reject(operation, reason) {
    /** 负例提交前后批量读取完全相同的账户集合。 Read the same complete set of accounts before and after execution. */
    const before = await connection.getMultipleAccountsInfo(watched);
    const result = await operation();
    assert.equal(result.error?.InstructionError?.[0], 1, result.logs.join('\n'));
    assert.match(result.logs.join('\n'), reason);
    assert.deepEqual(borrowEvents(result.logs), []);
    assert.deepEqual(await connection.getMultipleAccountsInfo(watched), before);
  }

  /**
   * 通过指定签名人发布每一枚 tSOL 对应的 mockUSDC 价格。
   * Publish a mockUSDC price per whole tSOL from the given signer.
   * @param {bigint} amount 六位小数最小单位的价格。 Price in six-decimal base units.
   * @param {Keypair} [signer] 市场管理员或未授权负例签名人。 Market administrator or unauthorized test signer.
   */
  function publish(amount, signer = administrator) {
    return execute('set_mock_collateral_price', [amount], { administrator: signer.publicKey }, signer);
  }

  /**
   * 校验程序账户归属、长度和市场绑定。
   * Check a program account's ownership, length, and market binding.
   * @param {PublicKey} key 程序 PDA 地址。 Program PDA address.
   * @param {string} name Anchor 账户名称。 Anchor account name.
   * @param {number} size 包含判别符的总字节数。 Total byte count including discriminator.
   */
  async function stateAt(key, name, size) {
    /** 从验证器读取真实账户数据。 Read actual account data from the validator. */
    const info = await connection.getAccountInfo(key);
    assert.ok(info?.owner.equals(programId) && !info.executable, 'Invalid account owner for ' + name);
    assert.equal(info.data.length, size);
    assert.deepEqual(info.data.subarray(0, 8), discriminator('account:' + name));
    assert.equal(readKey(info.data, 8), market.toBase58());
    return info.data;
  }

  /**
   * 直接从 SPL Token 账户读取真实余额。
   * Read the exact balance from the SPL Token account.
   * @param {PublicKey} address SPL Token 账户地址。 SPL Token account address.
   * @returns {Promise<bigint>} 对应 Mint 最小单位余额。 Balance in the mint's base units.
   */
  async function amountAt(address) {
    return (await getAccount(connection, address, commitment)).amount;
  }

  // 无负债的持仓可以在预言机未创建时取回全部抵押品。
  // A debt-free position can withdraw all collateral before the oracle exists.
  const halfCollateral = collateralUnit / 2n;
  await accept('deposit_collateral', bob, 0, halfCollateral, halfCollateral, 0n);
  await accept('withdraw_collateral', bob, 3, halfCollateral, 0n, 0n);
  assert.equal(await connection.getAccountInfo(mockPrice), null);
  assert.equal(await amountAt(bob.collateral), 3n * collateralUnit);

  // 无价格借款、不属于签名钱包的仓位、错误代币来源和未授权价格更新均须回滚。
  // Borrowing without prices, wrong wallet positions, incorrect token owners, and unauthorized price updates must roll back.
  await accept('deposit_collateral', alice, 0, halfCollateral, halfCollateral, 0n);
  await reject(() => action('borrow', alice, debtUnit), /InvalidMockPrice|AccountNotInitialized/);
  assert.equal(await connection.getAccountInfo(borrowMarket), null);
  await reject(() => action('deposit_collateral', bob, 1n, { borrow_position: alice.borrowPosition }), /ConstraintSeeds/);
  await reject(() => action('deposit_collateral', alice, 1n, { source: bob.collateral }), /ConstraintTokenOwner/);
  await reject(() => publish(200n * debtUnit, bob.signer), /UnauthorizedAdministrator|ConstraintHasOne/);
  await reject(() => publish(0n), /InvalidMockPrice/);

  /** 预言机按每整 tSOL 的六位最小单位发布，使用测试价格计算抵押借款上限。 Post six-decimal price per whole tSOL, then use it to determine the borrowing limit. */
  const oraclePrice = 200n * debtUnit;
  const ltvLimit = halfCollateral * oraclePrice * borrowLtvBps / (collateralUnit * bpsUnit);
  const priced = await publish(oraclePrice);
  assert.equal(priced.error, null, priced.logs.join('\n'));
  const oracle = await stateAt(mockPrice, 'MockCollateralPrice', 56);
  assert.equal(oracle.readBigUInt64LE(40), oraclePrice);
  assert.ok(oracle.readBigInt64LE(48) > 0n);

  // 超过抵押额度一最小单位被拒绝，准确等于额度时放款。
  // Reject one base unit above the collateral limit and fund a loan exactly at the limit.
  await reject(() => action('borrow', alice, ltvLimit + 1n), /CollateralTooLow/);
  await accept('borrow', alice, 1, ltvLimit, halfCollateral, ltvLimit);
  assert.equal(await amountAt(alice.debt), 200n * debtUnit + ltvLimit);
  assert.equal(await amountAt(cashVault), 30n * debtUnit);
  assert.equal((await stateAt(borrowMarket, 'BorrowMarket', 48)).readBigUInt64LE(40), ltvLimit);

  // 抵押足够时由流动性限制借款，同时验证现有债务不会阻止出借。
  // With sufficient collateral, constrain borrowing by liquidity and verify outstanding debt does not block new supply.
  const totalCollateral = halfCollateral + collateralUnit;
  await accept('deposit_collateral', alice, 0, collateralUnit, totalCollateral, ltvLimit);
  await reject(() => action('borrow', alice, 30n * debtUnit + 1n), /InsufficientBorrowLiquidity/);
  await supply(bob, 25n * debtUnit);
  const supplyState = await stateAt(supplyPool, 'SupplyPool', 56);
  assert.equal(supplyState.readBigUInt64LE(40), 125n * debtUnit);
  assert.equal(supplyState.readBigUInt64LE(48), 125n * debtUnit);

  // 直接转入的代币只增加托管现金，不能提高账面可借额度。
  // A donation increases custody cash without affecting the ledger-based borrowing cap.
  const donation = await submit(createTransferCheckedInstruction(
    bob.debt, debtMint, cashVault, bob.signer.publicKey, 7n * debtUnit, 6,
  ), bob.signer);
  assert.equal(donation.error, null);
  assert.equal(await amountAt(cashVault), 62n * debtUnit);
  await reject(() => action('borrow', alice, 55n * debtUnit + 1n), /InsufficientBorrowLiquidity/);
  await reject(() => action('repay', alice, ltvLimit + 1n), /RepaymentExceedsDebt/);

  // 部分还款一最小单位制造小数边界，链上要求保留的抵押品须向上取整。
  // Repay one base unit to create a fractional boundary; the required retained collateral must round up.
  const debtAfterPartialRepay = ltvLimit - 1n;
  await accept('repay', alice, 2, 1n, totalCollateral, debtAfterPartialRepay);
  const ltvDenominator = oraclePrice * borrowLtvBps;
  const requiredCollateral = (debtAfterPartialRepay * collateralUnit * bpsUnit + ltvDenominator - 1n) / ltvDenominator;
  const canWithdraw = totalCollateral - requiredCollateral;
  assert.equal(requiredCollateral, 499_999_993n);
  await reject(() => action('withdraw_collateral', alice, canWithdraw + 1n), /CollateralTooLow/);
  await accept('withdraw_collateral', alice, 3, canWithdraw, requiredCollateral, debtAfterPartialRepay);
  const remaining = await stateAt(alice.borrowPosition, 'BorrowPosition', 88);
  assert.equal(readKey(remaining, 40), alice.signer.publicKey.toBase58());
  assert.equal(remaining.readBigUInt64LE(72), requiredCollateral);
  assert.equal(remaining.readBigUInt64LE(80), debtAfterPartialRepay);

  // 价格下跌后可继续还款，付清欠款后可全部取回。还款指令没有任何预言机账户参数。
  // A price drop still allows repayment and full collateral recovery after debt clears. Repay has no oracle account argument.
  const reducedPrice = await publish(100n * debtUnit);
  assert.equal(reducedPrice.error, null, reducedPrice.logs.join('\n'));
  await reject(() => action('withdraw_collateral', alice, 1n), /CollateralTooLow/);
  assert.ok(idl.instructions.find((entry) => entry.name === 'repay').accounts.every((account) => account.name !== 'mock_collateral_price'));
  await accept('repay', alice, 2, debtAfterPartialRepay, requiredCollateral, 0n);
  await accept('withdraw_collateral', alice, 3, requiredCollateral, 0n, 0n);

  /** 最后核对持久化空仓、零总债务、原有出借记账及全部真实代币金额。 Finally verify the persistent empty position, zero total debt, prior supply accounting and physical token balances. */
  const settled = await stateAt(alice.borrowPosition, 'BorrowPosition', 88);
  assert.equal(settled.readBigUInt64LE(72), 0n);
  assert.equal(settled.readBigUInt64LE(80), 0n);
  assert.equal((await stateAt(borrowMarket, 'BorrowMarket', 48)).readBigUInt64LE(40), 0n);
  assert.deepEqual(await stateAt(supplyPool, 'SupplyPool', 56), supplyState);
  assert.equal(await amountAt(cashVault), 132n * debtUnit);
  assert.equal(await amountAt(collateralVault), 0n);
  assert.equal(await amountAt(alice.debt), 200n * debtUnit);
  assert.equal(await amountAt(alice.collateral), 3n * collateralUnit);
  console.log('Localnet borrowing, repayment, collateral, supply compatibility, and rollback verified.');
}

await verifyBorrowing();

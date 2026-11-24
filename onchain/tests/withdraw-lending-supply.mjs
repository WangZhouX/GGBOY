import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  createMint, createTransferCheckedInstruction, freezeAccount, getAccount, getOrCreateAssociatedTokenAccount,
  mintTo, thawAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';

/** mockUSDC 和出借份额均使用六位小数，以一整单位对应的最小单位计。 Base units per whole mockUSDC or supply share, both with six decimals. */
const unit = 1_000_000n;
/** 每整单位 tSOL 对应九位小数的最小单位。 Nine-decimal base units per whole tSOL. */
const collateralUnit = 1_000_000_000n;
/** 读取已确认交易和状态，程序升级由 CLI 等待最终确认。 Read confirmed transactions and state. The CLI waits for finalization of upgrades. */
const commitment = 'confirmed';
/** 从借贷程序公钥派生升级数据账户的加载器。 Loader used to derive ProgramData from the lending program key. */
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/**
 * 从 Anchor 名称计算八字节判别符。
 * Derive an eight-byte discriminator from a namespaced Anchor name.
 * @param {string} name 含命名空间的指令、账户或事件名称。 Namespaced instruction, account or event name.
 * @returns {Buffer} 二进制判别符。 Binary discriminator.
 */
function discriminator(name) {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}

/**
 * 解码本程序顶层调用中的出借提取事件。
 * Decode supply withdrawal events emitted by top-level calls to this program.
 * @param {string[]} logs 验证器记录的原始交易日志。 Original validator transaction logs.
 * @param {PublicKey} programId 预期事件来源的程序公钥。 Program key expected to emit the event.
 * @returns {object[]} 事件的公钥和未舍入的最小单位金额。 Event keys and exact amounts in base units.
 */
function withdrawalEvents(logs, programId) {
  /** 调用栈排除 Token CPI 以及其他程序的事件；结果遵循日志顺序。 The invocation stack excludes Token CPI and other programs. Events follow log order. */
  const stack = [];
  const events = [];
  const prefix = discriminator('event:LendingSupplyWithdrawal');
  for (const line of logs) {
    /** 运行时记录的程序调用入口。 Program invocation entry recorded by the runtime. */
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

    /** 事件依次包括判别符、三个公钥和三个小端 u64。 The event contains the discriminator, three public keys, and three little-endian u64s. */
    const bytes = Buffer.from(line.slice('Program data: '.length), 'base64');
    if (!bytes.subarray(0, 8).equals(prefix)) continue;
    assert.equal(bytes.length, 128);
    events.push({
      market: new PublicKey(bytes.subarray(8, 40)).toBase58(),
      supplier: new PublicKey(bytes.subarray(40, 72)).toBase58(),
      mint: new PublicKey(bytes.subarray(72, 104)).toBase58(),
      shares: bytes.readBigUInt64LE(104),
      assets: bytes.readBigUInt64LE(112),
      remaining: bytes.readBigUInt64LE(120),
    });
  }
  return events;
}

/**
 * 使用独立测试账本验证已有出借份额的提取，可在首次出借后原位升级。
 * Verify withdrawals from existing supply shares on a disposable ledger, optionally upgrading after the initial supply.
 */
async function verifyWithdrawal() {
  /** 管理员密钥文件、仅本机 RPC 和可选升级产物；夹具路径仅供进一步前端测试。 Administrator key file, loopback RPC and optional upgraded ELF. The fixture path enables further browser QA. */
  const [adminFile, rpcUrl = 'http://127.0.0.1:8899', upgradedElf] = process.argv.slice(2);
  const browserFixtureFile = process.env.GGBOY_WITHDRAW_BROWSER_FIXTURE_FILE;
  assert.ok(adminFile, 'Usage: node withdraw-lending-supply.mjs <admin-keypair-file> [local-rpc-url] [upgraded-elf]');
  const endpoint = new URL(rpcUrl);
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Use an HTTP Localnet endpoint on localhost.');

  /** 使用新版本的公开 IDL 构造指令；旧版本只调用原有的初始化和出借。 Construct instructions from the new public IDL. Initialization and supply run on the old binary. */
  const idl = JSON.parse(await readFile(new URL('../target/idl/ggboy_lending.json', import.meta.url), 'utf8'));
  const programId = new PublicKey(idl.address);
  const rpc = new Connection(endpoint.href, commitment);
  const administrator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(adminFile, 'utf8'))));

  /**
   * 派生借贷程序的规范 PDA。
   * Derive a canonical lending-program PDA.
   * @param {string} seed 指令定义的字符串种子。 String seed defined by the instruction.
   * @param {...PublicKey} keys 顺序参与派生的公钥。 Public keys included in seed order.
   * @returns {PublicKey} 派生出的账户地址。 Derived account address.
   */
  function pda(seed, ...keys) {
    return PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map((key) => key.toBuffer())], programId)[0];
  }

  /** 被重复使用的市场、资产托管、份额和借款总账账户。 Market, asset custody, share and debt ledger accounts reused by the suite. */
  const market = pda('lending_market');
  const cash = pda('cash_vault', market);
  const collateral = pda('collateral_vault', market);
  const pool = pda('supply_pool', market);
  const debtBook = pda('borrow_market', market);
  const oracle = pda('mock_collateral_price', market);
  assert.deepEqual(await rpc.getMultipleAccountsInfo([market, cash, collateral, pool, debtBook, oracle]), Array(6).fill(null),
    'Start with a disposable Localnet ledger and an uninitialized GGBOY market.');

  /** 具有冻结权限的借款 Mint 用于验证实际 SPL CPI 失败，抵押 Mint 使用九位精度。 Freeze-enabled debt mint tests actual SPL CPI failure; collateral uses nine decimals. */
  const debtMint = await createMint(rpc, administrator, administrator.publicKey, administrator.publicKey, 6);
  const collateralMint = await createMint(rpc, administrator, administrator.publicKey, null, 9);
  const accounts = {
    market, lending_program: programId, program_data: PublicKey.findProgramAddressSync([programId.toBuffer()], loader)[0],
    debt_mint: debtMint, collateral_mint: collateralMint, cash_vault: cash, collateral_vault: collateral,
    supply_pool: pool, borrow_market: debtBook, mock_collateral_price: oracle,
    token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
  };

  /** 用不同计算单价区分同一区块内内容相同的交易，单位为微 Lamport。 Unique compute prices in micro-lamports distinguish otherwise identical transactions in one block. */
  let transactionCounter = 0;

  /**
   * 在本地账本真实执行一条测试指令并采集回执。
   * Execute a test instruction on the local ledger and collect the actual receipt.
   * @param {TransactionInstruction} instruction 业务指令或夹具操作。 Business instruction or fixture operation.
   * @param {Keypair} signer 业务授权人；管理员统一支付费用。 Signer authorizing the operation. The administrator pays fees.
   * @returns {Promise<object>} 签名和含执行结果的日志。 Signature and execution logs with status.
   */
  async function submit(instruction, signer) {
    /** 跳过预检使失败测试也真正执行，可从链上取证。 Skip preflight so failing cases execute and leave diagnostic records on-chain. */
    const lifetime = await rpc.getLatestBlockhash();
    const transaction = new Transaction({ ...lifetime, feePayer: administrator.publicKey }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: transactionCounter++ }), instruction,
    );
    transaction.sign(...(signer === administrator ? [administrator] : [administrator, signer]));
    const signature = await rpc.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const status = await rpc.confirmTransaction({ signature, ...lifetime }, commitment);
    const receipt = await rpc.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
    assert.ok(receipt?.meta?.logMessages, 'Missing transaction logs: ' + signature);
    assert.deepEqual(receipt.meta.err, status.value.err);
    return { signature, logs: receipt.meta.logMessages, error: receipt.meta.err };
  }

  /**
   * 按 IDL 顺序和权限构造真实程序指令，并传入本地签名者。
   * Construct a real program instruction using IDL account order and privileges, then submit with the local signer.
   * @param {string} name Anchor 指令名。 Anchor instruction name.
   * @param {bigint[]} args 对应资产或份额的 u64 最小单位参数。 u64 arguments in the relevant asset or share base units.
   * @param {Record<string, PublicKey>} specific 指令特有账户或负例覆盖地址。 Instruction-specific accounts or negative-case substitutions.
   * @param {Keypair} [signer] 业务签名人，缺省为测试管理员。 Business signer, defaults to the test administrator.
   * @returns {Promise<object>} 已执行的交易回执。 Executed transaction receipt.
   */
  function execute(name, args, specific, signer = administrator) {
    /** 独立校验判别符与参数类型，指令账户按 IDL 映射。 Check discriminator and argument types independently, then map accounts by IDL order. */
    const spec = idl.instructions.find((entry) => entry.name === name);
    assert.ok(spec, 'Missing instruction in generated IDL: ' + name);
    assert.deepEqual(Buffer.from(spec.discriminator), discriminator('global:' + name));
    assert.deepEqual(spec.args.map((arg) => arg.type), args.map(() => 'u64'));
    const data = Buffer.alloc(8 + args.length * 8);
    Buffer.from(spec.discriminator).copy(data);
    args.forEach((arg, index) => data.writeBigUInt64LE(arg, 8 + index * 8));
    const selected = { ...accounts, ...specific };
    const keys = spec.accounts.map(({ name: keyName, signer: isSigner, writable: isWritable }) => {
      /** 预期名称必须有真实交易账户公钥。 Every specified account name needs a real transaction public key. */
      const pubkey = selected[keyName];
      assert.ok(pubkey instanceof PublicKey, 'Missing account ' + keyName + ' for ' + name);
      return { pubkey, isSigner: !!isSigner, isWritable: !!isWritable };
    });
    return submit(new TransactionInstruction({ programId, keys, data }), signer);
  }

  /**
   * 创建本地临时签名钱包及其测试代币账户。
   * Create an ephemeral Localnet signer and test token accounts.
   * @param {bigint} startingDebt 以最小单位计的初始 mockUSDC 余额。 Initial mockUSDC balance in base units.
   * @returns {Promise<object>} 签名钱包、两类关联代币账户和仓位。 Signing wallet, both associated token accounts and positions.
   */
  async function createWallet(startingDebt) {
    /** 从本地管理员发放租金储备，测试钱包不会使用外部网络。 Local administrator funds rent balances; test wallets stay on Localnet. */
    const signer = Keypair.generate();
    const funded = await submit(SystemProgram.transfer({
      fromPubkey: administrator.publicKey, toPubkey: signer.publicKey, lamports: LAMPORTS_PER_SOL,
    }), administrator);
    assert.equal(funded.error, null, funded.logs.join('\n'));
    const debtAta = (await getOrCreateAssociatedTokenAccount(rpc, administrator, debtMint, signer.publicKey)).address;
    const collateralAta = (await getOrCreateAssociatedTokenAccount(rpc, administrator, collateralMint, signer.publicKey)).address;
    await mintTo(rpc, administrator, debtMint, debtAta, administrator, startingDebt);
    await mintTo(rpc, administrator, collateralMint, collateralAta, administrator, collateralUnit);
    return {
      signer, debtAta, collateralAta,
      shares: pda('supply_position', market, signer.publicKey),
      loan: pda('borrow_position', market, signer.publicKey),
    };
  }

  /** 关闭前总量为零的本地市场必须由当前升级权限人初始化。 The current upgrade authority initializes the market on the empty local ledger. */
  const opened = await execute('initialize_lending_market', [], { administrator: administrator.publicKey });
  assert.equal(opened.error, null, opened.logs.join('\n'));
  const supplier = await createWallet(200n * unit);
  const borrower = await createWallet(unit);
  const supplyAccounts = {
    supplier: supplier.signer.publicKey, source: supplier.debtAta, supply_position: supplier.shares,
  };
  const borrowAccounts = {
    borrower: borrower.signer.publicKey, borrow_position: borrower.loan,
    source: borrower.debtAta, destination: borrower.debtAta,
  };

  /** 用已有出借指令建立份额，升级不得重建原仓位。 Establish the position with the existing supply instruction and verify the same account survives the upgrade. */
  const supplied = await execute('supply', [100n * unit, 100n * unit], supplyAccounts, supplier.signer);
  assert.equal(supplied.error, null, supplied.logs.join('\n'));
  const watched = [
    market, cash, collateral, pool, debtBook, oracle, supplier.shares, borrower.loan,
    supplier.debtAta, borrower.debtAta, borrower.collateralAta, supplier.signer.publicKey, borrower.signer.publicKey,
  ];
  if (upgradedElf) {
    /** 对照旧版市场的全部资金和份额账户，包括尚未初始化的借款总账。 Preserve every existing fund/share account as well as the absent debt ledger. */
    const before = await rpc.getMultipleAccountsInfo(watched);
    try {
      await promisify(execFile)('solana', [
        '--url', endpoint.href, '--keypair', adminFile, '--commitment', 'finalized',
        'program', 'deploy', upgradedElf, '--program-id', programId.toBase58(), '--upgrade-authority', adminFile,
      ], { timeout: 180_000 });
    } catch (error) {
      // CLI 的缓冲区恢复提示可能包含本地密钥，只传递故障摘要。
      // CLI buffer recovery instructions can contain key material; pass through only the failure summary.
      throw new Error(error.stderr?.split('\n').findLast((line) => line.startsWith('Error: ')) ?? 'Localnet program upgrade failed.');
    }
    assert.deepEqual(await rpc.getMultipleAccountsInfo(watched), before);
    console.log('Same-address upgrade preserved existing shares, cash custody, and account bytes.');
  }

  /**
   * 确认池账面资产、总份额、该钱包份额、托管余额、钱包余额和未偿本金。
   * Assert accounted assets, total shares, wallet shares, custody balance, wallet balance and outstanding principal.
   * @param {bigint[]} values 依上方顺序提供六个以最小单位计的预期数值。 Six expected base-unit values in the listed order.
   */
  async function assertBalances(values) {
    /** 按链上布局直接读字段，验证公开状态与真实 SPL 代币变化。 Read fields by their on-chain layouts and verify public accounting against actual SPL balances. */
    const [poolInfo, supplierInfo, debtInfo] = await rpc.getMultipleAccountsInfo([pool, supplier.shares, debtBook]);
    assert.deepEqual([poolInfo?.owner.toBase58(), supplierInfo?.owner.toBase58()], [programId.toBase58(), programId.toBase58()]);
    assert.deepEqual(poolInfo.data.subarray(0, 8), discriminator('account:SupplyPool'));
    assert.deepEqual(supplierInfo.data.subarray(0, 8), discriminator('account:SupplyPosition'));
    const actual = [
      poolInfo.data.readBigUInt64LE(40), poolInfo.data.readBigUInt64LE(48), supplierInfo.data.readBigUInt64LE(72),
      (await getAccount(rpc, cash)).amount, (await getAccount(rpc, supplier.debtAta)).amount,
      debtInfo?.data.readBigUInt64LE(40) ?? 0n,
    ];
    assert.deepEqual(actual, values);
  }

  /**
   * 发送一笔提取，允许负例更换接收账户或签名人。
   * Submit a withdrawal, allowing negative tests to substitute the destination or signer.
   * @param {bigint} shares 要注销的六位份额最小单位。 Six-decimal share base units to burn.
   * @param {bigint} minimum 最少到账的六位 mockUSDC 最小单位。 Minimum six-decimal mockUSDC base units returned.
   * @param {Record<string, PublicKey>} [overrides] 覆盖指定真实 PDA 或代币账户。 Overrides for specific real PDA or token accounts.
   * @param {Keypair} [signer] 出借人或权限负例签名人。 Supplier or unauthorized test signer.
   * @returns {Promise<object>} 已提交的链上结果。 Submitted on-chain result.
   */
  function withdraw(shares, minimum, overrides, signer = supplier.signer) {
    return execute('withdraw_supply', [shares, minimum], {
      supplier: signer.publicKey, destination: supplier.debtAta, supply_position: supplier.shares, ...overrides,
    }, signer);
  }

  /**
   * 核对失败交易的错误和全量业务账户回滚。
   * Verify a failed transaction's error and rollback of all business accounts.
   * @param {() => Promise<object>} transaction 会失败的提取操作。 Withdrawal operation expected to fail.
   * @param {RegExp} reason 对应程序错误或 SPL Token 错误。 Expected program or SPL Token error.
   */
  async function reject(transaction, reason) {
    /** 同一组账户前后逐字节比对；手续费付款账户不计入资金回滚。 Compare the same account set byte for byte before/after, excluding the fee payer. */
    const before = await rpc.getMultipleAccountsInfo(watched);
    const receipt = await transaction();
    assert.equal(receipt.error?.InstructionError?.[0], 1, receipt.logs.join('\n'));
    assert.match(receipt.logs.join('\n'), reason);
    assert.deepEqual(withdrawalEvents(receipt.logs, programId), []);
    assert.deepEqual(await rpc.getMultipleAccountsInfo(watched), before);
  }

  /**
   * 核对实际成交回执中的全部提取字段。
   * Compare every supply withdrawal field in the actual successful transaction.
   * @param {bigint} shares 被注销的份额最小单位。 Burned share base units.
   * @param {bigint} assets 应转入钱包的 mockUSDC 最小单位。 Expected mockUSDC base units transferred to the wallet.
   * @param {bigint} remaining 本钱包剩余份额最小单位。 Remaining wallet share base units.
   */
  async function accept(shares, assets, remaining) {
    const receipt = await withdraw(shares, assets);
    assert.equal(receipt.error, null, receipt.logs.join('\n'));
    assert.deepEqual(withdrawalEvents(receipt.logs, programId), [{
      market: market.toBase58(), supplier: supplier.signer.publicKey.toBase58(), mint: debtMint.toBase58(),
      shares, assets, remaining,
    }]);
    console.log('Localnet withdrawal confirmed: ' + receipt.signature + ' (base units: ' + assets + ')');
  }

  // 校验零、超份额、最低到账及非持有人或错误接收账户。冻结账户触发真实代币转账 CPI 失败。
  // Check zero, oversize, minimum output, wrong signer and wrong destination. Frozen destinations make SPL transfer CPI fail.
  await reject(() => withdraw(0n, 1n), /InvalidSupplyWithdrawalShares/);
  await reject(() => withdraw(1n, 0n), /InvalidMinimumSupplyWithdrawal/);
  await reject(() => withdraw(100n * unit + 1n, 1n), /InsufficientSupplyShares/);
  await reject(() => withdraw(unit, unit + 1n), /MinimumSupplyWithdrawalNotMet/);
  await reject(() => withdraw(unit, unit, undefined, borrower.signer), /ConstraintSeeds|ConstraintTokenOwner|ConstraintHasOne/);
  await reject(() => withdraw(unit, unit, { destination: borrower.debtAta }), /ConstraintTokenOwner/);
  await reject(() => withdraw(unit, unit, { destination: supplier.collateralAta }), /ConstraintTokenMint/);
  await reject(() => withdraw(unit, unit, { borrow_market: borrower.debtAta }), /ConstraintSeeds/);
  await freezeAccount(rpc, administrator, supplier.debtAta, debtMint, administrator);
  await reject(() => withdraw(unit, unit), /Account is frozen|custom program error: 0x11/i);
  await thawAccount(rpc, administrator, supplier.debtAta, debtMint, administrator);

  // 历史只有出借仓位时可提取，不应为了提取创建市场借款总账。
  // Existing supply-only markets can withdraw without creating a debt ledger.
  assert.equal(await rpc.getAccountInfo(debtBook), null);
  await accept(25n * unit, 25n * unit, 75n * unit);
  assert.equal(await rpc.getAccountInfo(debtBook), null);
  await assertBalances([75n, 75n, 75n, 75n, 125n, 0n].map((value) => value * unit));

  /** 链上借出 60 个 mockUSDC，让账面可提额变为 15。 Borrow 60 mockUSDC on-chain, leaving 15 accounted units available to withdraw. */
  const posted = await execute('set_mock_collateral_price', [100n * unit], { administrator: administrator.publicKey });
  assert.equal(posted.error, null, posted.logs.join('\n'));
  const pledged = await execute('deposit_collateral', [collateralUnit], { ...borrowAccounts, source: borrower.collateralAta }, borrower.signer);
  assert.equal(pledged.error, null, pledged.logs.join('\n'));
  const borrowed = await execute('borrow', [60n * unit], borrowAccounts, borrower.signer);
  assert.equal(borrowed.error, null, borrowed.logs.join('\n'));
  await assertBalances([75n, 75n, 75n, 15n, 125n, 60n].map((value) => value * unit));
  await reject(() => withdraw(15n * unit + 1n, 1n), /InsufficientSupplyWithdrawalLiquidity/);

  // 直接赠送 7 个 mockUSDC 只增加托管现金，提取上限仍受未偿本金保护。
  // A direct donation of 7 mockUSDC increases custody only; outstanding principal still constrains withdrawals.
  const donated = await submit(createTransferCheckedInstruction(
    supplier.debtAta, debtMint, cash, supplier.signer.publicKey, 7n * unit, 6,
  ), supplier.signer);
  assert.equal(donated.error, null, donated.logs.join('\n'));
  await assertBalances([75n, 75n, 75n, 22n, 118n, 60n].map((value) => value * unit));
  await reject(() => withdraw(15n * unit + 1n, 1n), /InsufficientSupplyWithdrawalLiquidity/);
  await accept(15n * unit, 15n * unit, 60n * unit);
  await assertBalances([60n, 60n, 60n, 7n, 133n, 60n].map((value) => value * unit));
  await reject(() => withdraw(1n, 1n), /InsufficientSupplyWithdrawalLiquidity/);

  /** 借款人归还本金后，全额提取应注销所有旧份额并保留未记账赠款。 Repayment restores liquidity. A full withdrawal burns all original shares and leaves the unaccounted donation. */
  const repaid = await execute('repay', [60n * unit], borrowAccounts, borrower.signer);
  assert.equal(repaid.error, null, repaid.logs.join('\n'));
  await accept(60n * unit, 60n * unit, 0n);
  await assertBalances([0n, 0n, 0n, 7n, 193n, 0n].map((value) => value * unit));
  assert.equal((await getAccount(rpc, collateral)).amount, collateralUnit);
  console.log('Localnet supply withdrawal verified: partial, all, outstanding-principal limit, signed minimum, frozen transfer rollback, and account ownership.');

  if (browserFixtureFile) {
    // 仅保留特意生成的本地钱包做浏览器验证，文件不得覆盖且权限仅限所有人。
    // Keep only the disposable Localnet signer for browser QA, without overwriting and with owner-only permissions.
    const seeded = await execute('supply', [12n * unit, 12n * unit], supplyAccounts, supplier.signer);
    assert.equal(seeded.error, null, seeded.logs.join('\n'));
    await writeFile(browserFixtureFile, JSON.stringify(Array.from(supplier.signer.secretKey)), { mode: 0o600, flag: 'wx' });
    console.log('Localnet browser fixture: ' + JSON.stringify({
      rpcUrl: endpoint.href, market: market.toBase58(), debtMint: debtMint.toBase58(), collateralMint: collateralMint.toBase58(),
      wallet: supplier.signer.publicKey.toBase58(), keypairFile: browserFixtureFile, sharesRaw: '12000000',
    }));
  }
}

await verifyWithdrawal();

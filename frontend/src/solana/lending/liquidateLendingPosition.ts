import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, type VersionedTransactionResponse } from '@solana/web3.js';
import { Buffer } from 'buffer';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { devnetRpcUrl } from '../getDevnetSolBalance';
import { devnetLendingBorrowAddresses, devnetLendingPool, readDevnetBorrowAccounts, type LendingReadOptions } from './devnetLendingPool';
import { indexedDebtPayment, type LendingDebtShareQuote } from './lendingInterest';
import lendingIdl from './ggboyLendingIdl.json';

/** 通过环境变量开通已验证的测试部署。 Enable a verified test deployment through frontend environment settings. */
const environment = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
const liquidationsEnabled = environment.VITE_GGBOY_LIQUIDATION_ENABLED === 'true';

/** 与链上程序相同的整数参数及价格时效秒数。 Integer policy and price age in seconds matching the program. */
const basisPoints = 10_000n;
const liquidationThresholdBps = 8_000n;
const bonusBps = 500n;
const maxPriceAgeSeconds = 604_800n;
/** SPL 金额上限，以及读取、最终确认和轮询间隔的毫秒数。 SPL amount ceiling and millisecond request, finalization, and poll intervals. */
const maxU64 = (1n << 64n) - 1n;
const rpcTimeoutMs = 8_000;
const confirmationTimeoutMs = 120_000;
const pollIntervalMs = 2_500;

/** 清算报价及钱包余额来自同一个最终确认的 RPC 观测。 Liquidation quote and wallet balances come from the same finalized RPC observation. */
export interface LendingLiquidationQuote {
  /** 观测的最终确认 slot。 Finalized observation slot. */
  slot: number;
  /** 仓位、价格或健康度不足时的原因。 Reason when position, price, or health prevents liquidation. */
  status: 'ready' | 'priceUnavailable' | 'healthy' | 'noPosition';
  /** 依次为清算钱包可扣代币、未偿债务与最多可代偿量，按借款 Mint 最小单位。 Spendable wallet balance, debt, and repayment cap in debt mint base units. */
  debtBalanceRaw: bigint;
  debtRaw: bigint;
  maxRepayRaw: bigint;
  /** 当前锁定抵押品，单位为抵押 Mint 最小单位。 Locked collateral, in collateral mint base units. */
  collateralRaw: bigint;
  /** 每整单位抵押品的借款最小单位报价，不可用时为空。 Debt mint base units per whole collateral unit, or null when unavailable. */
  oraclePriceRaw: bigint | null;
  /** 抵押最小单位换算为整单位的十进制倍率。 Collateral mint base units in one whole token. */
  collateralScale: bigint;
  /** 清算钱包的抵押品接收账户是否被冻结。 Whether the liquidator collateral ATA is frozen. */
  destinationFrozen: boolean;
  /** 计息市场的聚合及个人归一化债务份额，用于计算实际代偿。 Aggregate and wallet normalized debt shares for calculating the actual repayment on an indexed market. */
  debtShareQuote: LendingDebtShareQuote | null;
}

/** 一笔交易绑定一个市场和两个公开钱包。 Each transaction belongs to one market and two public wallets. */
interface LiquidationContext {
  /** 目录中的程序、市场和两种资产精度。 Program, market, and both mint precisions from the registry. */
  market: LendingMarketListItem;
  /** 被清算仓位的借款人公钥。 Public key of the borrower being liquidated. */
  borrowerAddress: string;
  /** 提供代偿并签名的清算钱包。 Liquidator paying and signing. */
  walletAddress: string;
}

/** 用户核对后交给钱包签名的最小单位参数。 Reviewed base-unit amounts passed to the wallet for signing. */
export interface LendingLiquidationRequest extends LiquidationContext {
  /** 借款 Mint 的代偿最小单位数。 Repayment in debt mint base units. */
  repayRaw: bigint;
  /** 抵押品到账最低数量，以抵押 Mint 最小单位。 Minimum receipt in collateral mint base units. */
  minCollateralRaw: bigint;
}

/** 用于跟踪原签名的区块哈希有效高度及观测下限。 Blockhash validity height and observation floor for the original signature. */
export interface LendingLiquidationLifetime {
  /** 最后有效区块高度。 Last valid block height. */
  lastValidBlockHeight: number;
  /** 无签名模拟的确认 slot。 Confirmed slot of unsigned simulation. */
  minContextSlot: number;
}

/** 匹配原指令和事件后的实际成交。 Actual settlement matched against the reviewed instruction and event. */
export interface LendingLiquidationReceipt {
  /** 最终确认 slot 及供活动回执定位的事件原始日志行号。 Finalized slot and raw log index identifying the activity receipt. */
  slot: number;
  eventIndex: number;
  /** 实际代偿和核销金额，按借款 Mint 最小单位。 Actual repayment and write-off in debt mint base units. */
  repaidRaw: bigint;
  badDebtRaw: bigint;
  /** 实际收取抵押品，按抵押 Mint 最小单位。 Actual receipt in collateral mint base units. */
  seizedCollateralRaw: bigint;
}

/** 将超时和链上已确定失败分开的稳定错误码。 Stable errors distinguishing timeouts from definitive on-chain failure. */
type LiquidationErrorCode = 'unsupportedMarket' | 'quoteChanged' | 'preparationFailed' | 'insufficientSol' |
  'transactionFailed' | 'expired' | 'confirmationUnknown' | 'receiptUnavailable';

/** 将底层错误保留为原因，以稳定键提供界面文案。 Preserve underlying failures as causes and give the UI actionable keys. */
export class LendingLiquidationError extends Error {
  /** 记录可处理的错误码及原始错误。 Capture an actionable error type and its cause. */
  constructor(readonly code: LiquidationErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = 'LendingLiquidationError';
  }
}

/** 只对显式开通且与程序 IDL 对应的测试市场发起交易。 Transact only on an explicitly enabled test market matching the program IDL. */
export function isLiquidationMarketSupported(market: LendingMarketListItem): boolean {
  return liquidationsEnabled && lendingIdl.instructions.some((entry) => entry.name === 'liquidate') &&
    market.programId === lendingIdl.address &&
    market.programId === devnetLendingPool.programId && market.address === devnetLendingPool.marketAddress &&
    (market.network === 'devnet' || market.network === 'localnet');
}

/** 为读取、模拟和钱包超时检查选择相同网络的 RPC。 Use the same network endpoint for reads, simulation, and wallet expiry. */
export function lendingLiquidationRpcUrl(market: Pick<LendingMarketListItem, 'network'>): string {
  return market.network === 'devnet' ? devnetRpcUrl : environment.VITE_SOLANA_LOCALNET_RPC_URL || 'http://127.0.0.1:8899';
}

/** 建立受请求超时和可选整体取消约束的网络连接。 Connect with a per-request timeout and optional overall cancellation. */
function makeConnection(market: LendingMarketListItem, signal?: AbortSignal): Connection {
  return new Connection(lendingLiquidationRpcUrl(market), {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (input, init) => {
      /** 单次 HTTP 请求的独立取消信号。 Independent cancellation signal for each HTTP request. */
      const timeout = AbortSignal.timeout(rpcTimeoutMs);
      return fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    },
  });
}

/**
 * 从同槽的清算钱包、借款仓位和预言机数据按整数公式计算代偿上限。
 * Get the repayment cap from same-slot liquidator, position, and oracle data using exact integers.
 *
 * @param context 已登记市场及两方钱包公钥。 Registered market and both public wallet keys.
 * @param options 可选的取消信号和最低观测 slot。 Optional cancellation signal and observation slot floor.
 */
export async function readLendingLiquidationQuote(
  { market, borrowerAddress, walletAddress }: LiquidationContext,
  options: Pick<LendingReadOptions, 'signal' | 'minContextSlot'> = {},
): Promise<LendingLiquidationQuote> {
  if (!isLiquidationMarketSupported(market)) throw new LendingLiquidationError('unsupportedMarket');

  /** 所有风险字段和清算账户来自同一个最终确认 slot。 All risk fields and liquidator accounts come from one finalized slot. */
  const accounts = await readDevnetBorrowAccounts(market, borrowerAddress, {
    ...options, rpcUrl: lendingLiquidationRpcUrl(market), actorWalletAddress: walletAddress,
  });
  const { slot, debtRaw, collateralRaw, priceRaw, pricePublishedAt, chainUnixTimestamp, debtShareQuote } = accounts;
  const debtBalanceRaw = accounts.actorDebtBalanceRaw ?? 0n;
  const destinationFrozen = accounts.actorCollateralAccountFrozen === true;
  const collateralScale = 10n ** BigInt(market.collateralAsset.decimals);
  const freshPrice = priceRaw !== null && priceRaw > 0n && pricePublishedAt !== null && pricePublishedAt > 0n &&
    pricePublishedAt <= chainUnixTimestamp && chainUnixTimestamp - pricePublishedAt <= maxPriceAgeSeconds ? priceRaw : null;

  /** 缺少有效报价时仍可展示已查到的链上余额。 Keep observed balances visible when no valid quote can be calculated. */
  const common = { slot, debtRaw, collateralRaw, debtBalanceRaw, destinationFrozen, collateralScale, oraclePriceRaw: freshPrice, debtShareQuote };
  if (!accounts.positionExists || debtRaw === 0n) return { ...common, status: 'noPosition', maxRepayRaw: 0n };
  if (freshPrice === null) return { ...common, status: 'priceUnavailable', maxRepayRaw: 0n };

  /** 先用全精度检查健康度，再按债务、抵押和清算人余额限制代偿金额。 Check health at full precision, then cap repayment by debt, collateral, and wallet balance. */
  const collateralValueNumerator = collateralRaw * freshPrice;
  if (debtRaw * collateralScale * basisPoints <= collateralValueNumerator * liquidationThresholdBps) {
    return { ...common, status: 'healthy', maxRepayRaw: 0n };
  }
  const closeCap = (debtRaw + 1n) / 2n;
  const collateralCap = collateralValueNumerator * basisPoints / (collateralScale * (basisPoints + bonusBps));
  const maxRepayRaw = destinationFrozen ? 0n : [closeCap, collateralCap, debtBalanceRaw].reduce((left, right) => left < right ? left : right);
  return { ...common, status: 'ready', maxRepayRaw };
}

/** 使用清算奖励和价格计算预计可收抵押最小单位数，向下取整。 Estimate received collateral in base units from the bonus and price, rounded down. */
export function quoteLendingLiquidation(quote: LendingLiquidationQuote, repayRaw: bigint): bigint | null {
  if (quote.status !== 'ready' || quote.oraclePriceRaw === null || repayRaw <= 0n || repayRaw > quote.maxRepayRaw) return null;
  /** 计息池用当前时间点的市场实际债务差计算抵押到账，签名参数仍是代偿上限。 Indexed pools use the actual aggregate debt decrease for collateral; the signature still authorizes a maximum repayment. */
  const repaid = quote.debtShareQuote ? indexedDebtPayment(quote.debtShareQuote, repayRaw).amountRaw : repayRaw;
  /** 保留中间乘积的精度，仅在最后一次除法舍入。 Preserve the intermediate product and round only on the final divide. */
  const collateral = repaid * (basisPoints + bonusBps) * quote.collateralScale / (basisPoints * quote.oraclePriceRaw);
  return collateral > 0n && collateral <= quote.collateralRaw && collateral <= maxU64 ? collateral : null;
}

/**
 * 按 IDL 顺序和权限构建清算指令，并准备接收抵押品的 ATA。
 * Build the liquidation instruction in IDL order and prepare the collateral receiving ATA.
 *
 * @param request 已核对的金额、市场和钱包。 Reviewed amounts, market, and wallets.
 */
function buildLiquidation(request: LendingLiquidationRequest) {
  const { market, borrowerAddress, walletAddress, repayRaw, minCollateralRaw } = request;
  if (!isLiquidationMarketSupported(market) || repayRaw <= 0n || repayRaw > maxU64 ||
      minCollateralRaw <= 0n || minCollateralRaw > maxU64) throw new LendingLiquidationError('unsupportedMarket');

  /** 固定程序 ID 下的市场、风险、借款仓位和托管 PDA。 Market, risk, borrowing position, and custody PDAs under the fixed program ID. */
  const addresses = devnetLendingBorrowAddresses(borrowerAddress);
  const liquidator = new PublicKey(walletAddress);
  const debtMint = new PublicKey(market.debtAsset.mint);
  const collateralMint = new PublicKey(market.collateralAsset.mint);
  const liquidatorCollateral = getAssociatedTokenAddressSync(collateralMint, liquidator);
  /** 名称与 Anchor 的清算指令一致，允许通过生成的 IDL 校验顺序和 flags。 Match Anchor account names so the generated IDL governs ordering and flags. */
  const accounts: Record<string, PublicKey> = {
    liquidator,
    market: addresses.marketAddress,
    debt_mint: debtMint,
    collateral_mint: collateralMint,
    cash_vault: addresses.cashVault,
    collateral_vault: addresses.collateralVault,
    liquidator_debt: getAssociatedTokenAddressSync(debtMint, liquidator),
    liquidator_collateral: liquidatorCollateral,
    supply_pool: addresses.supplyPool,
    borrow_market: addresses.borrowMarket,
    borrow_position: addresses.borrowPosition,
    mock_collateral_price: addresses.mockCollateralPrice,
    token_program: TOKEN_PROGRAM_ID,
  };
  const definition = lendingIdl.instructions.find((entry) => entry.name === 'liquidate');
  if (!definition || definition.accounts.length !== Object.keys(accounts).length) {
    throw new LendingLiquidationError('unsupportedMarket');
  }

  /** Anchor discriminator 后依次编码最大的代偿量和最低抵押到账量，均为小端 u64。 Encode the maximum repayment and minimum collateral as LE u64 after the Anchor discriminator. */
  const data = Buffer.alloc(24);
  Buffer.from(definition.discriminator).copy(data);
  data.writeBigUInt64LE(repayRaw, 8);
  data.writeBigUInt64LE(minCollateralRaw, 16);
  const instruction = new TransactionInstruction({
    programId: addresses.programId,
    data,
    keys: definition.accounts.map((entry) => {
      const pubkey = accounts[entry.name];
      if (!pubkey) throw new LendingLiquidationError('unsupportedMarket');
      return { pubkey, isSigner: 'signer' in entry && Boolean(entry.signer), isWritable: 'writable' in entry && Boolean(entry.writable) };
    }),
  });

  /** ATA 已存在时设置指令无副作用。不存在时在同一笔清算交易内创建。 ATA setup is idempotent and creates a missing destination in the liquidation transaction. */
  const setup = createAssociatedTokenAccountIdempotentInstruction(liquidator, liquidatorCollateral, liquidator, collateralMint);
  return { liquidator, instruction, setup, borrower: addresses.borrower, debtMint, collateralMint };
}

/**
 * 在钱包签名之前重新读取报价并模拟同一笔交易。
 * Re-read the quote and simulate the same transaction before requesting a wallet signature.
 *
 * @param request 已核对的用户输入和两个钱包公钥。 Reviewed amounts and both wallet keys.
 * @param quoteSlot 初始报价所用最终确认 slot。 Finalized slot of the reviewed quote.
 * @param signal 当前市场或钱包切换时取消。 Can cancel after changing market or wallet.
 */
export async function prepareLendingLiquidation(request: LendingLiquidationRequest, quoteSlot: number, signal?: AbortSignal) {
  try {
    const { liquidator, setup, instruction } = buildLiquidation(request);
    /** 重新观测时不能降级到用户核对的报价 slot 之前。 The refreshed observation must be at or after the reviewed quote. */
    const quote = await readLendingLiquidationQuote(request, { minContextSlot: quoteSlot, signal });
    const collateral = quoteLendingLiquidation(quote, request.repayRaw);
    if (collateral === null || collateral < request.minCollateralRaw) throw new LendingLiquidationError('quoteChanged');

    const connection = makeConnection(request.market, signal);
    const { context, value } = await connection.getLatestBlockhashAndContext({ commitment: 'confirmed', minContextSlot: quote.slot });
    if (!Number.isSafeInteger(context.slot) || context.slot < quote.slot ||
        !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight < 1) {
      throw new LendingLiquidationError('preparationFailed');
    }

    /** 用相同的指令和账户做无签名模拟，留存 slot 与有效高度用于追踪同一签名。 Simulate identical instructions without signatures and retain the slot and block height for tracking the same signature. */
    const transaction = new Transaction({ ...value, feePayer: liquidator }).add(setup, instruction);
    const simulation = await connection.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {
      commitment: 'confirmed', minContextSlot: context.slot, sigVerify: false,
    });
    if (!Number.isSafeInteger(simulation.context.slot) || simulation.context.slot < context.slot) {
      throw new LendingLiquidationError('preparationFailed');
    }
    const error = simulation.value.err;
    if (error) {
      if (error === 'InsufficientFundsForFee' ||
          (typeof error === 'object' && 'InsufficientFundsForRent' in error) ||
          simulation.value.logs?.some((line) => /insufficient lamports/i.test(line))) {
        throw new LendingLiquidationError('insufficientSol', error);
      }
      throw new LendingLiquidationError('preparationFailed', error);
    }
    return { transaction, minContextSlot: simulation.context.slot, lastValidBlockHeight: value.lastValidBlockHeight };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LendingLiquidationError) throw error;
    throw new LendingLiquidationError('preparationFailed', error);
  }
}

/** 核对最终确认交易的签名人、程序、参数及原始日志。 Verify the signer, program, arguments, and raw logs of a finalized transaction. */
function readLiquidationReceipt(
  result: VersionedTransactionResponse,
  signature: string,
  request: LendingLiquidationRequest,
  lifetime: LendingLiquidationLifetime,
  operation: ReturnType<typeof buildLiquidation>,
): LendingLiquidationReceipt {
  if (!Number.isSafeInteger(result.slot) || result.slot < lifetime.minContextSlot ||
      result.transaction.signatures[0] !== signature || !result.meta) throw new LendingLiquidationError('receiptUnavailable');
  if (result.meta.err) throw new LendingLiquidationError('transactionFailed', result.meta.err);

  const { instruction, borrower, liquidator, debtMint, collateralMint } = operation;
  const message = result.transaction.message;
  const keys = message.getAccountKeys({ accountKeysFromLookups: result.meta.loadedAddresses });
  /** 钱包可以追加优先费设置，借贷程序的顶层指令必须唯一且与送签指令完全匹配。 Allow wallet-added priority fee setup and require exactly one top-level lending instruction matching the signed request. */
  const matching = message.compiledInstructions.filter((entry) => keys.get(entry.programIdIndex)?.equals(instruction.programId));
  const [executed] = matching;
  if (matching.length !== 1 || !keys.get(0)?.equals(liquidator) ||
      !Buffer.from(executed.data).equals(instruction.data) || executed.accountKeyIndexes.length !== instruction.keys.length ||
      !executed.accountKeyIndexes.every((index, offset) => keys.get(index)?.equals(instruction.keys[offset].pubkey))) {
    throw new LendingLiquidationError('receiptUnavailable');
  }

  const eventDefinition = lendingIdl.events.find((entry) => entry.name === 'LendingLiquidation');
  if (!eventDefinition) throw new LendingLiquidationError('receiptUnavailable');
  const discriminator = Buffer.from(eventDefinition.discriminator);
  const addresses = [new PublicKey(request.market.address), borrower, liquidator, debtMint, collateralMint];
  const programAddress = instruction.programId.toBase58();
  /** 原始 Solana 日志位置作为活动记录中的事件序号。 The raw Solana log position is the activity record's event index. */
  const logs = result.meta.logMessages;
  if (!logs?.length) throw new LendingLiquidationError('receiptUnavailable');
  const stack: string[] = [];
  let receipt: LendingLiquidationReceipt | null = null;

  for (const [eventIndex, log] of logs.entries()) {
    const invoked = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(log);
    if (invoked) {
      if (Number(invoked[2]) !== stack.length + 1) throw new LendingLiquidationError('receiptUnavailable');
      stack.push(invoked[1]);
      continue;
    }
    const exited = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed: .*)$/.exec(log);
    if (exited) {
      if (stack.pop() !== exited[1]) throw new LendingLiquidationError('receiptUnavailable');
      continue;
    }
    if (log === 'Log truncated') throw new LendingLiquidationError('receiptUnavailable');
    if (stack.length !== 1 || stack[0] !== programAddress || !log.startsWith('Program data: ')) continue;

    /** 事件由 8 字节前缀、五个公钥和三个 u64 组成，确认金额以实际事件为准。 The event contains an eight-byte prefix, five keys, and three u64 values. Settlement amounts come from the matching event. */
    const data = Buffer.from(log.slice(14), 'base64');
    if (!data.subarray(0, 8).equals(discriminator)) continue;
    if (receipt || data.length !== 192 || !addresses.every((address, index) => {
      const offset = 8 + index * 32;
      return data.subarray(offset, offset + 32).equals(address.toBuffer());
    })) throw new LendingLiquidationError('receiptUnavailable');

    const repaidRaw = data.readBigUInt64LE(168);
    const seizedCollateralRaw = data.readBigUInt64LE(176);
    const badDebtRaw = data.readBigUInt64LE(184);
    // 计息后的整数舍入允许小于签名上限的代偿，抵押到账必须达到签名下限。
    // Interest rounding may repay less than the signed cap, while collateral receipt must reach the signed floor.
    if (repaidRaw <= 0n || repaidRaw > request.repayRaw || seizedCollateralRaw < request.minCollateralRaw) {
      throw new LendingLiquidationError('receiptUnavailable');
    }
    receipt = { slot: result.slot, eventIndex, repaidRaw, seizedCollateralRaw, badDebtRaw };
  }

  if (!receipt || stack.length) throw new LendingLiquidationError('receiptUnavailable');
  return receipt;
}

/** 等到下一次 RPC 轮询，取消时立即清理。 Wait for the next RPC poll, cleaning up immediately on cancellation. */
function delayPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    /** 等待完成后移除计时器和取消监听器。 Remove the timer and abort listener when the wait ends. */
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    const timer = setTimeout(finish, pollIntervalMs);
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 查询原始签名，核实最终确认交易的实际清算金额。
 * Follow the original signature and verify the actual settlement of a finalized transaction.
 *
 * @param signature 用户钱包回传的原始交易签名。 Original signature returned by the wallet.
 * @param request 此签名对应的市场、账户和金额。 Market, accounts, and amounts reviewed for this signature.
 * @param lifetime 提交交易时的模拟 slot 和最后有效区块高度。 Simulated slot and last valid block height when submitted.
 * @param signal 页面或钱包切换时取消本轮查询。 Cancel this lookup on page or wallet change.
 */
export async function waitForLendingLiquidation(
  signature: string,
  request: LendingLiquidationRequest,
  lifetime: LendingLiquidationLifetime,
  signal?: AbortSignal,
): Promise<LendingLiquidationReceipt> {
  /** 超时只结束当前查询，调用方保留签名供后续确认。 The deadline only ends this lookup, preserving the original signature for a later check. */
  const deadline = AbortSignal.timeout(confirmationTimeoutMs);
  const lookup = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const connection = makeConnection(request.market, lookup);
  const operation = buildLiquidation(request);
  const config = { commitment: 'finalized', maxSupportedTransactionVersion: 0 } as const;
  let finalized = false;
  let lastError: unknown;

  while (!lookup.aborted) {
    try {
      const result = await connection.getTransaction(signature, config);
      lookup.throwIfAborted();
      if (result) return readLiquidationReceipt(result, signature, request, lifetime, operation);

      if (!finalized) {
        const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const [status] = statuses.value;
        if (status?.confirmationStatus === 'finalized') {
          if (status.err) throw new LendingLiquidationError('transactionFailed', status.err);
          finalized = true;
        } else if (!status && statuses.context.slot >= lifetime.minContextSlot &&
            await connection.getBlockHeight({ commitment: 'finalized', minContextSlot: lifetime.minContextSlot }) > lifetime.lastValidBlockHeight) {
          // 到期后同时重查历史签名和完整交易，防止将索引延迟误判为失败。
          // Recheck signature history and full transaction at expiry to avoid treating lagging indexes as failure.
          const recheck = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
          if (recheck.context.slot >= statuses.context.slot && recheck.value[0] === null) {
            const history = await connection.getTransaction(signature, config);
            lookup.throwIfAborted();
            if (history) return readLiquidationReceipt(history, signature, request, lifetime, operation);
            throw new LendingLiquidationError('expired');
          }
        }
      }
    } catch (error) {
      if (error instanceof LendingLiquidationError) throw error;
      lastError = error;
    }
    await delayPoll(lookup);
  }

  signal?.throwIfAborted();
  throw new LendingLiquidationError(finalized ? 'receiptUnavailable' : 'confirmationUnknown', lastError);
}

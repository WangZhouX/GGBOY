import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type TransactionError,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { devnetRpcUrl } from '../getDevnetSolBalance';
import {
  devnetLendingBorrowAddresses,
  devnetLendingPool,
  devnetLendingSupplyAddresses,
  readDevnetLendingSupply,
  type DevnetLendingSupply,
} from './devnetLendingPool';
import lendingIdl from './ggboyLendingIdl.json';
import { getSupplyWithdrawalLimit, valueSupplyShares } from './supplyWithdrawalAmounts';

/** 入池和提取共用账户校验及交易确认，链上指令分别编码。 Supply and withdrawal share account validation and confirmation but encode separate instructions. */
export type LendingSupplyAction = 'deposit' | 'withdraw';

/** 用户核对的业务操作、市场、签名钱包和两项整数参数。 Reviewed action, market, signer, and two exact integer parameters. */
interface LendingSupplyRequest {
  /** 决定哪一项是实际输入，哪一项是最低到账。 Selects which quantity is exact input and which is minimum output. */
  action: LendingSupplyAction;
  /** 当前 Devnet 借贷市场及其已登记的资产。 Selected Devnet lending market and its registered assets. */
  market: Pick<LendingMarketListItem, 'address' | 'network' | 'programId' | 'debtAsset' | 'collateralAsset'>;
  /** 本次操作的 Phantom 钱包公钥。 Phantom wallet address responsible for this action. */
  walletAddress: string;
  /** 入池时是存入代币量，提取时是最低到账代币量，按借款 Mint 最小单位计。 Exact deposit or minimum withdrawal payout, in debt mint base units. */
  assetsRaw: bigint;
  /** 入池时是最低份额，提取时是扣减份额，按份额最小单位计。 Minimum issued shares or exact burned shares, in share base units. */
  sharesRaw: bigint;
}

/** 当前报价对应的最低链上观测 slot。 Minimum on-chain observation slot for the reviewed quote. */
interface PrepareLendingSupplyRequest extends LendingSupplyRequest {
  /** 用户核对金额时读到的钱包仓位 slot。 Wallet position slot used when reviewing the amount. */
  minContextSlot: number;
}

/** 确认交易和重查签名所需的公开有效期信息。 Public lifetime data needed to confirm or recheck the signature. */
export interface LendingSupplyLifetime {
  /** 交易使用的 blockhash 可被处理的最后区块高度。 Last block height at which the transaction blockhash is valid. */
  lastValidBlockHeight: number;
  /** 提交 RPC 必须达到的模拟 slot。 Simulation slot the submission RPC must have reached. */
  minContextSlot: number;
}

/** 交给 Phantom 签名的交易，含后续确认所需的有效期。 Transaction for Phantom to sign, with its confirmation lifetime. */
export interface PreparedLendingSupply extends LendingSupplyLifetime {
  /** 通过无签名模拟的交易。 Transaction that passed unsigned simulation. */
  transaction: Transaction;
  /** RPC 提供并写入交易的 Base58 区块哈希。 Base58 blockhash supplied by RPC and stored in the transaction. */
  blockhash: string;
}

/** 从最终确认的出借或提取事件读取的实际结果。 Actual result from one finalized deposit or withdrawal event. */
export interface LendingSupplyReceipt {
  /** 交易执行 slot，也是仓位刷新的最低 slot。 Transaction slot, also the minimum slot for refreshing the position. */
  slot: number;
  /** 池与钱包之间实际转移的借款资产最小单位数。 Actual debt mint base units transferred between the pool and wallet. */
  assetsRaw: bigint;
  /** 此笔实际新增或扣减的出借份额最小单位数。 Actual supply share base units issued or burned in this transaction. */
  sharesRaw: bigint;
}

/** 用于页面本地化和区分确认状态的出借错误码。 Supply error codes for localization and confirmation handling. */
export type LendingSupplyErrorCode =
  | 'invalidAmount'
  | 'unsupportedMarket'
  | 'insufficientAsset'
  | 'insufficientShares'
  | 'insufficientLiquidity'
  | 'frozenDestination'
  | 'zeroWithdrawal'
  | 'insufficientSol'
  | 'quoteChanged'
  | 'preparationFailed'
  | 'transactionFailed'
  | 'expired'
  | 'confirmationUnknown'
  | 'receiptUnavailable';

/** 对界面提供稳定的错误码，保留原始错误辅助诊断。 Provide a stable UI error code with the original error for diagnostics. */
export class LendingSupplyError extends Error {
  /** 构造可本地化的出借错误。 Construct a localizable supply error. */
  constructor(
    /** 界面文案和重试流程使用的分类。 Category used by UI messages and retry flow. */
    readonly code: LendingSupplyErrorCode,
    /** 可选的底层错误。 Optional underlying error. */
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = 'LendingSupplyError';
  }
}

/** 链上出借参数和余额使用的无符号 64 位整数上限。 Maximum unsigned 64-bit amount for on-chain inputs and balances. */
const maxTokenAmount = (1n << 64n) - 1n;
/** 单个 RPC 请求、单次确认流程及两次轮询之间的毫秒限制。 Millisecond limits for one RPC call, one confirmation attempt, and the polling interval. */
const rpcTimeoutMs = 8_000;
const confirmationTimeoutMs = 120_000;
const confirmationPollMs = 2_500;
/** 指令和事件的公开 Anchor IDL 名称。 Public Anchor IDL names for each instruction and event. */
const supplyIdlNames = {
  deposit: { instruction: 'supply', event: 'LendingSupply' },
  withdraw: { instruction: 'withdraw_supply', event: 'LendingSupplyWithdrawal' },
} as const;

/**
 * 验证指令的正整数最小单位金额。
 * Validate a positive base-unit amount for an instruction.
 *
 * @param amountRaw 待检查的出借金额或份额。 Supply amount or shares to validate.
 */
function validateAmount(amountRaw: bigint): void {
  if (amountRaw <= 0n || amountRaw > maxTokenAmount) throw new LendingSupplyError('invalidAmount');
}

/**
 * 按链上定价计算出借实际可得的估算份额，并校验钱包余额与池记账。
 * Estimate shares using on-chain pricing and validate the wallet balance and pool accounting.
 *
 * @param position 钱包、现金和池记账在同一最终确认 slot 的观测。 Wallet, cash, and pool accounting observed at one finalized slot.
 * @param assetsRaw 待出借金额，按借款资产最小单位计。 Supply amount in debt asset base units.
 * @returns 向下舍入至份额最小单位的预估值。 Estimated output rounded down to a share base unit.
 */
export function quoteLendingSupply(position: DevnetLendingSupply, assetsRaw: bigint): bigint {
  validateAmount(assetsRaw);
  if (assetsRaw > position.walletAssetRaw) throw new LendingSupplyError('insufficientAsset');

  /** 按池的已记账资产定价，核对现金和含利息的未偿债务对出借账本的覆盖，以及份额上界。 Price from recorded assets and check the backing from cash plus indexed outstanding debt and the share bound. */
  const { accountedAssetsRaw, totalSharesRaw, cashRaw, totalDebtRaw, sharesRaw } = position;
  if ((accountedAssetsRaw === 0n) !== (totalSharesRaw === 0n) ||
      totalDebtRaw > accountedAssetsRaw || accountedAssetsRaw > cashRaw + totalDebtRaw || sharesRaw > totalSharesRaw) {
    throw new LendingSupplyError('quoteChanged');
  }

  /** 空池一比一。已有份额时，BigInt 整数除法与 Rust 一样向下舍入。 An empty pool quotes one-to-one. With existing shares, BigInt division rounds down like Rust. */
  const sharesOut = accountedAssetsRaw === 0n ? assetsRaw : assetsRaw * totalSharesRaw / accountedAssetsRaw;
  if (sharesOut === 0n || cashRaw + assetsRaw > maxTokenAmount ||
      accountedAssetsRaw + assetsRaw > maxTokenAmount || totalSharesRaw + sharesOut > maxTokenAmount) {
    throw new LendingSupplyError('quoteChanged');
  }
  return sharesOut;
}

/**
 * 按已验证仓位计算指定份额预计到账的借款代币，拒绝超额或零到账。
 * Quote debt tokens paid for the requested shares from a verified position, rejecting excess or zero output.
 *
 * @param position 钱包份额、现金和池账本的同槽观测。 Same-slot wallet shares, cash, and pool accounting.
 * @param sharesRaw 准备扣减的出借份额最小单位数。 Supply share base units to burn.
 * @returns 按链上规则向下取整的代币最小单位数。 Token base units rounded down per the on-chain rule.
 */
export function quoteLendingSupplyWithdrawal(position: DevnetLendingSupply, sharesRaw: bigint): bigint {
  validateAmount(sharesRaw);
  if (position.walletAssetFrozen) throw new LendingSupplyError('frozenDestination');
  if (sharesRaw > position.sharesRaw) throw new LendingSupplyError('insufficientShares');

  /** 当前可提取份额同时受到钱包归属和池内可付现金限制。 The withdrawal limit accounts for both wallet ownership and payable pool cash. */
  const assetsRaw = valueSupplyShares(position, sharesRaw);
  if (assetsRaw === 0n) throw new LendingSupplyError('zeroWithdrawal');
  if (sharesRaw > getSupplyWithdrawalLimit(position).sharesRaw) throw new LendingSupplyError('insufficientLiquidity');
  return assetsRaw;
}

/**
 * 创建绑定 Devnet 的连接，为每个 RPC 请求设置超时。
 * Create a Devnet connection with a timeout for each RPC request.
 *
 * @param signal 可选的整体取消信号。 Optional cancellation for the complete operation.
 */
function makeConnection(signal?: AbortSignal): Connection {
  return new Connection(devnetRpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (input, init) => {
      /** 整体取消也会终止正在执行的网络请求。 Overall cancellation also stops an in-flight network request. */
      const timeout = AbortSignal.timeout(rpcTimeoutMs);
      return fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    },
  });
}

/**
 * 从公开 IDL 和可复核地址编码本次入池或提取指令。
 * Encode this deposit or withdrawal from the public IDL and verifiable addresses.
 *
 * @param request 本次操作的市场、钱包、金额及最低到账。 Market, wallet, amounts, and minimum output for this operation.
 * @returns 使用钱包规范关联代币账户的借贷指令。 Lending instruction using the wallet's canonical associated token account.
 */
function buildSupplyInstruction(request: LendingSupplyRequest): TransactionInstruction {
  /** 仅支持前端已配置并与公开 IDL 相符的 Devnet 部署。 Support the configured Devnet deployment only when it matches the public IDL. */
  const { action, market, walletAddress, assetsRaw, sharesRaw } = request;
  const supplyInstruction = lendingIdl.instructions.find(({ name }) => name === supplyIdlNames[action].instruction);
  if (market.network !== 'devnet' || market.address !== devnetLendingPool.marketAddress ||
      market.programId !== devnetLendingPool.programId || market.programId !== lendingIdl.address || !supplyInstruction) {
    throw new LendingSupplyError('unsupportedMarket');
  }
  validateAmount(assetsRaw);
  validateAmount(sharesRaw);

  /** 池、仓位和现金托管 PDA 使用 Rust 程序的规范种子。 Pool, position, and custody PDAs use the same canonical seeds as the Rust program. */
  const { programId, marketAddress, cashVault, supplyPool, supplyPosition, supplier } = devnetLendingSupplyAddresses(walletAddress);
  const { borrowMarket } = devnetLendingBorrowAddresses(walletAddress);
  const debtMint = new PublicKey(market.debtAsset.mint);
  const walletAsset = getAssociatedTokenAddressSync(debtMint, supplier);
  /** IDL 的账户名对应本次交易的实际公钥。 Map IDL account names to the public keys for this transaction. */
  const addresses: Readonly<Record<string, PublicKey>> = {
    supplier,
    market: marketAddress,
    debt_mint: debtMint,
    cash_vault: cashVault,
    source: walletAsset,
    destination: walletAsset,
    supply_pool: supplyPool,
    supply_position: supplyPosition,
    borrow_market: borrowMarket,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  };

  /** Anchor 指令判别符之后为两个按 IDL 顺序排列的小端 u64。 The Anchor discriminator is followed by two little-endian u64 arguments in IDL order. */
  const data = Buffer.alloc(supplyInstruction.discriminator.length + 16);
  Buffer.from(supplyInstruction.discriminator).copy(data);
  /** 先编码精确输入，再编码最低到账，两种操作的代币与份额顺序相反。 Encode exact input before minimum output, reversing the assets/shares order for withdrawals. */
  data.writeBigUInt64LE(action === 'deposit' ? assetsRaw : sharesRaw, supplyInstruction.discriminator.length);
  data.writeBigUInt64LE(action === 'deposit' ? sharesRaw : assetsRaw, supplyInstruction.discriminator.length + 8);

  return new TransactionInstruction({
    programId,
    data,
    keys: supplyInstruction.accounts.map((account) => {
      /** 每个账户的顺序和权限均按 IDL 校验。 Respect the account order and permissions from the IDL. */
      const pubkey = addresses[account.name];
      if (!pubkey) throw new LendingSupplyError('preparationFailed');
      return {
        pubkey,
        isSigner: 'signer' in account && account.signer === true,
        isWritable: 'writable' in account && account.writable === true,
      };
    }),
  });
}

/**
 * 将未签名模拟的失败映射为页面可展示的错误。
 * Map unsigned simulation failures to errors the page can display.
 *
 * @param error 模拟响应中的执行错误。 Execution error from the simulation response.
 * @param logs 模拟期间写下的程序日志。 Program logs produced during simulation.
 * @param lendingInstructionIndex 借贷指令在交易中的序号。 Index of the lending instruction in the transaction.
 */
function getSimulationError(error: TransactionError, logs: string[] | null, lendingInstructionIndex: number): LendingSupplyError {
  // 首次出借可能创建 PDA 并支付免租余额，另加本次交易手续费。
  // A first supply can need rent-exempt funding for new PDAs in addition to the transaction fee.
  if (error === 'AccountNotFound' || error === 'InsufficientFundsForFee' ||
      (typeof error === 'object' && 'InsufficientFundsForRent' in error) ||
      logs?.some((line) => /insufficient lamports/i.test(line))) {
    return new LendingSupplyError('insufficientSol', error);
  }

  /** 仅解释唯一一条借贷指令的 Anchor 错误码。 Decode Anchor error codes only for the single lending instruction. */
  const instructionError = typeof error === 'object' && 'InstructionError' in error ? error.InstructionError : null;
  if (Array.isArray(instructionError) && instructionError[0] === lendingInstructionIndex) {
    /** 通过公开 IDL 找到程序错误名。 Resolve the program error name from the public IDL. */
    const detail = instructionError[1];
    const custom = detail && typeof detail === 'object' && 'Custom' in detail ? detail.Custom : null;
    const name = lendingIdl.errors.find((entry) => entry.code === custom)?.name;
    switch (name) {
      case 'InsufficientSupplyBalance':
        return new LendingSupplyError('insufficientAsset', error);
      case 'InsufficientSupplyShares':
        return new LendingSupplyError('insufficientShares', error);
      case 'InsufficientSupplyWithdrawalLiquidity':
        return new LendingSupplyError('insufficientLiquidity', error);
      case 'ZeroSupplyWithdrawalAssets':
        return new LendingSupplyError('zeroWithdrawal', error);
      case 'InvalidSupplyWithdrawalDestination':
        return new LendingSupplyError('frozenDestination', error);
      case 'InvalidBorrowAccounting':
      case 'MinimumSupplyWithdrawalNotMet':
      case 'InvalidSupplyAccounting':
      case 'SupplyOverflow':
      case 'ZeroSupplyShares':
      case 'MinimumSupplySharesNotMet':
        return new LendingSupplyError('quoteChanged', error);
    }
  }
  return new LendingSupplyError('preparationFailed', error);
}

/**
 * 按最新验证状态检查用户下限，构造并模拟交给 Phantom 的未签名交易。
 * Check the reviewed minimum against fresh validated state, then build and simulate the unsigned transaction for Phantom.
 *
 * @param request 市场、钱包、金额、用户份额下限和报价 slot。 Market, wallet, amount, reviewed share minimum, and quote slot.
 * @returns 未签名交易及签名提交和确认所需的有效期。 Unsigned transaction and lifetime for submission and confirmation.
 */
export async function prepareLendingSupply(request: PrepareLendingSupplyRequest): Promise<PreparedLendingSupply> {
  try {
    if (!Number.isSafeInteger(request.minContextSlot) || request.minContextSlot < 0) {
      throw new LendingSupplyError('preparationFailed');
    }

    /** 重新读取已最终确认的账户，避免将旧报价直接送给钱包。 Read finalized accounts again before sending a quote to the wallet. */
    const instruction = buildSupplyInstruction(request);
    const position = await readDevnetLendingSupply(request.market, request.walletAddress, { minContextSlot: request.minContextSlot });
    /** 重新验证余额、现金和用户在审核页接受的最低到账。 Recheck balances, liquidity, and the minimum output reviewed by the user. */
    const output = request.action === 'deposit'
      ? quoteLendingSupply(position, request.assetsRaw)
      : quoteLendingSupplyWithdrawal(position, request.sharesRaw);
    if (output < (request.action === 'deposit' ? request.sharesRaw : request.assetsRaw)) {
      throw new LendingSupplyError('quoteChanged');
    }

    /** 区块哈希与模拟都不能来自比新读到的仓位更早的 slot。 The blockhash and simulation must come from slots at least as new as the rechecked accounts. */
    const connection = makeConnection();
    const { context, value: lifetime } = await connection.getLatestBlockhashAndContext({
      commitment: 'confirmed',
      minContextSlot: position.slot,
    });
    if (!Number.isSafeInteger(context.slot) || context.slot < position.slot ||
        !Number.isSafeInteger(lifetime.lastValidBlockHeight) || lifetime.lastValidBlockHeight <= 0) {
      throw new LendingSupplyError('preparationFailed');
    }

    /** 包装 legacy 消息进行无签名模拟，真正的交易由 Phantom 同意后提交。 Wrap the legacy message for unsigned simulation, leaving actual submission to Phantom approval. */
    const supplier = new PublicKey(request.walletAddress);
    const transaction = new Transaction({ ...lifetime, feePayer: supplier });
    // 提取可原子重建已关闭的收款 ATA；已存在时不重复支付免租余额。
    // A withdrawal can atomically recreate a closed destination ATA without charging rent again if it exists.
    if (request.action === 'withdraw') {
      const mint = new PublicKey(request.market.debtAsset.mint);
      const destination = getAssociatedTokenAddressSync(mint, supplier);
      transaction.add(createAssociatedTokenAccountIdempotentInstruction(supplier, destination, supplier, mint));
    }
    transaction.add(instruction);
    const simulation = await connection.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {
      commitment: 'confirmed',
      minContextSlot: context.slot,
      sigVerify: false,
    });
    if (!Number.isSafeInteger(simulation.context.slot) || simulation.context.slot < context.slot) {
      throw new LendingSupplyError('preparationFailed');
    }
    if (simulation.value.err) throw getSimulationError(simulation.value.err, simulation.value.logs, transaction.instructions.length - 1);
    return { transaction, ...lifetime, minContextSlot: simulation.context.slot };
  } catch (error) {
    if (error instanceof LendingSupplyError) throw error;
    throw new LendingSupplyError('preparationFailed', error);
  }
}

/**
 * 从正确程序的顶层调用收集出借事件，忽略其他程序和所有 CPI 的数据。
 * Collect supply events only from the correct top-level invocation, ignoring data from other programs and CPIs.
 *
 * @param logs 已最终确认交易的程序日志。 Program logs of the finalized transaction.
 * @param programAddress 借贷程序公钥。 Lending program public key.
 * @param action 用于匹配本次操作对应的事件判别符。 Action used to choose the expected event discriminator.
 * @returns 按顺序找到的事件字节。 Event payloads in log order.
 */
function readSupplyEvents(logs: string[], programAddress: string, action: LendingSupplyAction): Buffer[] {
  /** 从公开 IDL 选择事件类型，防止把同笔交易中另一类出借操作当作回执。 Select the event from the public IDL so another operation cannot satisfy this receipt. */
  const supplyEvent = lendingIdl.events.find(({ name }) => name === supplyIdlNames[action].event);
  if (!supplyEvent) throw new LendingSupplyError('receiptUnavailable');

  /** 按运行时记录的进入和退出信息跟踪当前日志属于哪个程序。 Track the program writing a log by following runtime entry and exit records. */
  const callStack: string[] = [];
  const events: Buffer[] = [];
  const discriminator = Buffer.from(supplyEvent.discriminator);
  for (const line of logs) {
    /** 携带调用深度的进入记录，深度不连续表示日志无法完整验证。 Invocation marker with its call depth. A discontinuity prevents log verification. */
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invocation) {
      if (Number(invocation[2]) !== callStack.length + 1) throw new LendingSupplyError('receiptUnavailable');
      callStack.push(invocation[1]);
      continue;
    }

    /** 只有相同程序的退出记录才能关闭当前调用。 Only an exit from the same program can close the current invocation. */
    const completion = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/.exec(line);
    if (completion) {
      if (callStack.pop() !== completion[1]) throw new LendingSupplyError('receiptUnavailable');
      continue;
    }
    if (line === 'Log truncated') throw new LendingSupplyError('receiptUnavailable');
    if (callStack.length !== 1 || callStack[0] !== programAddress) continue;

    /** Anchor emit! 写入单段 Base64 数据，前缀为事件判别符。 Anchor emit! writes a single Base64 payload prefixed by the event discriminator. */
    const candidate = /^Program data: ([A-Za-z0-9+/]+={0,2})$/.exec(line);
    if (candidate) {
      /** 只有匹配出借事件判别符的 payload 才计数。 Count only payloads that carry the supply event discriminator. */
      const data = Buffer.from(candidate[1], 'base64');
      if (data.subarray(0, discriminator.length).equals(discriminator)) events.push(data);
    }
  }
  if (callStack.length !== 0) throw new LendingSupplyError('receiptUnavailable');
  return events;
}

/**
 * 核对最终确认的交易消息和出借事件，并读取这笔交易实际增加的份额。
 * Verify the finalized transaction message and supply event, then extract the shares actually credited by this transaction.
 *
 * @param result 最终确认的完整交易及执行结果。 Complete finalized transaction and execution metadata.
 * @param signature Phantom 提交后返回的 Base58 签名。 Base58 signature returned by Phantom.
 * @param instruction 按用户确认的参数重建的出借指令。 Supply instruction reconstructed from the reviewed inputs.
 * @param request 原始金额、最低份额和市场身份。 Original amount, minimum shares, and market identity.
 * @param lifetime 用户签名时使用的 RPC slot 下限。 RPC slot floor used for the signed transaction.
 */
function readReceipt(
  result: VersionedTransactionResponse,
  signature: string,
  instruction: TransactionInstruction,
  request: LendingSupplyRequest,
  lifetime: LendingSupplyLifetime,
): LendingSupplyReceipt {
  if (!Number.isSafeInteger(result.slot) || result.slot < lifetime.minContextSlot ||
      result.transaction.signatures[0] !== signature) {
    throw new LendingSupplyError('receiptUnavailable');
  }
  if (result.meta?.err) throw new LendingSupplyError('transactionFailed', result.meta.err);
  if (!result.meta?.logMessages) throw new LendingSupplyError('receiptUnavailable');

  /** 核对单笔出借的顶层指令与签名前构造的数据，允许钱包插入优先费指令。 Match the one top-level supply instruction to the prepared data, allowing a wallet to add priority-fee instructions. */
  const { message } = result.transaction;
  const keys = message.getAccountKeys({ accountKeysFromLookups: result.meta.loadedAddresses });
  const instructions = message.compiledInstructions.filter(({ programIdIndex }) => keys.get(programIdIndex)?.equals(instruction.programId));
  const [recorded] = instructions;
  if (instructions.length !== 1 || !keys.get(0)?.equals(instruction.keys[0].pubkey) ||
      !Buffer.from(recorded.data).equals(instruction.data) || recorded.accountKeyIndexes.length !== instruction.keys.length ||
      !recorded.accountKeyIndexes.every((index, offset) => keys.get(index)?.equals(instruction.keys[offset].pubkey))) {
    throw new LendingSupplyError('receiptUnavailable');
  }

  /** 两种事件都以三个公钥开始；提取事件按份额、到账、剩余份额编码三个 u64。 Both events begin with three public keys; withdrawal then encodes burned shares, payout, and remaining shares. */
  const withdrawing = request.action === 'withdraw';
  const events = readSupplyEvents(result.meta.logMessages, instruction.programId.toBase58(), request.action);
  const [data] = events;
  if (events.length !== 1 || data.length !== (withdrawing ? 128 : 120)) throw new LendingSupplyError('receiptUnavailable');
  const market = new PublicKey(data.subarray(8, 40));
  const supplier = new PublicKey(data.subarray(40, 72));
  const debtMint = new PublicKey(data.subarray(72, 104));
  const assetsRaw = data.readBigUInt64LE(withdrawing ? 112 : 104);
  const sharesRaw = data.readBigUInt64LE(withdrawing ? 104 : 112);
  /** 必须同时匹配精确输入与用户可接受的最低输出。 Match exact input and the user's minimum acceptable output. */
  const amountMatches = withdrawing
    ? sharesRaw === request.sharesRaw && assetsRaw >= request.assetsRaw
    : assetsRaw === request.assetsRaw && sharesRaw >= request.sharesRaw;
  if (market.toBase58() !== request.market.address || supplier.toBase58() !== request.walletAddress ||
      debtMint.toBase58() !== request.market.debtAsset.mint || !amountMatches) {
    throw new LendingSupplyError('receiptUnavailable');
  }
  return { slot: result.slot, assetsRaw, sharesRaw };
}

/**
 * 等待下一次轮询，取消时立即结束等待。
 * Wait for the next poll and finish immediately when canceled.
 *
 * @param signal 确认流程的整体取消信号。 Overall cancellation signal for confirmation.
 */
function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    /** 清理计时器和事件监听，结束本轮等待。 Clear the timer and listener and finish this wait. */
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }

    /** 相邻 RPC 轮询之间的计时器。 Timer between consecutive RPC polls. */
    const timer = setTimeout(finish, confirmationPollMs);
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 在最终确认后返回本笔出借的事件回执。超时后保留签名供继续核对。
 * Return the event receipt after finalization. A timeout retains the signature for rechecking.
 *
 * @param signature Phantom 已提交交易的 Base58 签名。 Base58 signature returned by Phantom for the submission.
 * @param request 用户签名前复核过的交易参数。 Transaction parameters reviewed by the user before signing.
 * @param lifetime 此次提交的确认 slot 下限与区块哈希有效期。 Submission slot floor and blockhash lifetime.
 * @param signal 切换钱包、市场或离开页面时的取消信号。 Cancellation when changing wallets, markets, or leaving the page.
 * @returns 同一笔交易最终确认的出借金额、份额和 slot。 Finalized supply assets, shares, and slot for this transaction.
 */
export async function waitForLendingSupply(
  signature: string,
  request: LendingSupplyRequest,
  lifetime: LendingSupplyLifetime,
  signal?: AbortSignal,
): Promise<LendingSupplyReceipt> {
  /** 整体截止时间同时限制每轮 RPC 和等待间隔。 The overall deadline bounds every RPC request and poll delay. */
  const deadline = AbortSignal.timeout(confirmationTimeoutMs);
  const pollSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const connection = makeConnection(pollSignal);
  const instruction = buildSupplyInstruction(request);
  const transactionConfig = { commitment: 'finalized', maxSupportedTransactionVersion: 0 } as const;
  /** 记下是否已经观察到最终确认，以及最近一次 RPC 故障。 Record whether finalization was observed and the last RPC fault. */
  let finalized = false;
  let lastRpcError: unknown;

  while (!pollSignal.aborted) {
    try {
      if (!finalized) {
        /** 查询历史状态也要使用有效期内的同一个真实交易签名。 Search transaction history by the same real signature from this submission. */
        const observation = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const [status] = observation.value;
        if (status?.confirmationStatus === 'finalized') {
          if (status.err) throw new LendingSupplyError('transactionFailed', status.err);
          finalized = true;
        } else if (!status && observation.context.slot >= lifetime.minContextSlot &&
            await connection.getBlockHeight({ commitment: 'finalized', minContextSlot: lifetime.minContextSlot }) > lifetime.lastValidBlockHeight) {
          /** 区块哈希过期后再次读取链上结果，避免把轮询间隙已落链的交易判成过期。 Recheck after blockhash expiration so a transaction landed between polls is not marked expired. */
          const recheck = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
          if (recheck.context.slot >= observation.context.slot && recheck.value[0] === null) {
            /** 即使历史状态索引尚未返回签名，也再做一次最终确认交易查询。 Attempt a finalized transaction lookup even when the status index still has no signature. */
            const transaction = await connection.getTransaction(signature, transactionConfig);
            pollSignal.throwIfAborted();
            if (transaction) return readReceipt(transaction, signature, instruction, request, lifetime);
            throw new LendingSupplyError('expired');
          }
        }
      }
      if (finalized) {
        /** 最终确认状态和带日志的完整交易可能在不同时间出现在 RPC。 Finalized status and complete transaction logs can appear in the RPC at different times. */
        const transaction = await connection.getTransaction(signature, transactionConfig);
        pollSignal.throwIfAborted();
        if (transaction) return readReceipt(transaction, signature, instruction, request, lifetime);
      }
    } catch (error) {
      if (error instanceof LendingSupplyError) throw error;
      lastRpcError = error;
    }
    await waitForNextPoll(pollSignal);
  }
  signal?.throwIfAborted();
  throw new LendingSupplyError(finalized ? 'receiptUnavailable' : 'confirmationUnknown', lastRpcError);
}

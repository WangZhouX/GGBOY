import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type SignatureStatus,
  type TransactionError,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { devnetRpcUrl } from '../getDevnetSolBalance';
import { devnetVaultConfig } from './devnetVault';
import vaultIdl from './ggboyVaultIdl.json';

/** 影响两种交易共用的 IDL 及错误映射。 Selects the IDL and error mapping shared by both transaction types. */
type VaultTransactionKind = 'deposit' | 'redeem';

/** 交易的 IDL 操作、账户、最小单位和模拟边界。 IDL operation, accounts, base units, and simulation bounds. */
interface PrepareVaultTransactionRequest {
  /** 已部署 IDL 中的操作名。 Instruction name in the deployed IDL. */
  kind: VaultTransactionKind;
  /** 自己的 Phantom 钱包和费用支付账户。 The user's Phantom wallet and fee payer. */
  investor: PublicKey;
  /** 钱包拥有的结算代币账户。 Wallet-owned settlement token account. */
  investorAsset: PublicKey;
  /** 钱包拥有的份额账户。 Wallet-owned share token account. */
  investorShares: PublicKey;
  /** 指令接受的第一项数量，按各自 Mint 的最小单位。 First instruction amount in the respective mint's base units. */
  amountRaw: bigint;
  /** 用户接受的最小输出，按输出 Mint 的最小单位。 User's minimum output in the output mint's base units. */
  minOutputRaw: bigint;
  /** 模拟和获取区块哈希必须达到的确认 slot。 Confirmed slot floor for simulation and fetching a blockhash. */
  minContextSlot: number;
  /** 原子执行的关联账户创建及必要的份额归集指令。 ATA creation and any needed share consolidation to execute atomically. */
  setup: readonly TransactionInstruction[];
}

/** 利用有效期和状态读链跟踪提交结果。 Track the submission by its lifetime and on-chain status. */
export interface VaultTransactionLifetime {
  /** 已确认 blockhash 的最后有效区块高度，按区块数计。 Last valid block height of the confirmed blockhash, measured in blocks. */
  lastValidBlockHeight: number;
  /** 模拟返回的已确认 slot，签名提交时用于避免落后的 RPC 视图。 Confirmed slot returned by simulation, used to avoid a lagging RPC view on submission. */
  minContextSlot: number;
}

/** 传给 Phantom 的未签名交易及其有效期。 Unsigned transaction for Phantom and its lifetime. */
export interface PreparedVaultTransaction extends VaultTransactionLifetime {
  /** 由 Phantom 签名的 legacy 交易，关联账户创建与金库指令在同一笔内。 Legacy Phantom transaction combining ATA creation with the vault instruction. */
  transaction: Transaction;
  /** 已写入交易、由 Devnet RPC 提供的 Base58 blockhash。 Devnet RPC Base58 blockhash written into the transaction. */
  blockhash: string;
}

/** 页面可翻译的金库交易错误。 Vault transaction errors that the page can translate. */
export type VaultTransactionErrorCode =
  | 'invalidAmount'
  | 'quoteChanged'
  | 'insufficientAsset'
  | 'insufficientShares'
  | 'insufficientVaultCash'
  | 'tooManyShareAccounts'
  | 'insufficientSol'
  | 'preparationFailed'
  | 'transactionFailed'
  | 'expired'
  | 'confirmationUnknown';

/** 保留错误分类和诊断原因供界面与日志分别使用。 Preserve the error category and diagnostic cause for UI and logging. */
export class VaultTransactionError extends Error {
  /** 用稳定错误码构造交易错误。 Create a transaction error from its stable error code. */
  constructor(
    /** 页面翻译键使用的错误分类。 Error category used as the page's translation key. */
    readonly code: VaultTransactionErrorCode,
    /** 原始 RPC 或构造错误，可供调用方诊断。 Underlying RPC or construction error for diagnostics. */
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = 'VaultTransactionError';
  }
}

/** SPL Token 指令可表达的最大最小单位数量，即 u64 上限。 Largest base-unit amount a SPL Token instruction can encode, the u64 maximum. */
const maxTokenAmount = (1n << 64n) - 1n;
/** 单次 RPC 调用的最长等待时间，单位为毫秒。 Maximum wait per RPC call in milliseconds. */
const rpcTimeoutMs = 8_000;
/** 单次查询流程等待链上确认的最长时间，单位为毫秒。 Maximum wait for confirmation in one lookup in milliseconds. */
const confirmationTimeoutMs = 120_000;
/** 查询同一签名的间隔，单位为毫秒。 Delay between signature lookups in milliseconds. */
const confirmationPollMs = 2_500;
/**
 * 创建只访问 Devnet 的 RPC 客户端，给每个请求设置超时。
 * Create a Devnet-only RPC client with a timeout per request.
 *
 * @param signal 查询整体的取消信号。 Cancellation signal for the whole lookup.
 */
function makeConnection(signal?: AbortSignal) {
  return new Connection(devnetRpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (input, options) => {
      /** 在单次请求超时或者查询整体取消时结束当前请求。 End this request when either its timeout or the entire lookup is cancelled. */
      const timeout = AbortSignal.timeout(rpcTimeoutMs);
      return fetch(input, { ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    },
  });
}

/** Anchor 程序错误名与界面错误语义的对应关系。 Map the Anchor program error names to their UI meanings. */
const programErrorCodes: Partial<Record<string, VaultTransactionErrorCode>> = {
  InsufficientDepositBalance: 'insufficientAsset',
  InsufficientRedeemShares: 'insufficientShares',
  InsufficientVaultCash: 'insufficientVaultCash',
  InvalidVaultPricingState: 'quoteChanged',
  InvalidRedemptionPricingState: 'quoteChanged',
  DepositSharesOverflow: 'quoteChanged',
  ZeroSharesOut: 'quoteChanged',
  ZeroAssetsOut: 'quoteChanged',
  MinimumSharesOutNotMet: 'quoteChanged',
  MinimumAssetsOutNotMet: 'quoteChanged',
  InvalidDepositAmount: 'invalidAmount',
  InvalidMinimumSharesOut: 'invalidAmount',
  InvalidRedeemAmount: 'invalidAmount',
  InvalidMinimumAssetsOut: 'invalidAmount',
};

/**
 * 拒绝零数和超出链上 u64 的金额，避免拼装不可执行的指令。
 * Reject zero and out-of-range u64 amounts before building an instruction.
 *
 * @param amountRaw 提交的数量，按输入 Mint 最小单位。 Submitted quantity in input mint base units.
 * @param minOutputRaw 接受的最少数量，按输出 Mint 最小单位。 Minimum accepted quantity in output mint base units.
 */
export function validateVaultAmounts(amountRaw: bigint, minOutputRaw: bigint) {
  if (amountRaw <= 0n || amountRaw > maxTokenAmount || minOutputRaw <= 0n || minOutputRaw > maxTokenAmount) {
    throw new VaultTransactionError('invalidAmount');
  }
}

/**
 * 将模拟失败映射成用户可理解的错误，并区分金库和 SPL Token 程序。
 * Map simulation failures to user-facing errors, distinguishing the vault from SPL Token.
 *
 * @param error 模拟返回的执行错误。 Execution error returned by simulation.
 * @param logs 模拟返回的程序日志。 Program logs returned by simulation.
 * @param vaultInstructionIndex 金库指令在交易内的序号，从 0 开始。 Zero-based vault instruction index.
 */
function getSimulationError(error: TransactionError, logs: string[] | null, vaultInstructionIndex: number) {
  // 新建关联账户可能需要扣除免租余额，和普通手续费不足归入同类。
  // Creating an ATA may debit a rent-exempt balance, reported with insufficient fees.
  if (error === 'InsufficientFundsForFee' ||
      (typeof error === 'object' && 'InsufficientFundsForRent' in error) ||
      logs?.some((line) => /insufficient lamports/i.test(line))) {
    return new VaultTransactionError('insufficientSol', error);
  }

  /** 先核对出错指令的索引，再解码具体程序错误。 Check the failing instruction index before decoding its program error. */
  const instructionError = typeof error === 'object' && 'InstructionError' in error
    ? error.InstructionError
    : null;
  if (Array.isArray(instructionError)) {
    /** 第一条是 ATA 指令，后续准备指令只用于归集份额。 The ATA comes first, and later setup instructions only consolidate shares. */
    const [index, detail] = instructionError;
    const custom = detail && typeof detail === 'object' && 'Custom' in detail ? detail.Custom : null;
    if (index === vaultInstructionIndex) {
      /** 数字错误码只按该金库的 IDL 查询。 Resolve numeric errors only against this vault's IDL. */
      const name = vaultIdl.errors.find((entry) => entry.code === custom)?.name;
      if (name && programErrorCodes[name]) return new VaultTransactionError(programErrorCodes[name], error);
    } else if (typeof index === 'number' && index > 0 && index < vaultInstructionIndex && custom === 1) {
      // 归集指令直接调用 SPL Token，错误码 1 表示该份额账户的余额已不足。
      // Consolidation calls SPL Token directly, where error 1 signals insufficient balance in a share account.
      return new VaultTransactionError('insufficientShares', error);
    }
  }

  return new VaultTransactionError('transactionFailed', error);
}

/**
 * 按锁定的报价上下文拼装和模拟已部署程序的交易。
 * Build and simulate a deployed-program transaction using the locked quote context.
 *
 * @param request 钱包和已验证的代币账户、IDL 操作、金额和准备指令。 Wallet and verified token accounts, IDL action, amounts, and setup instructions.
 * @returns 模拟通过后的待签名交易，及后续确认所需的有效期。 Simulated, unsigned transaction and lifetime for confirmation.
 */
export async function prepareVaultTransaction(request: PrepareVaultTransactionRequest): Promise<PreparedVaultTransaction> {
  /** 地址来自已验证的 Devnet 金库配置，指令定义来自公开 IDL。 Addresses come from the verified Devnet vault configuration and instruction shape from the public IDL. */
  const { programId, vaultAddress, assetMint, cashVault, shareMint } = devnetVaultConfig;
  const instruction = vaultIdl.instructions.find(({ name }) => name === request.kind);
  if (!instruction || programId.toBase58() !== vaultIdl.address) {
    throw new Error('Vault deployment and instruction IDL do not match.');
  }

  /** 账户名称按 IDL 解析，按程序要求构造元数据。 Resolve IDL account names to the metadata required by the program. */
  const addresses: Readonly<Record<string, PublicKey>> = {
    investor: request.investor,
    vault: vaultAddress,
    asset_mint: assetMint,
    cash_vault: cashVault,
    share_mint: shareMint,
    investor_asset: request.investorAsset,
    investor_shares: request.investorShares,
    token_program: TOKEN_PROGRAM_ID,
  };
  /** Anchor 判别符后依次使用小端序编码两个 u64 参数。 Encode two little-endian u64 arguments immediately after the Anchor discriminator. */
  const data = Buffer.alloc(instruction.discriminator.length + 16);
  Buffer.from(instruction.discriminator).copy(data);
  data.writeBigUInt64LE(request.amountRaw, instruction.discriminator.length);
  data.writeBigUInt64LE(request.minOutputRaw, instruction.discriminator.length + 8);

  /** 以和报价同样的确认层级获取 blockhash，避免使用更早的节点视图。 Fetch the blockhash at the quote's commitment level without stepping back to an older node view. */
  const connection = makeConnection();
  const lifetime = await connection.getLatestBlockhash({
    commitment: 'confirmed',
    minContextSlot: request.minContextSlot,
  });
  /** 所有账户操作与托管资金变化一起执行，任一步失败都回滚。 Account changes and vault balance changes execute together and roll back if any instruction fails. */
  const transaction = new Transaction({ ...lifetime, feePayer: request.investor }).add(
    ...request.setup,
    new TransactionInstruction({
      programId,
      data,
      keys: instruction.accounts.map((account) => {
        /** 账户名由当前 IDL 决定，缺失时停止构造。 Refuse to build if an account required by this IDL is missing. */
        const pubkey = addresses[account.name];
        if (!pubkey) throw new Error('The vault instruction requires an unmapped account.');
        return {
          pubkey,
          isSigner: 'signer' in account && account.signer === true,
          isWritable: 'writable' in account && account.writable === true,
        };
      }),
    }),
  );

  /** Versioned 包装 legacy 消息用于无签名模拟，Phantom 仍收到原交易。 Wrap the legacy message for unsigned simulation while Phantom still receives the original transaction. */
  let unsignedSimulation: VersionedTransaction;
  try {
    unsignedSimulation = new VersionedTransaction(transaction.compileMessage());
    if (unsignedSimulation.serialize().length > PACKET_DATA_SIZE) throw new RangeError('Solana packet size exceeded.');
  } catch (error) {
    if (request.kind === 'redeem' && request.setup.length > 1 && error instanceof RangeError) {
      throw new VaultTransactionError('tooManyShareAccounts', error);
    }
    throw error;
  }

  /** 模拟执行的 RPC 视图同样不得早于报价 slot。 The simulation's RPC view must also be at least as new as the quote slot. */
  const simulation = await connection.simulateTransaction(unsignedSimulation, {
    commitment: 'confirmed',
    minContextSlot: request.minContextSlot,
    sigVerify: false,
  });
  // RPC 返回值也必须满足报价的最低 slot，避免把落后的模拟送交签名。
  // Verify the returned slot floor as well, so a stale simulation never reaches the wallet.
  if (!Number.isSafeInteger(simulation.context.slot) || simulation.context.slot < request.minContextSlot) {
    throw new VaultTransactionError('preparationFailed');
  }
  if (simulation.value.err) throw getSimulationError(simulation.value.err, simulation.value.logs, request.setup.length);
  return { transaction, ...lifetime, minContextSlot: simulation.context.slot };
}

/**
 * 只接受达到已确认或最终确认的链上结果，避免把临时分叉的处理结果当作完成。
 * Accept only confirmed or finalized results so a transient fork's processed record is not mistaken for completion.
 *
 * @param status 指定签名的链上状态，没有结果时为空。 Status for the signature, or null if unobserved.
 * @returns 确认时的 slot，尚无确认时为空。 Confirmation slot, or null before confirmation.
 */
function getConfirmedSlot(status: SignatureStatus | null): number | null {
  if (status?.confirmationStatus !== 'confirmed' && status?.confirmationStatus !== 'finalized') return null;
  // 链上已确认的失败是终态，保留具体原因供诊断和回执查询。
  // A confirmed execution error is terminal. Keep its specific cause for diagnostics and receipt lookup.
  if (status.err) throw new VaultTransactionError('transactionFailed', status.err);
  return status.slot;
}

/**
 * 等到下一次轮询或查询取消，避免等待时继续占用计时器。
 * Wait for the next poll or cancellation without retaining a timer after cancellation.
 *
 * @param signal 批量观察 RPC 的取消信号。 Cancellation signal for the overall RPC observation.
 */
function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    /** 时间到或取消时清理计时器及监听。 Clear the timer and listener on elapsed time or cancellation. */
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }

    /** 两次查询之间等待的计时器，延迟以毫秒计。 Timer for the delay between status requests, measured in milliseconds. */
    const timer = setTimeout(finish, confirmationPollMs);
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 获取既有签名的确认结果。RPC 暂时不可用时继续查询，超时后保留未知状态。
 * Resolve an existing signature's confirmation. Retry transient RPC failures and retain an unknown result on timeout.
 *
 * @param signature Phantom 已提交交易的 Base58 签名。 Base58 signature returned for the transaction submitted by Phantom.
 * @param lifetime 确认或重新查询只需要公开的区块高度和报价 slot。 Confirmation and rechecks need only public block-height and quote-slot data.
 * @param signal 钱包切换或页面卸载时可撤销等待。 Optional cancellation when the wallet changes or the page unmounts.
 * @returns 成功执行的交易 slot，可直接作为余额刷新下限。 Successful execution slot, usable directly as the balance refresh floor.
 */
export async function waitForVaultTransaction(
  signature: string,
  lifetime: VaultTransactionLifetime,
  signal?: AbortSignal,
): Promise<number> {
  /** 整体超时一并终止在途请求和下一轮等待，单位为毫秒。 The overall deadline, in milliseconds, bounds both requests and inter-poll delays. */
  const deadline = AbortSignal.timeout(confirmationTimeoutMs);
  const pollSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const connection = makeConnection(pollSignal);
  /** 保留最近的传输错误用于诊断，面向用户的状态保持未知。 Preserve the last transport error for diagnostics while exposing an unknown outcome. */
  let lastRpcError: unknown;
  while (!pollSignal.aborted) {
    try {
      /** 查历史可以在页面重开或签名较旧时继续核对原交易。 Search transaction history to let a reopened page resolve an older signature. */
      const result = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      const slot = getConfirmedSlot(result.value);
      if (slot !== null) return slot;

      if (result.value === null) {
        /** 用最终确认高度判断有效期，给已处理但还未确认的交易留出确认时间。 Use finalized height for expiry, allowing time for recently processed transactions to confirm. */
        const height = await connection.getBlockHeight({ commitment: 'finalized', minContextSlot: lifetime.minContextSlot });
        if (height > lifetime.lastValidBlockHeight) {
          // 在确认 blockhash 已失效之后再次查签名，避免漏掉同时发生的确认。
          // Recheck the signature after seeing blockhash expiry to avoid missing a confirmation that raced the first lookup.
          const latest = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
          const latestSlot = getConfirmedSlot(latest.value);
          if (latestSlot !== null) return latestSlot;
          if (latest.value === null && latest.context.slot >= result.context.slot
            && latest.context.slot >= lifetime.minContextSlot) {
            throw new VaultTransactionError('expired');
          }
        }
      }
    } catch (error) {
      if (error instanceof VaultTransactionError) throw error;
      lastRpcError = error;
    }
    await waitForNextPoll(pollSignal);
  }

  signal?.throwIfAborted();
  throw new VaultTransactionError('confirmationUnknown', lastRpcError);
}

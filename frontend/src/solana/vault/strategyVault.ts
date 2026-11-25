import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import type { VaultListItem } from '../../features/vault/api/listVaults';
import { maxCashVaultTokenAmount } from '../../features/vault/cashVaultAmounts';
import { devnetVaultConfig, readVaultAccounts, type DevnetVaultState, type VaultDeployment } from './devnetVault';
import vaultIdl from './ggboyVaultIdl.json';
import { strategyBpsScale, strategyLendingProgram, strategyScale, vaultStrategyAddresses } from './strategyVaultAccounts';

/** 当前登记和与同槽的金库现金、策略资产以及借贷数据。 Registry entry and same-slot vault cash, holdings and lending data. */
export interface StrategyVaultState extends DevnetVaultState {
  /** 后端提供的网络和各种 Mint 标识。 Server registry entry supplying the network and asset identifiers. */
  vault: VaultListItem;
}

/** 买入/卖出策略代币、出借现金或收回份额。 Buy or sell strategy tokens, supply cash, or recall lending shares. */
export type StrategyAction = 'buy' | 'sell' | 'lend' | 'recall';

/** 交易的输入和最低输出，两项均为各自资产或份额最小单位。 Transaction input and minimum output in the respective token or share base units. */
export interface StrategyRequest {
  /** 操作及兑换方向。 Operation and swap direction. */
  kind: StrategyAction;
  /** 结算代币、策略代币或出借份额的最小单位。 Settlement, strategy, or lending share base units. */
  amountRaw: bigint;
  /** 最低实际输出的资产或份额最小单位。 Minimum actual asset or share output in base units. */
  minOutRaw: bigint;
}

/** Phantom 钱包提供的签名和广播回调返回公开签名。 The Phantom wallet signs and broadcasts, returning the public signature. */
type StrategySigner = (transaction: Transaction, expectedWallet: string, minContextSlot: number, rpcUrl: string) => Promise<string>;

/** 最终确认事件中的实付数据。 Actual settlement data from a finalized event. */
interface StrategyReceipt {
  /** 公共交易签名和该交易执行 slot。 Public transaction signature and execution slot. */
  signature: string;
  slot: number;
  /** 实际输入及输出的最小单位；出借和收回均记录对应的同一笔现金变动。 Actual input and output base units. Supply and recall report their single underlying cash movement. */
  inputRaw: bigint;
  outputRaw: bigint;
}

/** 稳定错误类型用于区分模拟失败、链上失败和待核对的结果。 Stable errors distinguish simulation, on-chain failure, and unresolved results. */
export class StrategyVaultTransactionError extends Error {
  /** 保留可用于页面翻译的错误码及原始原因。 Retain a localization-friendly error code and underlying cause. */
  constructor(readonly code: 'simulationFailed' | 'transactionFailed' | 'transactionExpired' | 'receiptUnavailable' | 'confirmationUnknown', cause?: unknown) {
    super(code, { cause });
    this.name = 'StrategyVaultTransactionError';
  }
}

/** Phantom 与 Localnet 调试使用的默认节点地址。 Default endpoint for Localnet development. */
const localRpcUrl = (import.meta as ImportMeta & { env?: { VITE_SOLANA_LOCALNET_RPC_URL?: string } })
  .env?.VITE_SOLANA_LOCALNET_RPC_URL || 'http://127.0.0.1:8899';
/** 读取 RPC 的请求时限和单笔最终确认轮询间隔，以毫秒计。 RPC timeout and finalization poll cadence in milliseconds. */
const rpcTimeoutMs = 8_000;
const confirmationTimeoutMs = 120_000;
const pollIntervalMs = 2_500;
/** VaultStrategyAction 在 Anchor 日志中的判别符与动作码。 Anchor log discriminator and kind codes for VaultStrategyAction. */
const eventDiscriminator = Buffer.from([205, 48, 115, 98, 49, 100, 60, 36]);
const eventKinds = { buy: 0, sell: 0, lend: 1, recall: 2 } as const;
/** 兑换方向共用一个 Anchor 指令。 Both swap directions use the same Anchor instruction. */
const instructions = { buy: 'strategy_swap', sell: 'strategy_swap', lend: 'strategy_lend', recall: 'strategy_recall' } as const;

/** 只读取受支持的程序、金库 PDA 和份额 Mint。 Read only the supported program, canonical vault, and share mint. */
function registeredDeployment(vault: VaultListItem): VaultDeployment {
  /** 两个网络沿用同一个公开程序 ID，Localnet 可以初始化自己的结算 Mint。 Both networks use the public program ID, and Localnet can initialize its own settlement mint. */
  const assetMint = new PublicKey(vault.quoteAsset.mint);
  if (vault.programId !== devnetVaultConfig.programId.toBase58() || vault.address !== devnetVaultConfig.vaultAddress.toBase58() ||
      vault.shareAsset.mint !== devnetVaultConfig.shareMint.toBase58() || vault.quoteAsset.decimals !== 6 || vault.shareAsset.decimals !== 6 ||
      (vault.network === 'devnet' && !assetMint.equals(devnetVaultConfig.assetMint))) {
    throw new Error('Unsupported strategy vault deployment.');
  }
  return { ...devnetVaultConfig, assetMint, rpcUrl: vault.network === 'localnet' ? localRpcUrl : devnetVaultConfig.rpcUrl };
}

/** 用部署登记的网络建立连接，超时只取消当前 RPC 请求。 Connect to the registered network, applying timeout per RPC request. */
function strategyConnection(deployment: VaultDeployment) {
  return new Connection(deployment.rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(rpcTimeoutMs) }),
  });
}

/**
 * 读取已登记金库的策略和可用额度。
 * Read the strategy and usable limits of a registered vault.
 *
 * @param vault 确定网络和金库绑定的登记。 Registration selecting network and vault bindings.
 * @param minContextSlot 已确认交易的读链槽下限。 Minimum read slot after a confirmed trade.
 * @param signal 页面离开、切换网络或金库时的取消信号。 Cancellation when the page, network, or vault changes.
 */
export async function readVaultStrategy(vault: VaultListItem, minContextSlot?: number, signal?: AbortSignal): Promise<StrategyVaultState> {
  /** 估值、池份额与管理者配置由同一个链上观测给出。 One observation supplies valuation, pool shares, and the manager configuration. */
  const state = await readVaultAccounts(registeredDeployment(vault), null, minContextSlot, signal);
  if (state.config &&
      ((vault.strategyAsset && (!state.config.strategyMint.equals(new PublicKey(vault.strategyAsset.mint)) ||
        vault.strategyAsset.decimals !== state.config.strategyDecimals)) ||
      (vault.lendingMarketAddress && !state.config.market.equals(new PublicKey(vault.lendingMarketAddress))))) {
    throw new Error('Vault strategy registration does not match its on-chain configuration.');
  }
  return { ...state, vault };
}

/**
 * 用链上的相同报价与额度计算预估输出，向下取整。
 * Estimate output using the on-chain pricing and limits, rounded down.
 *
 * @param state 当前选中金库的已核验状态。 Verified state of the selected vault.
 * @param kind 操作及方向。 Operation and direction.
 * @param amountRaw 输入最小单位数。 Input quantity in base units.
 * @returns 可执行时为预计输出最小单位数，否则为空。 Estimated output in base units when executable, or null.
 */
export function quoteVaultStrategy(state: StrategyVaultState, kind: StrategyAction, amountRaw: bigint): bigint | null {
  if (!state.config || amountRaw <= 0n || amountRaw > maxCashVaultTokenAmount) return null;
  /** 份额价值与池的记账资产、总份额同时读取。 Pool shares are priced from same-slot assets and total shares. */
  const { poolAssetsRaw, poolSharesRaw, priceRaw, navRaw } = state;
  if (kind === 'recall') {
    if (amountRaw > state.maxRecallSharesRaw || poolSharesRaw === 0n) return null;
    const output = amountRaw * poolAssetsRaw / poolSharesRaw;
    return output > 0n ? output : null;
  }
  if (state.totalSharesRaw === 0n || navRaw === null || navRaw <= 0n) return null;
  if (kind === 'lend') {
    if (state.maxLendRaw === null || amountRaw > state.maxLendRaw ||
        (poolAssetsRaw === 0n && poolSharesRaw !== 0n)) return null;
    const output = poolAssetsRaw === 0n ? amountRaw : amountRaw * poolSharesRaw / poolAssetsRaw;
    return output > 0n && poolAssetsRaw + amountRaw <= maxCashVaultTokenAmount &&
      poolSharesRaw + output <= maxCashVaultTokenAmount ? output : null;
  }
  if (priceRaw === null) return null;
  /** 单笔限额同比例应用到两种方向的 mockUSDC 价值。 Apply the same transaction cap to both directions' mockUSDC value. */
  const tradeCap = navRaw * BigInt(state.config.maxTradeBps) / strategyBpsScale;
  if (kind === 'buy') {
    const output = amountRaw * strategyScale / priceRaw;
    return amountRaw <= state.cashRaw && amountRaw <= tradeCap && output > 0n && output <= state.swapSpotRaw &&
      state.spotRaw + output <= maxCashVaultTokenAmount && state.swapCashRaw + amountRaw <= maxCashVaultTokenAmount ? output : null;
  }
  const output = amountRaw * priceRaw / strategyScale;
  /** 小净值退出允许卖回一个结算最小单位。 A tiny NAV can exit by selling for one settlement base unit. */
  const sellCap = tradeCap === 0n ? 1n : tradeCap;
  return amountRaw <= state.spotRaw && output > 0n && output <= sellCap && output <= state.swapCashRaw &&
    state.cashRaw + output <= maxCashVaultTokenAmount && state.swapSpotRaw + amountRaw <= maxCashVaultTokenAmount ? output : null;
}

/** 根据 Anchor IDL 生成已选操作的账户和精确的 u64 参数。 Build accounts and exact u64 arguments from the Anchor IDL. */
function strategyInstruction(deployment: VaultDeployment, state: StrategyVaultState, request: StrategyRequest, manager: PublicKey) {
  /** IDL 和状态共同绑定程序认可的交易账户。 The IDL and verified state bind the accounts accepted by the program. */
  const idlInstruction = vaultIdl.instructions.find(({ name }) => name === instructions[request.kind]);
  if (!idlInstruction || !state.config || !state.config.manager.equals(manager)) throw new Error('Strategy instruction unavailable.');
  const addresses = vaultStrategyAddresses(deployment.programId, deployment.vaultAddress);
  const accounts: Record<string, PublicKey> = {
    manager, vault: deployment.vaultAddress, strategy: addresses.strategy, cash_vault: deployment.cashVault,
    asset_mint: deployment.assetMint, strategy_custody: addresses.strategyCustody, strategy_mint: state.config.strategyMint,
    swap_cash: addresses.swapCash, swap_strategy: addresses.swapStrategy, market: addresses.market,
    price: addresses.price, lending_cash: addresses.lendingCash, supply_pool: addresses.supplyPool,
    supply_position: addresses.supplyPosition, borrow_market: addresses.borrowMarket,
    lending_program: strategyLendingProgram, token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
    share_mint: deployment.shareMint,
  };
  /** Anchor discriminator、可选的布尔方向位以及小端的输入和最低输出。 Anchor discriminator, optional boolean direction, and little-endian input/minimum. */
  const isSwap = request.kind === 'buy' || request.kind === 'sell';
  const offset = idlInstruction.discriminator.length + Number(isSwap);
  const data = Buffer.alloc(offset + 16);
  Buffer.from(idlInstruction.discriminator).copy(data);
  if (isSwap) data[offset - 1] = request.kind === 'buy' ? 1 : 0;
  data.writeBigUInt64LE(request.amountRaw, offset);
  data.writeBigUInt64LE(request.minOutRaw, offset + 8);
  return new TransactionInstruction({
    programId: deployment.programId, data,
    keys: idlInstruction.accounts.map((account) => {
      /** 未识别的 ABI 账户禁止送入钱包。 Refuse to request a wallet signature for an unrecognized ABI account. */
      const pubkey = accounts[account.name];
      if (!pubkey) throw new Error('Unmapped strategy transaction account: ' + account.name);
      return { pubkey, isSigner: 'signer' in account && account.signer === true,
        isWritable: 'writable' in account && account.writable === true };
    }),
  });
}

/** 从顶层金库指令提取已确认业务事件，忽略其他程序及 CPI 日志。 Extract top-level vault events, ignoring other programs and nested CPI logs. */
function topLevelStrategyEvents(logs: string[], program: string) {
  /** 当前执行栈按日志中的调用深度恢复。 Reconstruct the active invocation stack from logged depths. */
  const stack: string[] = [];
  const events: Buffer[] = [];
  for (const line of logs) {
    const entry = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (entry) {
      if (Number(entry[2]) !== stack.length + 1) throw new Error('Unexpected strategy execution depth.');
      stack.push(entry[1]);
      continue;
    }
    const exit = /^Program (\w+) (?:success|failed:.*)$/.exec(line);
    if (exit) {
      if (stack.pop() !== exit[1]) throw new Error('Unexpected strategy execution exit.');
      continue;
    }
    if (stack.length === 1 && stack[0] === program && line.startsWith('Program data: ')) {
      const payload = Buffer.from(line.slice(14), 'base64');
      if (payload.length === 153 && payload.subarray(0, 8).equals(eventDiscriminator)) events.push(payload);
    }
  }
  if (stack.length !== 0) throw new Error('Strategy execution logs are incomplete.');
  return events;
}

/** 查最终状态并校验本笔成交对应的管理者、金库、方向、Mint 和实际金额。 Resolve finalized status and verify the trade's manager, vault, direction, mint bindings and amounts. */
async function readReceipt(
  connection: Connection, deployment: VaultDeployment, state: StrategyVaultState,
  request: StrategyRequest, managerAddress: string, signature: string, lastValidBlockHeight?: number,
): Promise<StrategyReceipt | null> {
  /** 未最终确认的存储状态仍可能改变。 An observed status can still change until finalized. */
  const first = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
  let status = first.value;
  if (!status && lastValidBlockHeight !== undefined && await connection.getBlockHeight('finalized') > lastValidBlockHeight) {
    // 过期时再查一次历史，避免把在查询间隙确认的交易误判为过期。
    // Check history again at expiry so finalization racing the first lookup is not mistaken for expiry.
    const latest = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (!latest.value && latest.context.slot >= first.context.slot) {
      throw new StrategyVaultTransactionError('transactionExpired');
    }
    status = latest.value;
  }
  if (status?.confirmationStatus !== 'finalized') return null;
  if (status.err) throw new StrategyVaultTransactionError('transactionFailed', status.err);
  const transaction = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!transaction) return null;
  if (transaction.meta?.err) throw new StrategyVaultTransactionError('transactionFailed', transaction.meta.err);
  if (!state.config || !transaction.meta?.logMessages || transaction.slot !== status.slot) {
    throw new StrategyVaultTransactionError('receiptUnavailable');
  }

  /** 回执必须对应当初的管理者、请求操作与币种，且金额须满足承诺。 The receipt must match the original manager, requested action, and mints, with amounts meeting the signed intent. */
  const manager = new PublicKey(managerAddress);
  const inputMint = request.kind === 'sell' ? state.config.strategyMint : deployment.assetMint;
  const outputMint = request.kind === 'buy' ? state.config.strategyMint : deployment.assetMint;
  const expected = strategyInstruction(deployment, state, request, manager);
  const message = transaction.transaction.message;
  const keys = message.getAccountKeys();
  const matchingInstructions = message.compiledInstructions.filter(({ programIdIndex, data }) =>
    keys.get(programIdIndex)?.equals(deployment.programId) && Buffer.from(data).equals(expected.data));
  if (matchingInstructions.length !== 1) throw new StrategyVaultTransactionError('receiptUnavailable');

  const events = topLevelStrategyEvents(transaction.meta.logMessages, deployment.programId.toBase58()).filter((payload) =>
    new PublicKey(payload.subarray(8, 40)).equals(deployment.vaultAddress) &&
    new PublicKey(payload.subarray(40, 72)).equals(manager) && payload[72] === eventKinds[request.kind] &&
    new PublicKey(payload.subarray(73, 105)).equals(inputMint) &&
    new PublicKey(payload.subarray(105, 137)).equals(outputMint));
  if (events.length !== 1) throw new StrategyVaultTransactionError('receiptUnavailable');
  const inputRaw = events[0].readBigUInt64LE(137);
  const outputRaw = events[0].readBigUInt64LE(145);
  if (inputRaw === 0n || outputRaw === 0n || (request.kind !== 'recall' && inputRaw !== request.amountRaw) ||
      (request.kind !== 'lend' && outputRaw < request.minOutRaw) ||
      ((request.kind === 'lend' || request.kind === 'recall') && inputRaw !== outputRaw)) {
    throw new StrategyVaultTransactionError('receiptUnavailable');
  }
  return { signature, slot: status.slot, inputRaw, outputRaw };
}

/** 用先前已广播的签名重新核对结果，尚未最终确认返回空。 Recheck a previously broadcast signature, returning null while finalization is pending. */
export function readVaultStrategyReceipt(
  state: StrategyVaultState, request: StrategyRequest, managerAddress: string, signature: string, lastValidBlockHeight?: number,
) {
  const deployment = registeredDeployment(state.vault);
  return readReceipt(strategyConnection(deployment), deployment, state, request, managerAddress, signature, lastValidBlockHeight);
}

/**
 * 重新报价并模拟后交给管理者的钱包签名，返回最终确认的链上事件。
 * Requote and simulate before management wallet signing, then return the finalized on-chain event.
 *
 * @param state 待确认操作所依据的链上观测。 Chain observation used for the pending action.
 * @param request 签名时固定的金额和最低输出。 Amount and minimum output fixed in the signed transaction.
 * @param managerAddress 确认操作的 Phantom 钱包地址。 Phantom address authorizing the action.
 * @param signAndSendTransaction 钱包签名与广播入口。 Wallet signing and broadcast entry point.
 * @param onBroadcast 记录签名的可选回调，用于最终确认但尚未返回时恢复查询。 Optional callback to preserve the signature for finalization recovery.
 */
export async function submitVaultStrategy(
  state: StrategyVaultState, request: StrategyRequest, managerAddress: string,
  signAndSendTransaction: StrategySigner, onBroadcast?: (signature: string, lastValidBlockHeight: number) => void,
): Promise<StrategyReceipt> {
  /** 刷新报价和管理权限，交易模拟从最新可用确认槽开始。 Refresh the quote and management authority before simulation at the latest usable confirmed slot. */
  const current = await readVaultStrategy(state.vault, state.slot);
  const quote = quoteVaultStrategy(current, request.kind, request.amountRaw);
  if (quote === null || request.minOutRaw < 1n || request.minOutRaw > quote ||
      current.config?.manager.toBase58() !== managerAddress) throw new StrategyVaultTransactionError('simulationFailed');
  const deployment = registeredDeployment(current.vault);
  const connection = strategyConnection(deployment);
  const manager = new PublicKey(managerAddress);
  const block = await connection.getLatestBlockhash({ commitment: 'confirmed', minContextSlot: current.slot });
  const transaction = new Transaction({ ...block, feePayer: manager }).add(strategyInstruction(deployment, current, request, manager));
  /** 不签名的预执行检查余额、链上权限、实际限额和最低输出。 Unsigned simulation checks balances, on-chain authority, limits and minimum output. */
  const simulation = await connection.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {
    commitment: 'confirmed', sigVerify: false, minContextSlot: current.slot,
  });
  if (simulation.value.err || simulation.context.slot < current.slot) {
    throw new StrategyVaultTransactionError('simulationFailed', simulation.value);
  }
  const signature = await signAndSendTransaction(transaction, managerAddress, simulation.context.slot, deployment.rpcUrl);
  onBroadcast?.(signature, block.lastValidBlockHeight);
  /** 只轮询提交过的签名，RPC 超时不会再次发交易。 Poll only the submitted signature. RPC timeouts never resend. */
  const deadline = Date.now() + confirmationTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const receipt = await readReceipt(connection, deployment, current, request, managerAddress, signature, block.lastValidBlockHeight);
      if (receipt) return receipt;
    } catch (error) {
      if (error instanceof StrategyVaultTransactionError &&
          (error.code === 'transactionFailed' || error.code === 'transactionExpired')) throw error;
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new StrategyVaultTransactionError('confirmationUnknown', lastError);
}

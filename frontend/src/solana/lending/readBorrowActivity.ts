import { Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import { Buffer } from 'buffer';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { devnetRpcUrl } from '../getDevnetSolBalance';
import { devnetLendingBorrowAddresses } from './devnetLendingPool';

/** 与链上事件一致的操作编号，依次是存抵押、借款、还款、取回抵押。 On-chain action codes, in order: deposit collateral, borrow, repay, and withdraw collateral. */
export type LendingBorrowActivityKind = 0 | 1 | 2 | 3;

/** 从借贷程序顶层调用中核对的借款操作及操作后仓位。 Borrow operation and resulting position verified from a top-level lending invocation. */
export interface LendingBorrowActivityEvent {
  /** 交易中借贷操作事件的顺序，从零开始。 Zero-based order of borrowing events within this transaction. */
  index: number;
  /** 借款或抵押操作的编号。 Code identifying the borrowing or collateral action. */
  kind: LendingBorrowActivityKind;
  /** 操作实际转移的金额，按对应资产 Mint 最小单位计。 Actual amount transferred, in base units of the relevant mint. */
  amountRaw: bigint;
  /** 操作后锁定抵押品，按抵押 Mint 最小单位计。 Collateral locked after this action, in collateral mint base units. */
  collateralRaw: bigint;
  /** 操作后未偿本金，按借款 Mint 最小单位计。 Principal remaining after this action, in debt mint base units. */
  debtRaw: bigint;
}

/** 已最终确认的借款活动及定位回执所需的公开数据。 Finalized borrowing activity and the public data needed to locate its receipt. */
interface LendingBorrowActivityItem extends LendingBorrowActivityEvent {
  /** 交易首个签名的 Base58 文本。 Base58 transaction ID from its first signature. */
  signature: string;
  /** 交易入块时的 Unix 秒数，RPC 无时间时为空。 Unix seconds when the transaction landed, or null if the RPC has no time. */
  blockTime: number | null;
}

/** 借款仓位的最近活动及近期回执是否有缺失。 Recent borrowing position activity and whether some recent receipts were unavailable. */
export interface DevnetBorrowActivity {
  /** 由新到旧的已验证借款事件。 Verified borrowing events from newest to oldest. */
  items: LendingBorrowActivityItem[];
  /** 签名已查到但部分完整交易暂不可取得。 Some full transaction receipts are unavailable despite their signatures being listed. */
  partial: boolean;
  /** 近期已经核验的回执按签名缓存，空数组表示这笔交易没有匹配事件。 Cache verified recent receipts by signature, with an empty array for a transaction with no matching event. */
  receipts: ReadonlyMap<string, LendingBorrowActivityItem[]>;
}

/** Anchor 事件判别符是 SHA-256("event:LendingBorrowAction") 的前八个字节。 The Anchor event discriminator is the first eight bytes of SHA-256("event:LendingBorrowAction"). */
const eventDiscriminator = Buffer.from([109, 228, 159, 68, 220, 223, 136, 218]);
/** 判别符、市场、借款人、操作编号和三个 u64 的字节偏移。 Byte offsets for the discriminator, market, borrower, action code, and three u64 values. */
const eventLayout = { market: 8, borrower: 40, kind: 72, amount: 73, collateral: 81, debt: 89, length: 97 } as const;
/** 近期只扫描有限签名并显示有限事件，避免在公共 RPC 拉取完整历史。 Bound both the signature scan and result count so the public RPC never has to load an entire history. */
const maxSignatures = 10;
const maxEvents = 6;

/**
 * 按市场和钱包建立借款活动缓存键，供交易确认后标记为待刷新。
 * Scope the borrowing activity cache by market and wallet so finalization can mark it for refresh.
 *
 * @param marketAddress 所选市场的 Base58 公钥。 Base58 public key of the selected market.
 * @param walletAddress 当前连接钱包的 Base58 公钥。 Base58 public key of the connected wallet.
 * @returns React Query 使用的稳定缓存键。 Stable cache key used by React Query.
 */
export function devnetBorrowActivityQueryKey(marketAddress: string, walletAddress: string) {
  return ['devnet-borrow-activity', marketAddress, walletAddress] as const;
}

/**
 * 读取已验证的借款事件。只接受该市场程序成功的顶层执行日志，以及字段与本市场和钱包实际相符的事件。
 * Read verified borrowing events, accepting only successful top-level program logs whose fields match this market and wallet.
 *
 * @param result 由已最终确认查询获得的交易消息及元数据。 Transaction message and metadata from a finalized lookup.
 * @param market 目录中的预期市场地址和程序地址。 Expected market and program addresses from the registry.
 * @param walletAddress 事件所属借款人的 Base58 公钥。 Base58 public key of the borrower to match.
 * @returns 对应本市场和钱包的事件，保持链上执行顺序。 Matching market and borrower events in execution order.
 */
export function readLendingBorrowActions(
  result: VersionedTransactionResponse,
  market: Pick<LendingMarketListItem, 'address' | 'programId'>,
  walletAddress: string,
): LendingBorrowActivityEvent[] {
  /** 失败或未提供元数据的交易不会产生可用的业务变更。 Failed transactions and transactions without metadata provide no valid state change. */
  const logs = result.meta?.logMessages;
  if (!result.meta || result.meta.err !== null || !logs) return [];

  /** 使用程序的规范市场和借款人公钥校验事件，避免让未经核对的目录项决定日志身份。 Verify events against the canonical market and borrower rather than relying only on unchecked registry entries. */
  const { programId, marketAddress, borrower } = devnetLendingBorrowAddresses(walletAddress);
  if (market.address !== marketAddress.toBase58() || market.programId !== programId.toBase58()) return [];
  const marketBytes = marketAddress.toBuffer();
  const borrowerBytes = borrower.toBuffer();

  /** 先检查这笔交易声明了目标顶层程序，再按运行时栈判断实际事件生产者。 Check the transaction declares the target top-level program, then track the runtime stack to identify the emitter. */
  const message = result.transaction.message;
  if (message.addressTableLookups.length > 0 && !result.meta.loadedAddresses) return [];
  const accountKeys = message.getAccountKeys({ accountKeysFromLookups: result.meta.loadedAddresses });
  if (!message.compiledInstructions.some(({ programIdIndex }) => accountKeys.get(programIdIndex)?.equals(programId))) return [];

  /** RPC 日志中的程序调用栈和已验证的事件。 Program invocation stack from RPC logs and verified events gathered from it. */
  const stack: string[] = [];
  const events: LendingBorrowActivityEvent[] = [];
  /** 对同笔交易借款事件计数，使签名和事件序号能够稳定定位多操作回执。 Count borrowing events per transaction so the signature and index identify entries even for bundled actions. */
  let eventIndex = 0;
  for (const line of logs) {
    /** 使用 Solana 运行时记录的调用深度，避免接纳不完整日志。 Use the runtime-reported call depth and reject incomplete traces. */
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invocation) {
      if (Number(invocation[2]) !== stack.length + 1) return [];
      stack.push(invocation[1]);
      continue;
    }

    /** 结束标记只会关闭同一个程序的调用。 A completion marker must close the invocation of the same program. */
    const completion = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed: .+)$/.exec(line);
    if (completion) {
      if (stack.pop() !== completion[1]) return [];
      continue;
    }
    if (line === 'Log truncated') return [];
    if (stack.length !== 1 || stack[0] !== market.programId) continue;

    /** 仅解析该借贷程序 emit! 写入的单段 Base64 数据。 Decode only the single Base64 payload written by this lending program's emit!. */
    const record = /^Program data: ([A-Za-z0-9+/]+={0,2})$/.exec(line);
    if (!record) continue;
    const data = Buffer.from(record[1], 'base64');
    if (!data.subarray(0, eventLayout.market).equals(eventDiscriminator)) continue;
    const index = eventIndex++;
    if (data.length !== eventLayout.length ||
        !data.subarray(eventLayout.market, eventLayout.borrower).equals(marketBytes) ||
        !data.subarray(eventLayout.borrower, eventLayout.kind).equals(borrowerBytes)) continue;

    /** Anchor 的 Borsh 金额按小端 u64 解码，以保留所有位。 Decode Anchor Borsh amounts as little-endian u64 to preserve every bit. */
    const kind = data[eventLayout.kind];
    const amountRaw = data.readBigUInt64LE(eventLayout.amount);
    if ((kind !== 0 && kind !== 1 && kind !== 2 && kind !== 3) || amountRaw === 0n) continue;
    events.push({
      index,
      kind,
      amountRaw,
      collateralRaw: data.readBigUInt64LE(eventLayout.collateral),
      debtRaw: data.readBigUInt64LE(eventLayout.debt),
    });
  }
  // 截断会留下未关闭的调用，因此整笔日志不作为有效来源。
  // Truncated logs leave invocations unclosed, invalidating the trace.
  return stack.length === 0 ? events : [];
}

/**
 * 在 Devnet 查询当前借款仓位的最近已确认操作。
 * Fetch recent finalized actions for the current Devnet borrowing position.
 *
 * @param market 已登记的 Devnet 市场。 Registered Devnet market.
 * @param walletAddress 连接的钱包公钥。 Connected wallet public key.
 * @param minContextSlot 确认交易后可用的最早 RPC 观测 slot。 Earliest acceptable RPC observation slot after transaction finalization.
 * @param signal 切换钱包、市场或页面时终止 HTTP。 Signal that cancels HTTP after changing wallets, markets, or pages.
 * @param previous 当前市场和钱包上一次已核验的回执。 Previously verified receipts for this market and wallet.
 * @returns 最近有效借款事件，以及已确认但暂不可取得完整回执的提示。 Recent validated borrow events and whether expected receipts were unavailable.
 */
export async function readDevnetBorrowActivity(
  market: LendingMarketListItem,
  walletAddress: string,
  minContextSlot?: number,
  signal?: AbortSignal,
  previous?: DevnetBorrowActivity,
): Promise<DevnetBorrowActivity> {
  /** 仓位 PDA 按借款人区分活动，避免读取其他钱包或整个程序的签名。 The position PDA scopes signatures to this borrower, instead of other wallets or the whole program. */
  const { borrowPosition, marketAddress, programId } = devnetLendingBorrowAddresses(walletAddress);
  if (market.network !== 'devnet' || market.address !== marketAddress.toBase58() || market.programId !== programId.toBase58()) {
    throw new Error('Unsupported Devnet borrowing activity market.');
  }

  /** 借用同一公开 Devnet RPC，请求限时也复用页面取消信号。 Reuse the public Devnet RPC and propagate the page's cancellation signal alongside the request timeout. */
  const connection = new Connection(devnetRpcUrl, {
    commitment: 'finalized',
    disableRetryOnRateLimit: true,
    fetch: (request, options) => {
      const timeout = AbortSignal.timeout(12_000);
      return fetch(request, { ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    },
  });

  /** RPC 按从新到旧返回签名，跳过未执行成功的交易。 RPC returns signatures newest first. Skip failed transactions. */
  const signatures = await connection.getSignaturesForAddress(borrowPosition, { limit: maxSignatures, minContextSlot }, 'finalized');
  const successful = signatures.filter(({ err }) => err === null);
  /** 按新到旧收集近期事件，刷新时只读取未核验的签名。 Collect recent events newest first and fetch only signatures that still need verification. */
  const items: LendingBorrowActivityItem[] = [];
  const receipts = new Map<string, LendingBorrowActivityItem[]>();
  let partial = false;
  /** RPC 拒绝请求后仍保留缓存，避免在同一次刷新里继续请求其他回执。 Keep cached receipts and avoid issuing more requests after the RPC rejects a read. */
  let receiptReadFailed = false;
  for (const { signature, slot, blockTime } of successful) {
    if (items.length >= maxEvents) break;

    /** 已经最终确认并完成核验的回执可直接复用。 Reuse receipts already finalized and verified. */
    const cached = previous?.receipts.get(signature);
    if (cached) {
      receipts.set(signature, cached);
      items.push(...cached);
      continue;
    }
    if (receiptReadFailed) {
      partial = true;
      continue;
    }

    try {
      /** 逐笔读取避免一次限流丢掉此前成功取得的回执。 Read once per signature so throttling does not discard earlier successful reads. */
      const transaction = await connection.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      const logs = transaction?.meta?.logMessages;
      if (!transaction || !logs || logs.includes('Log truncated') ||
          transaction.slot !== slot || transaction.transaction.signatures[0] !== signature) {
        partial = true;
        continue;
      }

      /** 同一交易有多个操作时，较晚的事件排在前面。 Order multiple verified actions in one transaction newest first. */
      const events = readLendingBorrowActions(transaction, market, walletAddress).reverse().map((event) => ({
        ...event, signature, blockTime: transaction.blockTime ?? blockTime ?? null,
      }));
      receipts.set(signature, events);
      items.push(...events);
    } catch {
      // 页面取消应立即退出查询，不能写成回执缺失。
      // Propagate page cancellation instead of treating it as a missing receipt.
      signal?.throwIfAborted();
      partial = true;
      receiptReadFailed = true;
    }
  }
  // 区分公共 RPC 本次完全读失败与确实没有借款记录。
  // Distinguish a complete RPC read failure from a verified empty history.
  if (receiptReadFailed && items.length === 0) throw new Error('Unable to load Devnet borrowing receipts.');
  return { items: items.slice(0, maxEvents), partial, receipts };
}

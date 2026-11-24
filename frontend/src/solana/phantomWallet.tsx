import type { SendOptions, Transaction } from '@solana/web3.js';
import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { devnetRpcUrl } from './getDevnetSolBalance';

/** Phantom 公钥序列化为 Base58 地址。 Phantom public key serializable as a Base58 address. */
type PhantomPublicKey = { toString(): string };

/** 页面连接或断开期间进行的操作。 Wallet action in progress on this page. */
type PendingAction = 'connecting' | 'disconnecting';

/** 对应 wallet 翻译组的连接错误键。 Connection error keys in the wallet translation group. */
type WalletError = 'unavailable' | 'unsupportedOrigin' | 'connectError' | 'rejected' | 'approvalPending'
  | 'connectTimeout' | 'connectCancelled' | 'disconnectError';

/** 用户交易失败的本地化提示类型。 Localizable wallet transaction failure types. */
type WalletTransactionErrorCode = 'rejected' | 'walletChanged' | 'approvalPending' | 'approvalExpired' | 'submissionFailed';

/** 交易调用暴露的可识别错误，保留原因供本地诊断。 Recognizable failure from a transaction call, retaining its cause for local diagnostics. */
export class WalletTransactionError extends Error {
  /**
   * 用稳定的错误码让页面选择提示。
   * Allow the page to select a message using a stable error code.
   *
   * @param code 钱包拒绝、账户变化、等待审批、审批过期或提交异常。 Wallet rejection, account change, pending or expired approval, or submission failure.
   * @param cause Phantom 的原始错误（如有）。 Original Phantom error, if present.
   */
  constructor(readonly code: WalletTransactionErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = 'WalletTransactionError';
  }
}

/** 页面关心的 Phantom 钱包事件。 Phantom wallet events used by the app. */
interface PhantomEvents {
  /** 账户变化时提供新公钥，未授权时为空。 New key after an account change, or null if unauthorized. */
  accountChanged: (publicKey: PhantomPublicKey | null) => void;
  /** 钱包端或站点发起的断开。 Wallet- or site-initiated disconnection. */
  disconnect: () => void;
}

/** Phantom 借助浏览器注入的 Solana 连接接口。 Solana connection API injected by Phantom into the browser. */
interface PhantomProvider {
  /** Phantom 用于识别自身连接入口的标记。 Flag Phantom exposes to identify its own provider. */
  readonly isPhantom: boolean;
  /** Phantom 正在授权本站使用的实际账户，可能独立于 React 渲染更新。 Account currently shared with the site, which may update independently of React. */
  readonly publicKey?: PhantomPublicKey | null;
  /** 钱包签名并广播已构造的 Solana 交易，返回公开交易签名。 Sign and broadcast a built Solana transaction, returning its public signature. */
  signAndSendTransaction?(transaction: Transaction, options?: SendOptions): Promise<{ signature: string }>;
  /** 请求当前账户的公钥。 Request access to the current account's public key. */
  connect(): Promise<{ publicKey: PhantomPublicKey }>;
  /** 断开本站与 Phantom 的连接。 Disconnect this site from Phantom. */
  disconnect(): Promise<void>;
  /** 按事件订阅对应的监听器。 Subscribe a listener for the given event. */
  on<Event extends keyof PhantomEvents>(event: Event, handler: PhantomEvents[Event]): void;
  /** 移除事件监听器。 Remove an event listener. */
  off?<Event extends keyof PhantomEvents>(event: Event, handler: PhantomEvents[Event]): void;
  /** 同义的事件监听器移除接口。 Equivalent event listener removal API. */
  removeListener?<Event extends keyof PhantomEvents>(event: Event, handler: PhantomEvents[Event]): void;
}

/** 全站共享的 Phantom 账户状态和操作。 Phantom account state and actions shared across the app. */
interface PhantomWallet {
  /** 已获授权的 Base58 公钥，未连接时为空。 Authorized Base58 public key, or null while disconnected. */
  walletAddress: string | null;
  /** 当前连接状态，包含连接和断开的等待阶段。 Current status, including pending connect and disconnect actions. */
  status: 'disconnected' | 'connected' | PendingAction;
  /** 最近一次操作的翻译错误键，没有错误时为空。 Translation key of the most recent action error, or null. */
  error: WalletError | null;
  /** 从用户操作请求 Phantom 连接。 Request a Phantom connection from a user action. */
  connect(): Promise<void>;
  /** 停止页面等待授权，钱包弹窗仍由 Phantom 管理。 Stop waiting in the page; Phantom owns its approval window. */
  cancelConnect(): void;
  /** 结束当前钱包连接。 End the current wallet connection. */
  disconnect(): Promise<void>;
  /** 用预览所绑定的账户签名并广播，最低读上下文为已确认 slot。 Sign and broadcast with the quoted account and confirmed context slot floor. */
  signAndSendTransaction(transaction: Transaction, expectedWallet: string, minContextSlot: number): Promise<string>;
}

/** 共享钱包状态的 React Context。 React context for the shared wallet state. */
const PhantomWalletContext = createContext<PhantomWallet | null>(null);

/** 页面等待 Phantom 授权的最长时间，以毫秒计。 Maximum time the page waits for Phantom approval, in milliseconds. */
const connectionTimeoutMs = 60_000;

/** 只在签名等待一段时间后查询过期，避免每一次正常签名增加 RPC 调用。 Start expiry checks after a grace period to avoid an extra RPC call during routine approvals. */
const firstApprovalCheckMs = 30_000;
/** Devnet 最终确认区块高度的轮询间隔和请求超时，以毫秒计。 Interval and per-request timeout for finalized Devnet block height, in milliseconds. */
const approvalCheckIntervalMs = 5_000;
const approvalCheckTimeoutMs = 8_000;

/**
 * 等待下一次区块高度查询，收到钱包结果时立即清理计时器。
 * Wait until the next block-height read, clearing the timer immediately when the wallet responds.
 *
 * @param intervalMs 等待时长，单位是毫秒。 Delay in milliseconds.
 * @param signal 钱包返回结果后触发的取消信号。 Signal aborted when the wallet returns.
 */
function waitForApprovalCheck(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    /** 清理计时与监听器，确保流程完成后不遗留轮询。 Clear the timer and listener so polling does not outlive the request. */
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }

    /** 本轮等待标识。 Timer for the current wait. */
    const timer = setTimeout(finish, intervalMs);
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 只有 Devnet 已最终确认的区块高度超过本交易的有效期，才结束未响应的审批等待。
 * Stop an unresponsive approval only once finalized Devnet block height exceeds this transaction's lifetime.
 *
 * @param lastValidBlockHeight 本交易 blockhash 允许被执行的最后区块高度。 Last block height at which the transaction blockhash can be processed.
 * @param minContextSlot 签名前模拟所用的最低观测位置。 Minimum context slot of the pre-sign simulation.
 * @param signal 交易返回结果后取消剩余查询。 Cancels remaining checks once the transaction returns.
 */
async function waitForApprovalExpiry(
  lastValidBlockHeight: number, minContextSlot: number, signal: AbortSignal,
): Promise<never> {
  await waitForApprovalCheck(firstApprovalCheckMs, signal);

  while (!signal.aborted) {
    /** 缺少有效 RPC 响应时继续等待，避免误判为过期并允许重复签名。 Keep waiting when a valid RPC response is unavailable so a retry cannot be enabled prematurely. */
    let blockHeight: unknown;
    try {
      const response = await fetch(devnetRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [{ commitment: 'finalized', minContextSlot }],
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(approvalCheckTimeoutMs)]),
      });
      if (response.ok) {
        /** 仅识别本次 RPC 请求返回的有效整数高度。 Accept only a valid integer height from this RPC response. */
        const payload: unknown = await response.json();
        if (typeof payload === 'object' && payload !== null && 'jsonrpc' in payload && payload.jsonrpc === '2.0'
          && 'id' in payload && payload.id === 1 && 'result' in payload && !('error' in payload)) {
          blockHeight = payload.result;
        }
      }
    } catch {
      // 网络超时、限流或临时故障都不能证明 blockhash 已过期。
      // A timeout, rate limit, or transient error cannot prove the blockhash has expired.
    }
    if (!signal.aborted && typeof blockHeight === 'number' && Number.isSafeInteger(blockHeight) && blockHeight > lastValidBlockHeight) {
      throw new WalletTransactionError('approvalExpired');
    }
    await waitForApprovalCheck(approvalCheckIntervalMs, signal);
  }
  throw signal.reason;
}

/**
 * 从页面取得 Phantom 官方注入的 Solana 接口，没有时返回空。
 * Find Phantom's injected Solana provider in the page, or return null when absent.
 */
function getPhantomProvider(): PhantomProvider | null {
  /** 浏览器扩展加到 window 上的可选属性。 Optional property added to window by the extension. */
  const { phantom, solana } = window as Window & { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  // 优先使用官方命名空间，兼容旧注入入口时也要核实 Phantom 标记。
  // Prefer the official namespace and verify the Phantom flag on the legacy injection as well.
  if (phantom?.solana?.isPhantom) return phantom.solana;
  return solana?.isPhantom ? solana : null;
}

/**
 * 将钱包返回或页面主动结束等待的原因转换成可本地化的提示键。
 * Map an error from Phantom or a stopped page wait to a localizable message key.
 * @param error 扩展抛出的错误。 Error thrown by the extension.
 */
function getConnectError(error: unknown): WalletError {
  if (error === 'connectTimeout' || error === 'connectCancelled') return error;

  /** Phantom 错误码，4001 表示拒绝，-32002 表示已有审批窗口占用资源时可以返回的错误。 Phantom error code: 4001 is rejection, and an occupied approval window can cause -32002. */
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 4001) return 'rejected';
  if (code === -32002) return 'approvalPending';
  return 'connectError';
}

/**
 * 为布局和业务页面共享当前钱包公钥，随 Phantom 的账户变化同步更新。
 * Share the wallet public key with the layout and business pages and track Phantom account changes.
 * @param props 需要读取钱包状态的 React 子树。 React subtree that may read the wallet state.
 */
export function PhantomWalletProvider({ children }: PropsWithChildren) {
  /** 用户选择连接后获取的扩展接口。 Extension provider obtained when the user chooses to connect. */
  const [activeProvider, setActiveProvider] = useState<PhantomProvider | null>(null);
  /** 当前已连接的 Base58 公钥。 Base58 public key of the connected account. */
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  /** 正在等待 Phantom 完成的操作。 Action currently awaiting Phantom. */
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  /** 最近一次钱包操作的错误。 Error from the latest wallet action. */
  const [error, setError] = useState<WalletError | null>(null);
  /** 当前授权尝试的页面等待控制器，同时防止快速重复点击。 Controller for the current page wait, also preventing rapid duplicate clicks. */
  const pendingApproval = useRef<AbortController | null>(null);
  /** 钱包弹窗完成前共享同一交易锁，切页时也阻止再开签名窗口。 Shared transaction lock that prevents opening another signing prompt even if the page changes. */
  const transactionApproval = useRef(false);

  /** Provider 卸载时清理页面等待，忽略钱包之后返回的结果。 Stop the page wait on unmount and ignore later wallet results. */
  useEffect(() => () => {
    /** 将要取消的授权尝试。 Approval attempt to stop. */
    const approval = pendingApproval.current;
    pendingApproval.current = null;
    approval?.abort('connectCancelled');
  }, []);

  /**
   * 订阅 Phantom 的账户与断开事件，并在 Provider 卸载时清理。
   * Subscribe to Phantom account and disconnect events and remove listeners on unmount.
   */
  useEffect(() => {
    if (!activeProvider) return;

    /**
     * 使用新账户公钥。切换到未授权账户时清空地址以停止旧仓位查询。
     * Use the new account key, clearing the address and old position query for an unauthorized account.
     * @param publicKey Phantom 当前分享的公钥，未授权时为空。 Public key shared by Phantom, or null if unauthorized.
     */
    function handleAccountChanged(publicKey: PhantomPublicKey | null) {
      setWalletAddress(publicKey?.toString() ?? null);
      setError(null);
    }

    /** 清除已断开的公钥。 Clear the disconnected public key. */
    function handleDisconnect() {
      setActiveProvider(null);
      setWalletAddress(null);
      setError(null);
    }

    activeProvider.on('accountChanged', handleAccountChanged);
    activeProvider.on('disconnect', handleDisconnect);

    /** 移除已注册的监听器。 Remove the registered listeners. */
    return () => {
      /** 使用扩展提供的监听移除方法并保留其调用对象。 Use the provider's available removal method with the correct receiver. */
      const detach = activeProvider.off?.bind(activeProvider) ?? activeProvider.removeListener?.bind(activeProvider);
      detach?.('accountChanged', handleAccountChanged);
      detach?.('disconnect', handleDisconnect);
    };
  }, [activeProvider]);

  /** 请求钱包公钥，限定页面等待时间，并且只采纳当前尝试的结果。 Request a wallet public key, bound the page wait, and accept only the current attempt's result. */
  async function connect() {
    if (pendingAction || pendingApproval.current) return;

    /** 用户点击连接时取得扩展接口。 Read the injected provider when the user clicks Connect. */
    const provider = getPhantomProvider();
    if (!provider) {
      /** 本地联调用 Phantom 支持的回环地址，部署使用 HTTPS。 Local development uses Phantom-supported loopback addresses and deployments use HTTPS. */
      const { protocol, hostname } = window.location;
      setError(protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' ? 'unavailable' : 'unsupportedOrigin');
      return;
    }

    /** 当前点击对应的等待凭据及超时定时器。 Wait controller and timer for this click. */
    const approval = new AbortController();
    pendingApproval.current = approval;
    const timeout = window.setTimeout(() => approval.abort('connectTimeout'), connectionTimeoutMs);
    /** 页面取消只中断本地等待。钱包是否关闭弹窗仍由 Phantom 决定。 Cancellation stops the local wait; Phantom decides whether its approval window closes. */
    const stoppedWaiting = new Promise<never>((_, reject) => {
      approval.signal.addEventListener('abort', () => reject(approval.signal.reason), { once: true });
    });

    // 授权成功后才订阅钱包事件，取消后的迟到结果不会激活账号。
    // Subscribe to wallet events only after approval so a late result cannot activate a cancelled account.
    setActiveProvider(null);
    setError(null);
    setPendingAction('connecting');
    try {
      /** 仅在当前等待窗口内接受 Phantom 返回的公开地址。 Accept the public key only within the current approval wait. */
      const { publicKey } = await Promise.race([provider.connect(), stoppedWaiting]);
      if (pendingApproval.current !== approval || approval.signal.aborted) return;
      setWalletAddress(publicKey.toString());
      setActiveProvider(provider);
    } catch (error) {
      if (pendingApproval.current === approval) setError(getConnectError(error));
    } finally {
      window.clearTimeout(timeout);
      if (pendingApproval.current === approval) {
        pendingApproval.current = null;
        setPendingAction(null);
      }
    }
  }

  /** 用户可以立即退出页面等待，迟到的授权结果不会更新钱包状态。 Let users stop waiting immediately without applying a late wallet approval. */
  function cancelConnect() {
    pendingApproval.current?.abort('connectCancelled');
  }

  /** 请求断开并清空公钥，令依赖它的页面停止显示该钱包数据。 Disconnect and clear the public key so pages stop showing that wallet's data. */
  async function disconnect() {
    if (pendingAction) return;

    if (!activeProvider) return;

    setError(null);
    setPendingAction('disconnecting');
    try {
      await activeProvider.disconnect();
      setActiveProvider(null);
      setWalletAddress(null);
    } catch {
      setError('disconnectError');
    } finally {
      setPendingAction(null);
    }
  }

  /**
   * 让当前 Phantom 账户确认构造好的交易，返回广播的签名。
   * Request approval for the built transaction from the current Phantom account and return its signature.
   *
   * @param transaction 已设置 fee payer 和 Devnet blockhash 的交易。 Transaction with a fee payer and a Devnet blockhash.
   * @param expectedWallet 建立预览时的钱包公钥。 Wallet public key bound to the preview.
   * @param minContextSlot 模拟和提交时不得落后的链上 slot。 Lowest acceptable chain context slot for preflight and submission.
   * @returns Phantom 返回的 Base58 交易签名，链上确认由业务模块检查。 Base58 signature returned by Phantom, with confirmation checked by the feature.
   */
  async function signAndSendTransaction(transaction: Transaction, expectedWallet: string, minContextSlot: number) {
    if (transactionApproval.current) throw new WalletTransactionError('approvalPending');

    // 送交签名前重新核对扩展当前地址，防止准备交易期间切换了账户。
    // Recheck the extension's current account before signing in case it changed while preparing the transaction.
    if (!activeProvider || pendingAction || walletAddress !== expectedWallet ||
        activeProvider.publicKey?.toString() !== expectedWallet || transaction.feePayer?.toBase58() !== expectedWallet) {
      throw new WalletTransactionError('walletChanged');
    }
    if (!activeProvider.signAndSendTransaction) throw new WalletTransactionError('submissionFailed');

    transactionApproval.current = true;
    /** 钱包返回签名或拒绝后停止检查区块高度。 Stop checking block height after Phantom responds or rejects. */
    const expiryCheck = new AbortController();
    try {
      /** 钱包签名请求始终只打开一次。全局锁保留至有结果或已证实原 blockhash 过期。 Open only one Phantom request and hold the lock until it returns or the original blockhash definitively expires. */
      const approval = activeProvider.signAndSendTransaction(transaction, {
        preflightCommitment: 'confirmed',
        minContextSlot,
      });
      const lastValidBlockHeight = transaction.lastValidBlockHeight;
      const { signature } = lastValidBlockHeight !== undefined
        ? await Promise.race([approval, waitForApprovalExpiry(lastValidBlockHeight, minContextSlot, expiryCheck.signal)])
        : await approval;
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
        throw new WalletTransactionError('submissionFailed');
      }
      return signature;
    } catch (error) {
      if (error instanceof WalletTransactionError) throw error;
      /** Phantom 的错误码帮助区分主动拒绝和已有钱包操作。 Phantom error codes distinguish rejection from another wallet request. */
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 4001) throw new WalletTransactionError('rejected', error);
      if (code === -32002) throw new WalletTransactionError('approvalPending', error);
      if (code === 4100) throw new WalletTransactionError('walletChanged', error);
      throw new WalletTransactionError('submissionFailed', error);
    } finally {
      expiryCheck.abort();
      transactionApproval.current = false;
    }
  }

  /** 等待状态优先显示，其他时候由当前公钥决定连接状态。 Show pending actions first and otherwise derive status from the public key. */
  const status = pendingAction ?? (walletAddress ? 'connected' : 'disconnected');

  return (
    <PhantomWalletContext.Provider value={{ walletAddress, status, error, connect, cancelConnect, disconnect, signAndSendTransaction }}>
      {children}
    </PhantomWalletContext.Provider>
  );
}

/** 获取布局与策略金库页共用的钱包状态。 Get the wallet state shared by the layout and strategy vault page. */
export function usePhantomWallet(): PhantomWallet {
  /** 应用入口提供的 Phantom 钱包状态。 Phantom wallet state provided by the app entry point. */
  const wallet = useContext(PhantomWalletContext);
  if (!wallet) throw new Error('usePhantomWallet requires PhantomWalletProvider.');

  return wallet;
}

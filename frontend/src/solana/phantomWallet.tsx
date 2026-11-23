import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';

/** Phantom 公钥序列化为 Base58 地址。 Phantom public key serializable as a Base58 address. */
type PhantomPublicKey = { toString(): string };

/** 页面连接或断开期间进行的操作。 Wallet action in progress on this page. */
type PendingAction = 'connecting' | 'disconnecting';

/** 对应 wallet 翻译组的连接错误键。 Connection error keys in the wallet translation group. */
type WalletError = 'unavailable' | 'connectError' | 'rejected' | 'disconnectError';

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
  /** 结束当前钱包连接。 End the current wallet connection. */
  disconnect(): Promise<void>;
}

/** 共享钱包状态的 React Context。 React context for the shared wallet state. */
const PhantomWalletContext = createContext<PhantomWallet | null>(null);

/**
 * 从页面取得 Phantom 官方注入的 Solana 接口，没有时返回空。
 * Find Phantom's injected Solana provider in the page, or return null when absent.
 */
function getPhantomProvider(): PhantomProvider | null {
  /** 浏览器扩展加到 window 上的可选属性。 Optional property added to window by the extension. */
  const { phantom } = window as Window & { phantom?: { solana?: PhantomProvider } };
  return phantom?.solana?.isPhantom ? phantom.solana : null;
}

/**
 * 将 Phantom 错误转换成可本地化的提示键，4001 表示用户取消授权。
 * Map Phantom errors to translatable UI keys; 4001 means the user rejected the request.
 * @param error 扩展抛出的错误。 Error thrown by the extension.
 */
function getConnectError(error: unknown): WalletError {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 4001
    ? 'rejected'
    : 'connectError';
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

  /** 调用 Phantom 请求钱包公钥，并将结果提供给业务页面。 Ask Phantom for the wallet public key and expose the result to business pages. */
  async function connect() {
    if (pendingAction) return;

    /** 用户点击连接时取得扩展接口。 Read the injected provider when the user clicks Connect. */
    const provider = getPhantomProvider();
    if (!provider) {
      setError('unavailable');
      return;
    }

    setActiveProvider(provider);
    setError(null);
    setPendingAction('connecting');
    try {
      /** Phantom 在授权后返回的账户公钥。 Account public key returned by Phantom after authorization. */
      const { publicKey } = await provider.connect();
      setWalletAddress(publicKey.toString());
    } catch (error) {
      setError(getConnectError(error));
    } finally {
      setPendingAction(null);
    }
  }

  /** 请求断开并清空公钥，令依赖它的页面停止显示该钱包数据。 Disconnect and clear the public key so pages stop showing that wallet's data. */
  async function disconnect() {
    if (pendingAction) return;

    if (!activeProvider) return;

    setError(null);
    setPendingAction('disconnecting');
    try {
      await activeProvider.disconnect();
      setWalletAddress(null);
    } catch {
      setError('disconnectError');
    } finally {
      setPendingAction(null);
    }
  }

  /** 等待状态优先显示，其他时候由当前公钥决定连接状态。 Show pending actions first and otherwise derive status from the public key. */
  const status = pendingAction ?? (walletAddress ? 'connected' : 'disconnected');

  return (
    <PhantomWalletContext.Provider value={{ walletAddress, status, error, connect, disconnect }}>
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

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { lendingLocation, LendingNavigation } from '../../features/lending/LendingNavigation';
import { isDevnetBorrowMarket, syncDevnetBorrow, useDevnetBorrowPosition } from '../../features/lending/useDevnetBorrowPosition';
import { useLendingMarket } from '../../features/lending/useLendingMarket';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import {
  BorrowOperationError, estimateBorrowDebtAfter, getBorrowOperationLimit, prepareBorrowOperation, waitForBorrowOperation, type BorrowOperation,
} from '../../solana/lending/borrowLendingPosition';
import { usePhantomWallet, WalletTransactionError } from '../../solana/phantomWallet';
import { BorrowLimitGuidance } from './BorrowLimitGuidance';
import './styles/lending-borrow-operation.css';

/** 路由动作与链上指令的映射，未知路径不产生交易。 Map route slugs to instructions so unknown routes cannot transact. */
const operationRoutes = [
  ['collateral', 'depositCollateral'], ['borrow', 'borrow'], ['repay', 'repay'], ['withdraw', 'withdrawCollateral'],
] as const satisfies readonly (readonly [string, BorrowOperation])[];

/** SPL Token 金额上限，单位为 Mint 的最小单位。 Maximum SPL Token amount, in mint base units. */
const maxTokenAmount = (1n << 64n) - 1n;
/** 回执所需的公开区块高度和发送时的最低 slot。 Public block height and minimum send slot needed to verify the receipt. */
type Lifetime = Pick<Awaited<ReturnType<typeof prepareBorrowOperation>>, 'lastValidBlockHeight' | 'minContextSlot'>;
/** 由最终确认事件核对的真实操作结果。 Actual result verified against the finalized event. */
type Receipt = Awaited<ReturnType<typeof waitForBorrowOperation>>;

/** Phantom 广播后保留的公开交易信息。 Public information retained after Phantom broadcasts. */
interface Pending {
  /** 用户签名的公开交易签名。 Public transaction signature from the user's wallet. */
  signature: string;
  /** 用户核对的动作金额，以对应 Mint 最小单位计。 Reviewed amount in the action's mint base units. */
  amountRaw: bigint;
  /** 交易有效期及发送上下文。 Transaction expiry and send context. */
  lifetime: Lifetime;
}

/** 金额核对绑定所读的 slot，并保留操作后的仓位预览。 A review binds the observed slot and stores the projected position. */
interface Review {
  /** 动作最小单位金额。 Action amount in base units. */
  amountRaw: bigint;
  /** 核对时的最终确认 slot。 Finalized slot used for the review. */
  slot: number;
  /** 预计抵押数量，以抵押 Mint 最小单位计。 Projected collateral in collateral mint base units. */
  collateralRaw: bigint;
  /** 预计债务，以借款 Mint 最小单位计。 Projected debt in debt mint base units. */
  debtRaw: bigint;
  /** 还款金额在审阅时是否为授权上限。 Whether the reviewed repayment amount is an authorization limit. */
  repaymentLimit: boolean;
}

/** 交易确认与仓位刷新独立重试，回执数据保留在确认之后。 Keep confirmation and refresh separate so they can be retried independently. */
type Attempt =
  | { status: 'idle' }
  // 页面切换后恢复正在校验或等待签名的金额核对。
  // Restore the in-flight review after navigation during preflight or wallet approval.
  | { status: 'preparing' | 'wallet'; review: Review }
  | { status: 'failed'; error: string; signature?: string }
  | { status: 'confirming' | 'confirmationUnknown' | 'receiptUnavailable'; pending: Pending }
  | { status: 'refreshing' | 'syncFailed' | 'complete'; pending: Pending; receipt: Receipt };

/** 单独动作页使用的市场和钱包配置。 Market and wallet context for one lending action. */
interface BorrowFormProps {
  /** 当前路由所选的动作。 Operation selected by the route. */
  operation: BorrowOperation;
  /** 已核对的 Devnet 市场目录。 Verified Devnet market registration. */
  market: LendingMarketListItem;
  /** 当前 Phantom 签名钱包公钥。 Current Phantom signer public key. */
  walletAddress: string;
  /** 按市场、动作、钱包隔离的交易作用域。 Attempt scope isolated by market, operation, and wallet. */
  scope: string;
}

/**
 * 将十进制金额准确转换成所选代币的最小单位。
 * Convert the decimal amount to exact base units of the selected mint.
 *
 * @param text 表单中的金额文本。 User-supplied amount text.
 * @param decimals 当前代币的小数位数。 Selected mint's fractional precision.
 * @returns 有效的正 u64 金额或空值。 Positive u64 amount, or null.
 */
function parseAmount(text: string, decimals: number): bigint | null {
  /** 限制输入形式和精度，拒绝浮点、指数和过长金额。 Bound the decimal text without converting it through floating point. */
  const match = /^([0-9]{0,20})(?:\.([0-9]*))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if ((!whole && !fraction) || fraction.length > decimals) return null;

  /** 将小数尾部补齐到代币精度，再读取整数最小单位。 Pad the fractional part to mint precision before reading integer base units. */
  const raw = BigInt((whole || '0') + fraction.padEnd(decimals, '0'));
  return raw > 0n && raw <= maxTokenAmount ? raw : null;
}

/**
 * 恢复当前交易作用域中未处理完的原始签名。
 * Restore the original unresolved signature for this transaction scope.
 *
 * @param key 当前网络、市场、动作和钱包的会话键。 Session key for this network, market, operation, and wallet.
 * @returns 验证后的公开交易参数或空值。 Validated public transaction information or undefined.
 */
function restorePending(key: string): Pending | undefined {
  try {
    /** 从会话存储读出的值需要校验，不能直接送给 RPC。 Validate session values before sending them to the RPC. */
    const data: Partial<Record<'signature' | 'amountRaw' | 'minContextSlot' | 'lastValidBlockHeight', unknown>> | null =
      JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (!data) return undefined;
    const { signature, amountRaw, minContextSlot, lastValidBlockHeight } = data;
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) ||
        typeof amountRaw !== 'string' || !/^[1-9][0-9]{0,19}$/.test(amountRaw) ||
        typeof minContextSlot !== 'number' || !Number.isSafeInteger(minContextSlot) || minContextSlot < 0 ||
        typeof lastValidBlockHeight !== 'number' || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
      return undefined;
    }
    /** 只接受指令可以编码的 u64 金额。 Accept only an amount encodable by the instruction's u64 argument. */
    const amount = BigInt(amountRaw);
    return amount <= maxTokenAmount
      ? { signature, amountRaw: amount, lifetime: { minContextSlot, lastValidBlockHeight } } : undefined;
  } catch {
    // 会话存储不可用时仍保留应用内查询缓存。
    // Keep the in-app query cache available when session storage is unavailable.
    return undefined;
  }
}

/**
 * 记录已广播的签名，只有同步完成或交易确定失败后才移除。
 * Record the broadcast signature until synchronization completes or the transaction definitively fails.
 *
 * @param key 当前动作与钱包的会话键。 Session key for the current operation and wallet.
 * @param pending 公开交易参数，省略时清除记录。 Public transaction data, or omitted to delete the entry.
 */
function storePending(key: string, pending?: Pending): void {
  try {
    if (!pending) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify({
      signature: pending.signature, amountRaw: pending.amountRaw.toString(), ...pending.lifetime,
    }));
  } catch {
    // 存储失败不能中断已广播的交易。
    // A storage failure cannot interrupt a transaction that was already broadcast.
  }
}

/** 根据路由显示追加抵押、借款、还款或取回抵押品页面。 Render the collateral deposit, borrowing, repayment, or collateral withdrawal page for the route. */
export function LendingBorrowOperationPage() {
  /** 根据动作路由、市场和 Phantom 地址确定交易作用域。 Use the action route, market, and Phantom address to determine transaction scope. */
  const { t } = useTranslation();
  const { action } = useParams<{ action: string }>();
  const [searchParams] = useSearchParams();
  const { network, selected, markets } = useLendingMarket();
  const wallet = usePhantomWallet();
  const operation = operationRoutes.find(([slug]) => slug === action)?.[1];
  const requestedMarket = searchParams.get('market');

  /** 无效市场不能静默回退到首个市场并签名。 An invalid explicit market must not silently fall back to the first market for signing. */
  const market = selected && isDevnetBorrowMarket(selected) &&
    (requestedMarket === null || requestedMarket === selected.address) ? selected : undefined;
  const walletAddress = wallet.status === 'connected' ? wallet.walletAddress : null;
  const scope = market && walletAddress && operation ? [
    market.network, market.address, market.programId, market.debtAsset.mint, market.debtAsset.decimals,
    market.collateralAsset.mint, market.collateralAsset.decimals, operation, walletAddress,
  ].join(':') : null;
  const operationKey = 'lendingBorrow.operations.' + operation;
  const backHref = lendingLocation(paths.borrow, network, market?.address ?? requestedMarket);

  useEffect(() => {
    // 每次进入新操作，让键盘和读屏用户从正文标题所在区域开始。
    // Start keyboard and screen-reader navigation at the main content for each new operation.
    window.scrollTo(0, 0);
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [operation]);

  return (
    <PageLayout
      title={t(operation ? operationKey + '.title' : 'pages.borrow.title')}
      description={t(operation ? operationKey + '.description' : 'lendingBorrow.unsupportedAction')}
    >
      <LendingNavigation marketAddress={market?.address ?? requestedMarket} />
      <Link className="text-link lending-borrow-operation__back" to={backHref}>{t('lendingBorrow.backToPosition')}</Link>
      {operation && network === 'devnet' && markets.isPending ? (
        <p role="status">{t('lendingPosition.marketLoading')}</p>
      ) : operation && network === 'devnet' && markets.isError && !markets.data ? (
        <div className="lending-borrow-operation__panel">
          <p role="alert">{t('lendingPosition.marketError')}</p>
          <button type="button" className="lending-borrow-operation__button" onClick={() => void markets.refetch()} disabled={markets.isFetching}>
            {t('lendingPosition.retry')}
          </button>
        </div>
      ) : !operation || !market ? (
        <p role="status">{t(operation ? 'lendingBorrow.unsupportedMarket' : 'lendingBorrow.unsupportedAction')}</p>
      ) : !walletAddress || !scope ? (
        <div className="lending-borrow-operation__panel">
          <p role="status">{t(wallet.status === 'connecting' ? 'wallet.connectHelp' : 'lendingBorrow.connectPrompt')}</p>
          {wallet.error && <p className="lending-borrow-operation__error" role="alert">{t('wallet.' + wallet.error)}</p>}
          <button type="button" className="lending-borrow-operation__button lending-borrow-operation__button--primary"
            onClick={() => void wallet.connect()} disabled={wallet.status !== 'disconnected'}>
            {t(wallet.status === 'connecting' ? 'wallet.connecting' : 'wallet.connect')}
          </button>
          {wallet.status === 'connecting' && (
            <button type="button" className="lending-borrow-operation__button" onClick={wallet.cancelConnect}>{t('wallet.cancelConnect')}</button>
          )}
        </div>
      ) : (
        <BorrowForm key={scope} scope={scope} operation={operation} market={market} walletAddress={walletAddress} />
      )}
    </PageLayout>
  );
}

/**
 * 核对金额、请求一次 Phantom 签名，再用实际回执同步链上仓位。
 * Review the amount, request one Phantom signature, and synchronize positions after verifying the receipt.
 *
 * @param props 交易绑定的市场、操作、钱包和缓存作用域。 Market, action, wallet, and cache scope bound to this transaction.
 */
function BorrowForm({ scope, operation, market, walletAddress }: BorrowFormProps) {
  /** 资金读链与交易同步使用同一缓存，签名复用应用的 Phantom 连接。 Chain reads and sync share one cache and signing uses the app's Phantom connection. */
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { signAndSendTransaction } = usePhantomWallet();
  const position = useDevnetBorrowPosition(market, walletAddress);

  /** 不同操作分别使用抵押 Mint 或借款 Mint 的精度显示金额。 Format amounts with the collateral or debt mint precision, according to the operation. */
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const isCollateral = operation === 'depositCollateral' || operation === 'withdrawCollateral';
  const collateralSymbol = market.collateralAsset.symbol || 'tSOL';
  const debtSymbol = market.debtAsset.symbol || 'mockUSDC';
  const symbol = isCollateral ? collateralSymbol : debtSymbol;
  const decimals = isCollateral ? market.collateralAsset.decimals : market.debtAsset.decimals;
  const operationKey = 'lendingBorrow.operations.' + operation;
  const positionHref = lendingLocation(paths.borrow, market.network, market.address);

  /** 操作前的输入留在表单，广播后的公开信息在当前标签页内可恢复。 Keep pre-signing input in the form and make broadcast data recoverable within the tab. */
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const storageKey = 'ggboy:lending-borrow:' + scope;
  /** 表单按作用域挂载，缓存键在本次打开期间保持稳定。
   * The form is keyed by scope, so the cache key stays stable for this visit. */
  const [attemptKey] = useState(() => ['lending-borrow-attempt', scope] as const);
  const { data: attempt } = useQuery<Attempt>({
    queryKey: attemptKey,
    queryFn: skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
    initialData: () => {
      /** 恢复后的操作必须核对同一个签名，防止重复广播。 A restored transaction must recheck its original signature to avoid a duplicate broadcast. */
      const pending = restorePending(storageKey);
      return pending ? { status: 'confirmationUnknown', pending } : { status: 'idle' };
    },
  });

  /** 表单卸载后，尚处预检的交易不得请求签名。 A transaction still in preflight cannot open a wallet prompt after the form unmounts. */
  const activeScope = useRef<string | null>(scope);
  useLayoutEffect(() => {
    activeScope.current = scope;
    // 重新打开时进入金额表单。仅重置已同步的成功结果，保留待签名、待确认与待同步交易。
    // Reopening starts at the amount form after a synced success. Keep approvals, confirmations, and syncs in progress.
    queryClient.setQueryData<Attempt>(attemptKey, (previous) =>
      previous?.status === 'complete' ? { status: 'idle' } : undefined);
    return () => { activeScope.current = null; };
  }, [attemptKey, queryClient, scope]);

  /** 使用当前链上仓位和钱包余额计算本次金额的上限，空值表示缺少有效定价。 Derive the amount limit from the observed position and balances, with null indicating unavailable pricing. */
  const observed = position.data;
  const limitRaw = observed ? getBorrowOperationLimit(observed, operation) : null;
  /** 已发出的签名优先决定流程阶段，直至得到明确结果。 A broadcast signature takes precedence in the workflow until a definitive result is available. */
  const editable = attempt?.status === 'idle' || (attempt?.status === 'failed' && !attempt.signature);
  const awaitingWallet = attempt?.status === 'preparing' || attempt?.status === 'wallet';
  const checking = attempt?.status === 'confirming' || attempt?.status === 'refreshing';
  const pending = attempt && 'pending' in attempt ? attempt.pending : undefined;
  const receipt = attempt && 'receipt' in attempt ? attempt.receipt : undefined;
  const signature = pending?.signature ?? (attempt?.status === 'failed' ? attempt.signature : undefined);
  /** 返回表单时，等待签名的状态和金额仍从同一条交易缓存恢复。 On remount, recover the approval state and amounts from the same cached attempt. */
  const activeReview = awaitingWallet ? attempt.review : review;
  const step = signature ? 'stepResult' : awaitingWallet || activeReview ? 'stepReview' : 'stepAmount';
  const displayed = receipt ?? activeReview;

  /**
   * 将结果写入发起交易时的缓存，切换钱包后仍能查看原交易结果。
   * Write results into the original transaction scope so it survives a wallet change.
   *
   * @param next 当前作用域的交易阶段。 State transition for this transaction scope.
   */
  function setAttempt(next: Attempt): void {
    queryClient.setQueryData(attemptKey, next);
  }

  /**
   * 使用已最终确认的回执 slot 刷新仓位与资金池。
   * Refresh the position and pool using the finalized receipt slot.
   *
   * @param submitted 已广播交易和有效期。 Broadcast transaction with its lifetime.
   * @param confirmed 核对过的链上事件回执。 Verified on-chain event receipt.
   */
  async function synchronize(submitted: Pending, confirmed: Receipt): Promise<void> {
    setAttempt({ status: 'refreshing', pending: submitted, receipt: confirmed });
    try {
      await syncDevnetBorrow(queryClient, market, walletAddress, confirmed.slot);
      storePending(storageKey);
      setAttempt({ status: 'complete', pending: submitted, receipt: confirmed });
    } catch {
      // 成交已经确定，保留回执并允许独立重试仓位同步。
      // Keep the verified result and allow position synchronization to be retried independently.
      setAttempt({ status: 'syncFailed', pending: submitted, receipt: confirmed });
    }
  }

  /**
   * 用原签名核对交易，只有确认失败或过期时才解除再次签名限制。
   * Verify the original signature and unblock a new submission only after definitive failure or expiry.
   *
   * @param submitted 原签名和核对过的最小单位金额。 Original signature and reviewed base-unit amount.
   */
  async function confirm(submitted: Pending): Promise<void> {
    setAttempt({ status: 'confirming', pending: submitted });
    try {
      /** 回执校验绑定当前市场、钱包、操作和金额。 Bind the receipt to the selected market, wallet, action, and amount. */
      const confirmed = await waitForBorrowOperation(submitted.signature, {
        market, walletAddress, operation, amountRaw: submitted.amountRaw,
      }, submitted.lifetime);
      await synchronize(submitted, confirmed);
    } catch (error) {
      /** RPC 暂时不能确定交易结果时，保留该次签名。 Preserve the original signature when the RPC cannot resolve the result. */
      const code = error instanceof BorrowOperationError ? error.code : 'confirmationUnknown';
      if (code === 'transactionFailed' || code === 'expired') {
        storePending(storageKey);
        setAttempt({ status: 'failed', error: code, signature: submitted.signature });
        return;
      }
      setAttempt({ status: code === 'receiptUnavailable' ? 'receiptUnavailable' : 'confirmationUnknown', pending: submitted });
    }
  }

  /**
   * 读取整数金额，使用同一观测预览操作后的锁定抵押品与债务。
   * Parse an exact amount and project locked collateral and debt from the same observation.
   *
   * @param event 金额表单的提交事件。 Amount form submission event.
   */
  function reviewAmount(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!observed || !editable || position.isError || limitRaw === null) return;

    /** 金额不得超过同一观测确定的余额或业务上限。 The amount cannot exceed the wallet balance or operation limit from the same observation. */
    const amountRaw = parseAmount(amount, decimals);
    if (amountRaw === null || amountRaw > limitRaw) {
      setAttempt({ status: 'failed', error: amountRaw === null ? 'invalidAmount' : 'exceedsLimit' });
      return;
    }

    /** 只调整本次动作影响的抵押或债务，最小单位保留整数精度。 Apply the change only to the affected collateral or debt, preserving exact base units. */
    const collateralDelta = operation === 'depositCollateral' ? amountRaw : operation === 'withdrawCollateral' ? -amountRaw : 0n;
    setReview({
      amountRaw,
      slot: observed.slot,
      collateralRaw: observed.collateralRaw + collateralDelta,
      debtRaw: estimateBorrowDebtAfter(observed, operation, amountRaw),
      repaymentLimit: operation === 'repay' && observed.interestEnabled,
    });
    setAttempt({ status: 'idle' });
  }

  /** 模拟已核对的操作，并在确认当前作用域后请求 Phantom 签名。 Simulate the reviewed operation and recheck scope before requesting a Phantom signature. */
  async function submit(): Promise<void> {
    // 直接检查缓存锁，防止双击在 React 刷新按钮状态前发出第二次请求。
    // Check the cache lock so a second click cannot race the React button update.
    if (!review || position.isError || queryClient.getQueryData<Attempt>(attemptKey)?.status !== 'idle') return;

    setAttempt({ status: 'preparing', review });
    try {
      /** 预检重新读取实际限额，观测不能早于用户核对时的 slot。 Preflight refreshes actual limits at or after the user's reviewed slot. */
      const prepared = await prepareBorrowOperation({
        market, walletAddress, operation, amountRaw: review.amountRaw, minContextSlot: review.slot,
      });
      if (activeScope.current !== scope) {
        setAttempt({ status: 'idle' });
        return;
      }

      setAttempt({ status: 'wallet', review });
      /** Phantom 桥再次检查活动钱包和发出交易时的 RPC 上下文。 The Phantom bridge rechecks the active wallet and sends with the preflight RPC context. */
      const signature = await signAndSendTransaction(prepared.transaction, walletAddress, prepared.minContextSlot);
      const submitted: Pending = {
        signature, amountRaw: review.amountRaw,
        lifetime: { minContextSlot: prepared.minContextSlot, lastValidBlockHeight: prepared.lastValidBlockHeight },
      };
      storePending(storageKey, submitted);
      await confirm(submitted);
    } catch (error) {
      /** 预检或钱包返回错误后恢复金额表单，给过期或未知提交提供单独提示。 Restore the amount form on preflight or wallet errors and explain expired or ambiguous submissions. */
      const code = error instanceof BorrowOperationError || error instanceof WalletTransactionError ? error.code : 'preparationFailed';
      setReview(null);
      setAttempt({ status: 'failed', error: code });
      if (code !== 'rejected' && code !== 'approvalPending') void position.refetch();
    }
  }

  /** 回执核对与仓位同步的重试只使用同一个交易，不重新广播。 Receipt and synchronization retries reuse the same transaction and never broadcast again. */
  function retryReceipt(): void {
    const current = queryClient.getQueryData<Attempt>(attemptKey);
    if (current?.status === 'confirmationUnknown' || current?.status === 'receiptUnavailable') {
      void confirm(current.pending);
    } else if (current?.status === 'syncFailed') {
      void synchronize(current.pending, current.receipt);
    }
  }

  return (
    <section className="lending-borrow-operation" aria-labelledby="borrow-operation-step">
      <div className="lending-borrow-operation__panel" aria-busy={attempt?.status === 'preparing' || checking}>
        <h2 id="borrow-operation-step">{t('lendingBorrow.' + step)}</h2>
        {editable && !review && (
          position.isError ? (
            <>
              <p role="alert" className="lending-borrow-operation__error">{t('lendingPosition.error')}</p>
              <button type="button" className="lending-borrow-operation__button" onClick={() => void position.refetch()} disabled={position.isFetching}>
                {t('lendingPosition.retry')}
              </button>
            </>
          ) : !observed ? <p role="status">{t('lendingPosition.loading')}</p> : (
            <form className="lending-borrow-operation__form" onSubmit={reviewAmount}>
              <label htmlFor="borrow-operation-amount">{t('lendingBorrow.amount', { symbol })}</label>
              <div className="lending-borrow-operation__row">
                <input id="borrow-operation-amount" inputMode="decimal" autoComplete="off" maxLength={40}
                  aria-describedby="borrow-operation-limit" value={amount}
                  onChange={(event) => { setAmount(event.target.value); setAttempt({ status: 'idle' }); }} />
                <button type="button" className="lending-borrow-operation__button" disabled={limitRaw === null || limitRaw === 0n}
                  onClick={() => {
                    if (limitRaw !== null) setAmount(formatTokenAmount(limitRaw, decimals, 'en-US').replaceAll(',', ''));
                    setAttempt({ status: 'idle' });
                  }}>
                  {t('lendingBorrow.max')}
                </button>
              </div>
              <p id="borrow-operation-limit">
                {limitRaw === null ? t(observed.priceStatus === 'stale' ? 'lendingBorrow.priceStale' : 'lendingBorrow.priceMissing')
                  : t(operationKey + '.limit', { amount: formatTokenAmount(limitRaw, decimals, locale), symbol })}
              </p>
              {limitRaw === 0n && operation === 'borrow' && <BorrowLimitGuidance observation={observed} market={market} />}
              {limitRaw === 0n && operation === 'depositCollateral' && observed.collateralRaw > 0n && (
                <p>{t(observed.debtRaw > 0n
                  ? 'lendingBorrow.limitGuidance.alreadyLockedWithDebt'
                  : 'lendingBorrow.limitGuidance.alreadyLocked', {
                  amount: formatTokenAmount(observed.collateralRaw, decimals, locale), symbol,
                })}</p>
              )}
              {limitRaw === 0n && operation !== 'borrow' &&
                (operation !== 'depositCollateral' || observed.collateralRaw === 0n) && <p>{t(operationKey + '.zero')}</p>}
              <button type="submit" className="lending-borrow-operation__button lending-borrow-operation__button--primary"
                disabled={!amount.trim() || limitRaw === null || limitRaw === 0n}>
                {t('lendingBorrow.review')}
              </button>
            </form>
          )
        )}

        {receipt && <p role="status" className="lending-borrow-operation__success">{t('lendingBorrow.confirmed')}</p>}
        {displayed && (step === 'stepReview' || receipt) && (
          <dl className="lending-borrow-operation__summary">
            <dt>{t(receipt ? 'lendingBorrow.actualAmount'
              : activeReview?.repaymentLimit ? 'lendingBorrow.reviewedRepayLimit' : 'lendingBorrow.reviewedAmount')}</dt>
            <dd>{formatTokenAmount(displayed.amountRaw, decimals, locale)} {symbol}</dd>
            <dt>{t(receipt ? 'lendingBorrow.resultCollateral' : 'lendingBorrow.projectedCollateral')}</dt>
            <dd>{formatTokenAmount(displayed.collateralRaw, market.collateralAsset.decimals, locale)} {collateralSymbol}</dd>
            <dt>{t(receipt ? 'lendingBorrow.resultDebt' : 'lendingBorrow.projectedDebt')}</dt>
            <dd>{formatTokenAmount(displayed.debtRaw, market.debtAsset.decimals, locale)} {debtSymbol}</dd>
          </dl>
        )}
        {step === 'stepReview' && !receipt && activeReview?.repaymentLimit && <p>{t('lendingBorrow.repayInterestNote')}</p>}

        {/* 状态提示独立于组件内的表单草稿，返回页面也能了解如何继续签名。 */}
        {/* Show approval progress without depending on a local draft so it stays visible after returning. */}
        {awaitingWallet && <p role="status">{t(attempt.status === 'preparing' ? 'lendingBorrow.preparing' : 'lendingBorrow.walletApproval')}</p>}
        {attempt?.status === 'wallet' && <p>{t('lendingBorrow.walletApprovalHelp')}</p>}

        {step === 'stepReview' && review && !awaitingWallet && (
          <>
            {position.isError && <p role="alert" className="lending-borrow-operation__error">{t('lendingPosition.error')}</p>}
            <div className="lending-borrow-operation__row">
              <button type="button" className="lending-borrow-operation__button" onClick={() => setReview(null)}>
                {t('lendingBorrow.edit')}
              </button>
              <button type="button" className="lending-borrow-operation__button lending-borrow-operation__button--primary"
                disabled={position.isError} onClick={() => void submit()}>
                {t('lendingBorrow.sign')}
              </button>
            </div>
          </>
        )}

        {attempt?.status === 'failed' && (
          <p className="lending-borrow-operation__error" role="alert">
            {t('lendingBorrow.errors.' + attempt.error, { decimals })}
          </p>
        )}
        {pending && !receipt && (
          <>
            <p role="status">{t('lendingBorrow.' + (attempt?.status === 'receiptUnavailable' ? 'receiptUnavailable'
              : attempt?.status === 'confirmationUnknown' ? 'confirmationUnknown' : 'confirming'))}</p>
            {!checking && <button type="button" className="lending-borrow-operation__button" onClick={retryReceipt}>{t('lendingBorrow.recheck')}</button>}
          </>
        )}
        {attempt?.status === 'refreshing' && <p role="status">{t('lendingBorrow.synchronizing')}</p>}
        {attempt?.status === 'syncFailed' && (
          <>
            <p className="lending-borrow-operation__error" role="alert">{t('lendingBorrow.syncFailed')}</p>
            <button type="button" className="lending-borrow-operation__button" onClick={retryReceipt}>{t('lendingBorrow.retrySync')}</button>
          </>
        )}
        {signature && (
          <div className="lending-borrow-operation__row">
            <a className="text-link" href={'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + '?cluster=devnet'}
              target="_blank" rel="noreferrer">{t('lendingBorrow.explorer')}</a>
            {attempt?.status === 'complete' && <Link className="text-link" to={positionHref}>{t('pages.borrow.title')}</Link>}
            {(attempt?.status === 'complete' || attempt?.status === 'failed') && (
              <button type="button" className="lending-borrow-operation__button"
                onClick={() => { setAmount(''); setReview(null); setAttempt({ status: 'idle' }); }}>
                {t('lendingBorrow.returnToAmount')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

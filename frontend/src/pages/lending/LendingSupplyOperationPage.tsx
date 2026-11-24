import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { lendingLocation, LendingNavigation } from '../../features/lending/LendingNavigation';
import { isDevnetSupplyMarket, syncDevnetSupply, useDevnetSupplyPosition } from '../../features/lending/useDevnetSupplyPosition';
import { useLendingMarket } from '../../features/lending/useLendingMarket';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { formatCashVaultInput, maxCashVaultTokenAmount, parseCashVaultAmount } from '../../features/vault/cashVaultAmounts';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { paths } from '../../shared/navigation/paths';
import { PageLayout } from '../../shared/ui/PageLayout';
import {
  LendingSupplyError,
  prepareLendingSupply,
  quoteLendingSupply,
  quoteLendingSupplyWithdrawal,
  waitForLendingSupply,
  type LendingSupplyAction,
  type LendingSupplyLifetime,
  type LendingSupplyReceipt,
} from '../../solana/lending/supplyLendingPool';
import { lendingShareDecimals } from '../../solana/lending/devnetLendingPool';
import { getSupplyWithdrawalLimit } from '../../solana/lending/supplyWithdrawalAmounts';
import { usePhantomWallet, WalletTransactionError } from '../../solana/phantomWallet';
import './styles/lending-supply-operation.css';

/** 用户明确核对的精确输入和最低到账。 Exact input and minimum output acknowledged by the user. */
interface SupplyReview {
  /** 存入金额或提取最低到账金额，按借款代币最小单位计。 Exact deposit or minimum withdrawal payout, in debt token base units. */
  assetsRaw: bigint;
  /** 出借最低份额或提取扣减份额，按出借份额最小单位计。 Minimum supply shares or exact withdrawal shares, in share base units. */
  sharesRaw: bigint;
}

/** 已提交到 Devnet 的请求，可用同一个签名重新查询。 A request already submitted to Devnet, recoverable by the same signature. */
interface PendingSupply extends SupplyReview {
  /** Phantom 广播后返回的公共交易签名。 Public transaction signature returned by Phantom after broadcast. */
  signature: string;
  /** 用来从 RPC 验证确认或过期的交易有效期。 Transaction lifetime used to verify confirmation or expiration through RPC. */
  lifetime: LendingSupplyLifetime;
}

/** 不同阶段拥有各自已知的数据，链上回执与界面同步分开保存。 Each stage holds only its known data, with the receipt separate from UI synchronization. */
type SupplyAttempt =
  | { status: 'idle' }
  | { status: 'preparing' | 'wallet'; review: SupplyReview }
  | { status: 'failed'; error: string; signature?: string }
  | { status: 'confirming' | 'confirmationUnknown' | 'receiptUnavailable'; pending: PendingSupply }
  | { status: 'refreshing' | 'syncFailed' | 'complete'; pending: PendingSupply; receipt: LendingSupplyReceipt };

/** 只有已连接并核对的 Devnet 钱包和市场可以显示出借表单。 Only a connected wallet and verified Devnet market may render the supply form. */
interface SupplyFormProps {
  /** 入池和提取分别使用独立的交易记录。 Deposits and withdrawals use separate transaction records. */
  action: LendingSupplyAction;
  /** 同一市场、钱包和操作需要保持稳定的缓存作用域。 Stable cache scope for this market, wallet and action. */
  scope: string;
  /** 借贷目录和路由确认使用的 Devnet 市场。 Devnet market selected by both the registry and route. */
  market: LendingMarketListItem;
  /** 已连接 Phantom 当前公开地址。 Current public address shared by the connected Phantom wallet. */
  walletAddress: string;
}

/**
 * 从当前标签页恢复已广播的签名和公开的交易参数。
 * Restore the broadcast signature and public transaction parameters from the current tab.
 *
 * @param key 包含网络、市场和钱包的浏览器存储键。 Browser storage key scoped by network, market, and wallet.
 * @returns 可以继续核对的同一笔交易，找不到有效记录时返回空。 The same transaction to recheck, or undefined if no record is valid.
 */
function restorePendingSupply(key: string): PendingSupply | undefined {
  try {
    /** 浏览器存储只包含普通 JSON，使用前逐个验证字段。 Browser storage contains plain JSON; validate each field before using it. */
    const saved: Partial<Record<'signature' | 'assetsRaw' | 'minSharesRaw' | 'minContextSlot' | 'lastValidBlockHeight', unknown>> | null =
      JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (!saved) return undefined;

    /** 最小单位转为 BigInt 之前校验字符串长度，slot 和区块高度使用安全整数。 Bound base-unit strings before BigInt conversion and require safe integer slots and block heights. */
    const { signature, assetsRaw, minSharesRaw, minContextSlot, lastValidBlockHeight } = saved;
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) ||
        typeof assetsRaw !== 'string' || !/^[1-9]\d{0,19}$/.test(assetsRaw) ||
        typeof minSharesRaw !== 'string' || !/^[1-9]\d{0,19}$/.test(minSharesRaw) ||
        typeof minContextSlot !== 'number' || !Number.isSafeInteger(minContextSlot) || minContextSlot < 0 ||
        typeof lastValidBlockHeight !== 'number' || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
      return undefined;
    }

    /** 检查链上无符号 64 位整数上限。 Check the chain's unsigned 64-bit integer upper bound. */
    const assets = BigInt(assetsRaw);
    const minimum = BigInt(minSharesRaw);
    if (assets > maxCashVaultTokenAmount || minimum > maxCashVaultTokenAmount) return undefined;

    return { signature, assetsRaw: assets, sharesRaw: minimum, lifetime: { minContextSlot, lastValidBlockHeight } };
  } catch {
    // 浏览器禁用存储时，仍可用 Query 缓存在页面之间保留签名。
    // If browser storage is disabled, the Query cache still retains the signature across routes.
    return undefined;
  }
}

/**
 * 保留已提交交易，直到回执和仓位同步完成或交易确认失败。
 * Retain the submitted transaction until receipt and position synchronization complete or the transaction definitively fails.
 *
 * @param key 包含当前出借作用域的浏览器存储键。 Browser storage key scoped to the current supply.
 * @param pending 已广播的公开参数；空值清除记录。 Public broadcast data, or no value to clear the record.
 */
function savePendingSupply(key: string, pending?: PendingSupply): void {
  try {
    if (!pending) {
      window.sessionStorage.removeItem(key);
      return;
    }

    window.sessionStorage.setItem(key, JSON.stringify({
      signature: pending.signature,
      assetsRaw: pending.assetsRaw.toString(),
      // 保持已广播存入交易使用的原有存储字段，提取使用单独的会话键。
      // Keep the original deposit storage field for broadcast transactions; withdrawals have a separate session key.
      minSharesRaw: pending.sharesRaw.toString(),
      ...pending.lifetime,
    }));
  } catch {
    // 存储仅用于刷新恢复，RPC 确认流程继续运行。
    // Storage is for reload recovery only; RPC confirmation still runs.
  }
}

/**
 * 为入池或提取路由提供输入、钱包审核和链上结果。
 * Provide amount entry, wallet approval, and on-chain results for each supply operation route.
 *
 * @param props 由路由选择的出借或提取操作。 Supply action selected by the route.
 */
export function LendingSupplyOperationPage({ action = 'deposit' }: { action?: LendingSupplyAction }) {
  /** 读取用户当前面向的市场、网络和钱包。 Read the market, network, and wallet currently selected by the user. */
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { selected, network, markets } = useLendingMarket();
  const wallet = usePhantomWallet();
  const requestedMarket = searchParams.get('market');
  /** 独立操作名称与回退链接，钱包连接错误和读链状态复用出借文案。 Action-specific heading and return path, with shared wallet and read errors. */
  const withdrawing = action === 'withdraw';
  const copy = withdrawing ? 'lendingSupplyWithdrawal' : 'lendingSupply';

  /** 错误直达链接不能静默用目录首项发出交易。 An invalid direct link must not silently transact against the first market. */
  const supportedMarket = network === 'devnet' && isDevnetSupplyMarket(selected)
    && (requestedMarket === null || requestedMarket === selected.address) ? selected : undefined;
  const walletAddress = wallet.status === 'connected' ? wallet.walletAddress : null;
  /** 报价只属于一个市场和钱包，市场登记的币种或精度变化时也需要重新确认。 A quote belongs to one market and wallet; registry asset or precision changes require a fresh review. */
  const scope = supportedMarket && walletAddress ? [
    network, supportedMarket.address, supportedMarket.programId, supportedMarket.debtAsset.mint,
    supportedMarket.collateralAsset.mint, supportedMarket.debtAsset.decimals, supportedMarket.collateralAsset.decimals, walletAddress,
  ].join(':') + (withdrawing ? ':withdraw' : '') : null;

  useEffect(() => {
    // 页面切换后让键盘和读屏用户从正文开始。
    // Start at the main landmark after navigation for keyboard and screen reader users.
    window.scrollTo(0, 0);
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [action]);

  return (
    <PageLayout title={t(copy + '.title')} description={t(copy + '.description')}>
      <LendingNavigation marketAddress={supportedMarket?.address ?? requestedMarket} />
      <p className="lending-supply__back">
        <Link className="text-link" to={lendingLocation(withdrawing ? paths.supply : paths.lending, network, supportedMarket?.address)}>
          <span aria-hidden="true">‹</span> {t(withdrawing ? 'pages.supply.title' : 'lending.overview')}
        </Link>
      </p>

      {network === 'devnet' && markets.isPending ? (
        <p role="status">{t('lendingSupply.marketLoading')}</p>
      ) : network === 'devnet' && markets.isError && !markets.data ? (
        <div className="lending-supply__card">
          <p role="alert">{t('lendingSupply.marketError')}</p>
          <button className="lending-supply__button" type="button" onClick={() => void markets.refetch()} disabled={markets.isFetching}>
            {t('lendingSupply.retry')}
          </button>
        </div>
      ) : !supportedMarket ? (
        <p role="status">{t(copy + '.unsupported')}</p>
      ) : !walletAddress || !scope ? (
        <div className="lending-supply__card">
          <p role="status">{t(wallet.status === 'connecting' ? 'wallet.connectHelp' : copy + '.connectPrompt')}</p>
          {wallet.error && <p className="lending-supply__error" role="alert">{t('wallet.' + wallet.error)}</p>}
          <button
            className="lending-supply__button lending-supply__button--primary"
            type="button"
            onClick={() => void wallet.connect()}
            disabled={wallet.status !== 'disconnected'}
          >
            {t(wallet.status === 'connecting' ? 'wallet.connecting' : 'wallet.connect')}
          </button>
          {wallet.status === 'connecting' && (
            <button className="lending-supply__button" type="button" onClick={wallet.cancelConnect}>{t('wallet.cancelConnect')}</button>
          )}
        </div>
      ) : (
        <SupplyForm key={scope} scope={scope} market={supportedMarket} walletAddress={walletAddress} action={action} />
      )}
    </PageLayout>
  );
}

/**
 * 按同一钱包与市场管理审核、单次签名、结果确认和仓位同步。
 * Manage review, one signature, receipt confirmation, and position synchronization for one wallet and market.
 *
 * @param props 本笔出借所绑定的市场、钱包和缓存键。 Market, wallet, and cache key bound to this supply.
 */
function SupplyForm({ scope, market, walletAddress, action }: SupplyFormProps) {
  /** 保持金额显示、钱包签名与仓位读取使用当前语言和连接。 Use the active locale and connection for amount displays, signing, and position reads. */
  const { t, i18n } = useTranslation();
  const { signAndSendTransaction } = usePhantomWallet();
  const queryClient = useQueryClient();
  const position = useDevnetSupplyPosition(market, walletAddress);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const assetDecimals = market.debtAsset.decimals;
  /** 提取输入为份额，页面的资产到账仍按借款 Mint 精度显示。 Withdrawals take share inputs while asset payouts use the debt mint precision. */
  const withdrawing = action === 'withdraw';
  const copy = withdrawing ? 'lendingSupplyWithdrawal' : 'lendingSupply';
  const debtSymbol = market.debtAsset.symbol || 'mockUSDC';

  /** 用户输入和确认前的报价只留在当前表单。 Input and pre-signing quote stay with the current form. */
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<SupplyReview | null>(null);

  /** 缓存让同一标签的路由切换保留进行中的交易，刷新后从会话存储恢复签名。 Cache preserves in-flight transactions across routes; session storage recovers their signatures after reload. */
  const storageKey = 'ggboy:lending-supply:' + scope;
  const attemptKey = useMemo(() => ['lending-supply-attempt', scope] as const, [scope]);
  const { data: attempt } = useQuery<SupplyAttempt>({
    queryKey: attemptKey,
    queryFn: skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
    initialData: () => {
      /** 恢复后的表单应从核对原签名开始。 A restored form starts by rechecking the original signature. */
      const pending = restorePendingSupply(storageKey);
      return pending ? { status: 'confirmationUnknown', pending } : { status: 'idle' };
    },
  });

  /** 组件离开或作用域变更后，尚未发出的交易不再弹出签名。 A component that has left or changed scope must not start another signing prompt. */
  const activeScope = useRef<string | null>(scope);
  useLayoutEffect(() => {
    activeScope.current = scope;
    // 重新从「我的出借」进入可开始新操作，仍保留所有待签名、待确认及待同步交易。
    // Reopening from My Supply starts afresh after completion while preserving any pending approval, confirmation or sync.
    queryClient.setQueryData<SupplyAttempt>(attemptKey, (previous) =>
      previous?.status === 'complete' ? { status: 'idle' } : undefined);
    return () => { activeScope.current = null; };
  }, [attemptKey, queryClient, scope]);

  /**
   * 保存本次交易状态，异步结果始终使用交易发起时的键。
   * Store the current attempt under the key captured when the transaction began.
   *
   * @param next 这个作用域中的新状态。 Next state for this scope.
   */
  function setAttempt(next: SupplyAttempt) {
    queryClient.setQueryData(attemptKey, next);
  }

  /**
   * 使用事件所在的最终确认 slot 刷新资金池和钱包出借仓位。
   * Refresh the pool and wallet supply position at or after the event's finalized slot.
   *
   * @param pending 已广播的原始交易。 Original broadcast transaction.
   * @param receipt 已校验的事件金额、份额和 slot。 Verified event amount, shares, and slot.
   */
  async function synchronize(pending: PendingSupply, receipt: LendingSupplyReceipt) {
    /** 同一笔已验证交易才能再次同步，连续点击时复用已经开始的读取。 Only this verified transaction may retry sync; repeated clicks keep the read already in progress. */
    const current = queryClient.getQueryData<SupplyAttempt>(attemptKey);
    if ((current?.status !== 'confirming' && current?.status !== 'syncFailed') || current.pending.signature !== pending.signature) return;

    setAttempt({ status: 'refreshing', pending, receipt });
    try {
      await syncDevnetSupply(queryClient, market, walletAddress, receipt.slot, action);
      savePendingSupply(storageKey);
      setAttempt({ status: 'complete', pending, receipt });
    } catch {
      setAttempt({ status: 'syncFailed', pending, receipt });
    }
  }

  /**
   * 使用原签名核对实际成交；状态不明时，只允许重新核对这笔交易。
   * Verify execution using the original signature, allowing only this transaction to be rechecked when its status is unknown.
   *
   * @param pending 用于确认和核对链上事件的原交易。 Original transaction whose confirmation and event must be checked.
   */
  async function confirm(pending: PendingSupply) {
    /** 新签名只能由当前待授权流程确认，查询重试必须使用已经保存的签名。 Confirm new signatures only from wallet approval and recheck only the already stored signature. */
    const current = queryClient.getQueryData<SupplyAttempt>(attemptKey);
    if (current?.status !== 'wallet' && (
      (current?.status !== 'confirmationUnknown' && current?.status !== 'receiptUnavailable') ||
      current.pending.signature !== pending.signature
    )) return;

    setAttempt({ status: 'confirming', pending });
    try {
      /** 回执解析验证原始市场、钱包、精确输入及最低到账。 Receipt parsing verifies the original market, wallet, exact input and minimum output. */
      const receipt = await waitForLendingSupply(pending.signature, {
        action,
        market,
        walletAddress,
        assetsRaw: pending.assetsRaw,
        sharesRaw: pending.sharesRaw,
      }, pending.lifetime);
      await synchronize(pending, receipt);
    } catch (error) {
      /** 只在链上确定失败或确定过期时解除再次签名限制。 Permit another signature only after definitive on-chain failure or expiry. */
      const code = error instanceof LendingSupplyError ? error.code : 'confirmationUnknown';
      if (code === 'transactionFailed' || code === 'expired') {
        savePendingSupply(storageKey);
        setAttempt({ status: 'failed', error: code, signature: pending.signature });
        return;
      }
      setAttempt({ status: code === 'receiptUnavailable' ? 'receiptUnavailable' : 'confirmationUnknown', pending });
    }
  }

  /**
   * 根据当前链上钱包余额和资金池状态生成审核页对应的整数金额。
   * Generate exact review amounts from the current on-chain wallet balance and pool state.
   *
   * @param event 金额表单的提交事件。 Amount form submission.
   */
  function reviewSupply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!position.data || position.isError || !editable) return;

    /** mockUSDC 和出借份额均为六位小数，按无符号整数解析输入。 Both mockUSDC and supply shares use six decimals, so parse input as an exact unsigned integer. */
    const amountRaw = parseCashVaultAmount(amount);
    if (amountRaw === null) {
      setAttempt({ status: 'failed', error: 'invalidAmount' });
      return;
    }

    try {
      /** 向下取整的报价是最低到账，签名后由链上重新校验。 The floor-rounded quote is the minimum output and is checked on-chain after signing. */
      setReview(withdrawing
        ? { sharesRaw: amountRaw, assetsRaw: quoteLendingSupplyWithdrawal(position.data, amountRaw) }
        : { assetsRaw: amountRaw, sharesRaw: quoteLendingSupply(position.data, amountRaw) });
      setAttempt({ status: 'idle' });
    } catch (error) {
      setAttempt({ status: 'failed', error: error instanceof LendingSupplyError ? error.code : 'preparationFailed' });
    }
  }

  /**
   * 以已核对的金额构造交易，并确认当前页面仍使用原钱包和市场再唤起 Phantom。
   * Build the reviewed transaction and check the active wallet and market scope before opening Phantom.
   */
  async function submitSupply() {
    /** 直接读取缓存防止快速双击绕过 React 本轮渲染的按钮状态。 Read the cache directly so a fast double-click cannot bypass the rendered button state. */
    const current = queryClient.getQueryData<SupplyAttempt>(attemptKey);
    if (!review || !position.data || position.isError || current?.status !== 'idle') return;

    setAttempt({ status: 'preparing', review });
    try {
      /** 重读链上余额和报价，使用审核时已看到的数据 slot 作为下限。 Re-read balances and the quote with the reviewed data's slot as its context floor. */
      const prepared = await prepareLendingSupply({ action, market, walletAddress, ...review, minContextSlot: position.data.slot });
      if (activeScope.current !== scope) {
        setAttempt({ status: 'idle' });
        return;
      }

      setAttempt({ status: 'wallet', review });
      /** Phantom 在请求签名时再次检查实际活动账户，并按 Devnet 上下文广播。 Phantom rechecks its active account before signing and sends with a Devnet context floor. */
      const signature = await signAndSendTransaction(prepared.transaction, walletAddress, prepared.minContextSlot);
      /** 收到签名后就保存，即使用户已经离开原市场也能恢复和核对。 Persist the signature immediately so it remains recoverable after leaving the market. */
      const pending: PendingSupply = {
        ...review,
        signature,
        lifetime: { minContextSlot: prepared.minContextSlot, lastValidBlockHeight: prepared.lastValidBlockHeight },
      };
      savePendingSupply(storageKey, pending);
      await confirm(pending);
    } catch (error) {
      /** 只有未拿到交易签名的错误会回到金额审核。 Only failures without a transaction signature return to amount review. */
      const errorKey = error instanceof LendingSupplyError || error instanceof WalletTransactionError ? error.code : 'preparationFailed';
      setReview(null);
      setAttempt({ status: 'failed', error: errorKey });
      if (['quoteChanged', 'insufficientAsset', 'insufficientShares', 'insufficientLiquidity', 'frozenDestination'].includes(errorKey)) {
        void position.refetch();
      }
    }
  }

  /** 操作阶段和链接由当前交易数据决定，换钱包或市场即使用另一个缓存键。 Operation stage and links derive from this transaction; switching wallets or markets uses a separate cache key. */
  const editable = attempt?.status === 'idle' || (attempt?.status === 'failed' && !attempt.signature);
  const pending = attempt && 'pending' in attempt ? attempt.pending : undefined;
  const receipt = attempt && 'receipt' in attempt ? attempt.receipt : undefined;
  const signature = pending?.signature ?? (attempt?.status === 'failed' ? attempt.signature : undefined);
  const checking = attempt?.status === 'confirming' || attempt?.status === 'refreshing';
  const awaitingWallet = attempt?.status === 'preparing' || attempt?.status === 'wallet';
  /** 已开始签名的报价存入交易缓存，切页后也能显示原审批进度。 Cache a quote when signing starts so navigation can restore the approval state. */
  const activeReview = awaitingWallet ? attempt.review : review;
  const step = signature ? 3 : activeReview ? 2 : 1;
  /** 最大输入为出借可用余额或提取可用份额，分别对应输入框的六位精度。 The maximum input is spendable assets for deposits or redeemable shares for withdrawals, both with six decimals. */
  const withdrawalLimit = position.data && getSupplyWithdrawalLimit(position.data);
  const inputLimitRaw = withdrawing ? withdrawalLimit?.sharesRaw : position.data?.walletAssetRaw;
  const canWithdrawAll = withdrawalLimit !== undefined && withdrawalLimit.sharesRaw === position.data?.sharesRaw;
  const viewSupply = lendingLocation(paths.supply, 'devnet', market.address);
  /** 仅在审核或结果步骤出现时移动键盘焦点。 Move keyboard focus when entering review or result. */
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step !== 1) stepHeading.current?.focus({ preventScroll: true });
  }, [step]);

  /** 将输入校验错误与金额控件关联，方便读屏定位。 Associate validation errors with the amount control so assistive technology can identify them. */
  const amountInvalid = attempt?.status === 'failed' &&
    ['invalidAmount', 'insufficientAsset', 'insufficientShares', 'insufficientLiquidity', 'zeroWithdrawal'].includes(attempt.error);
  return (
    <div className="lending-supply">
      <ol className="lending-supply__steps" aria-label={t(copy + '.steps')}>
        <li aria-current={step === 1 ? 'step' : undefined}>{t('lendingSupply.stepAmount')}</li>
        <li aria-current={step === 2 ? 'step' : undefined}>{t('lendingSupply.stepReview')}</li>
        <li aria-current={step === 3 ? 'step' : undefined}>{t('lendingSupply.stepResult')}</li>
      </ol>
      <section className="lending-supply__card" aria-labelledby="lending-supply-step">
        <h2 id="lending-supply-step" ref={stepHeading} tabIndex={-1}>
          {t(step === 1 ? 'lendingSupply.stepAmount' : step === 2 ? 'lendingSupply.stepReview' : 'lendingSupply.stepResult')}
        </h2>

        {editable && !review && (
          position.isError ? (
            <>
              <p className="lending-supply__error" role="alert">{t('lendingSupply.positionError')}</p>
              <button className="lending-supply__button" type="button" onClick={() => void position.refetch()} disabled={position.isFetching}>
                {t('lendingSupply.retry')}
              </button>
            </>
          ) : inputLimitRaw === undefined ? (
            <p role="status">{t('lendingSupply.positionLoading')}</p>
          ) : (
            <form className="lending-supply__form" onSubmit={reviewSupply}>
              <label htmlFor="lending-supply-amount">{t(copy + '.amount')}</label>
              <div className="lending-supply__amount">
                <input
                  id="lending-supply-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={27}
                  value={amount}
                  aria-invalid={amountInvalid || undefined}
                  aria-describedby={amountInvalid ? 'lending-supply-balance lending-supply-error' : 'lending-supply-balance'}
                  onChange={(event) => { setAmount(event.target.value); setAttempt({ status: 'idle' }); }}
                />
                <button
                  className="lending-supply__button"
                  type="button"
                  disabled={inputLimitRaw === 0n}
                  onClick={() => { setAmount(formatCashVaultInput(inputLimitRaw)); setAttempt({ status: 'idle' }); }}
                >
                  {t(withdrawing ? copy + (canWithdrawAll ? '.all' : '.max') : 'lendingSupply.max')}
                </button>
              </div>
              <p id="lending-supply-balance">
                {withdrawing && withdrawalLimit
                  ? t(copy + '.available', {
                    shares: formatTokenAmount(inputLimitRaw, lendingShareDecimals, locale),
                    amount: formatTokenAmount(withdrawalLimit.assetsRaw, assetDecimals, locale),
                    symbol: debtSymbol,
                  })
                  : t('lendingSupply.available', { amount: formatTokenAmount(inputLimitRaw, assetDecimals, locale) })}
              </p>
              {withdrawing && (position.data?.walletAssetFrozen ? <p>{t(copy + '.frozenDestination')}</p>
                : position.data?.sharesRaw === 0n ? <p>{t(copy + '.noShares')}</p>
                  : !canWithdrawAll && <p>{t(copy + '.limitedCash')}</p>)}
              {!withdrawing && inputLimitRaw === 0n &&
                <p>{t(position.data?.walletAssetFrozen ? 'lendingSupply.frozenBalance' : 'lendingSupply.noBalance')}</p>}
              <button className="lending-supply__button lending-supply__button--primary" type="submit" disabled={!amount.trim() || inputLimitRaw === 0n}>
                {t(copy + '.review')}
              </button>
            </form>
          )
        )}

        {step === 2 && activeReview && (
          <>
            <dl className="lending-supply__metrics">
              <dt>{t(copy + '.amount')}</dt>
              <dd>{withdrawing ? formatTokenAmount(activeReview.sharesRaw, lendingShareDecimals, locale)
                : formatTokenAmount(activeReview.assetsRaw, assetDecimals, locale) + ' ' + debtSymbol}</dd>
              <dt>{t(withdrawing ? copy + '.estimatedAssets' : 'lendingSupply.estimatedShares')}</dt>
              <dd>{withdrawing ? formatTokenAmount(activeReview.assetsRaw, assetDecimals, locale) + ' ' + debtSymbol
                : formatTokenAmount(activeReview.sharesRaw, lendingShareDecimals, locale)}</dd>
              <dt>{t(withdrawing ? copy + '.minimumAssets' : 'lendingSupply.minimumShares')}</dt>
              <dd>{withdrawing ? formatTokenAmount(activeReview.assetsRaw, assetDecimals, locale) + ' ' + debtSymbol
                : formatTokenAmount(activeReview.sharesRaw, lendingShareDecimals, locale)}</dd>
            </dl>
            <p>{t(copy + '.reviewHint')}</p>
            {awaitingWallet && <p role="status">{t(attempt.status === 'preparing' ? 'lendingSupply.preparing' : 'lendingSupply.walletApproval')}</p>}
            {position.isError && <p className="lending-supply__error" role="alert">{t('lendingSupply.positionError')}</p>}
            <div className="lending-supply__actions">
              <button className="lending-supply__button" type="button" disabled={awaitingWallet} onClick={() => setReview(null)}>
                {t('lendingSupply.edit')}
              </button>
              <button className="lending-supply__button lending-supply__button--primary" type="button" disabled={awaitingWallet || position.isError} onClick={() => void submitSupply()}>
                {t(copy + '.sign')}
              </button>
            </div>
          </>
        )}

        {attempt?.status === 'failed' && (
          <p id="lending-supply-error" className="lending-supply__error" role="alert">{t([copy + '.errors.' + attempt.error, 'lendingSupply.errors.' + attempt.error])}</p>
        )}
        {pending && !receipt && (
          <>
            <p role="status">
              {t(attempt?.status === 'confirmationUnknown' ? 'lendingSupply.confirmationUnknown'
                : attempt?.status === 'receiptUnavailable' ? copy + '.receiptUnavailable' : 'lendingSupply.confirming')}
            </p>
            {!checking && (
              <button className="lending-supply__button" type="button" onClick={() => void confirm(pending)}>
                {t('lendingSupply.recheck')}
              </button>
            )}
          </>
        )}

        {pending && receipt && (
          <>
            <p className="lending-supply__success" role="status">{t(copy + '.confirmed')}</p>
            <dl className="lending-supply__metrics">
              <dt>{t(copy + '.actualAmount')}</dt>
              <dd>{formatTokenAmount(receipt.assetsRaw, assetDecimals, locale)} {debtSymbol}</dd>
              <dt>{t(copy + '.actualShares')}</dt>
              <dd>{formatTokenAmount(receipt.sharesRaw, lendingShareDecimals, locale)}</dd>
            </dl>
            {attempt?.status === 'complete' && position.data && (
              <p>{t('lendingSupply.updatedPosition', { shares: formatTokenAmount(position.data.sharesRaw, lendingShareDecimals, locale) })}</p>
            )}
            {attempt?.status === 'refreshing' && <p role="status">{t('lendingSupply.synchronizing')}</p>}
            {attempt?.status === 'syncFailed' && (
              <>
                <p className="lending-supply__error" role="alert">{t(copy + '.syncFailed')}</p>
                <button className="lending-supply__button" type="button" onClick={() => void synchronize(pending, receipt)}>
                  {t('lendingSupply.retrySync')}
                </button>
              </>
            )}
          </>
        )}

        {signature && (
          <div className="lending-supply__actions">
            <a className="text-link" href={'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + '?cluster=devnet'} target="_blank" rel="noreferrer">
              {t('lendingSupply.explorer')}
            </a>
            {attempt?.status === 'complete' && <Link className="text-link" to={viewSupply}>{t('pages.supply.title')}</Link>}
            {(attempt?.status === 'complete' || attempt?.status === 'failed') && (
              <button className="lending-supply__button" type="button" onClick={() => { setAmount(''); setReview(null); setAttempt({ status: 'idle' }); }}>
                {t('lendingSupply.newSupply')}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

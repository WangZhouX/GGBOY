import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';
import type { LendingMarketListItem } from '../../features/lending/api/listLendingMarkets';
import { borrowMarketQueryKey, borrowPositionQueryKey, devnetLendingCashQueryKey } from '../../features/lending/lendingQueryKeys';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { withNetwork } from '../../shared/navigation/network';
import { paths } from '../../shared/navigation/paths';
import {
  LendingLiquidationError, lendingLiquidationRpcUrl, prepareLendingLiquidation, quoteLendingLiquidation,
  readLendingLiquidationQuote, waitForLendingLiquidation,
  type LendingLiquidationLifetime, type LendingLiquidationReceipt, type LendingLiquidationRequest,
} from '../../solana/lending/liquidateLendingPosition';
import { usePhantomWallet, WalletTransactionError } from '../../solana/phantomWallet';
import { formatPositionAmount } from './positionValues';

/** SPL Token 最小单位金额的上界。 Maximum SPL Token base-unit amount. */
const maxU64 = (1n << 64n) - 1n;

/** 市场、候选和当前清算钱包共同限定操作范围。 The selected market, candidate, and liquidator wallet scope the operation. */
interface OperationProps {
  /** 已登记并允许发起交易的市场。 Registered market enabled for transactions. */
  market: LendingMarketListItem;
  /** 借款人公钥以及付款签名人公钥。 Borrower public key and paying signer public key. */
  borrowerAddress: string;
  walletAddress: string;
  /** 清算后从首屏刷新候选。 Refresh the candidate list from its first page after settlement. */
  onConfirmed: () => void;
}

/** 保存用户审核的代偿上限、到账下限和报价 slot。 Repayment cap, collateral floor, and quote slot approved by the user. */
interface Review {
  /** 依次为借款资产最小单位估计上限、抵押资产最低到账和预估到账。 Debt asset base-unit cap, collateral floor, and estimated collateral receipt. */
  repayRaw: bigint;
  minCollateralRaw: bigint;
  estimatedCollateralRaw: bigint;
  /** 报价所用的最终确认 slot。 Finalized slot of the reviewed quote. */
  slot: number;
}

/** 按市场、借款人和签名人保存的一次已提交的公开交易。 Public submitted transaction data scoped by market, borrower, and signer. */
interface Pending extends Pick<Review, 'repayRaw' | 'minCollateralRaw'> {
  /** Phantom 回传的公开交易签名。 Public transaction signature returned by Phantom. */
  signature: string;
  /** 已送签交易的模拟 slot 与最后有效高度。 Simulation slot and last valid height of the signed transaction. */
  lifetime: LendingLiquidationLifetime;
}

/** 缓存交易状态以恢复同一签名，并在 React 下一次渲染前防止重复发送。 Cache transaction state to recover the same signature and prevent resubmission before React re-renders. */
type Attempt =
  | { state: 'idle' }
  | { state: 'preparing' | 'wallet'; review: Review }
  | { state: 'confirming' | 'pending'; pending: Pending; code?: string }
  | { state: 'failed'; code: string }
  | { state: 'complete'; pending: Pending; receipt: LendingLiquidationReceipt };

/** 从金额表单读取相应 Mint 的正 u64 最小单位数，拒绝过长或多余小数位。 Parse positive u64 mint base units, rejecting overlong or over-precise decimal input. */
function parseAmount(text: string, decimals: number): bigint | null {
  const match = /^([0-9]{0,20})(?:\.([0-9]*))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if ((!whole && !fraction) || fraction.length > decimals) return null;
  const raw = BigInt((whole || '0') + fraction.padEnd(decimals, '0'));
  return raw > 0n && raw <= maxU64 ? raw : null;
}

/** 从当前会话恢复同一作用域的公开签名，校验各字段后才能发至 RPC。 Restore the public signature in this session and validate every field before RPC use. */
function restorePending(key: string): Pending | null {
  try {
    const data: Partial<Record<'signature' | 'repayRaw' | 'minCollateralRaw' | 'minContextSlot' | 'lastValidBlockHeight', unknown>> | null =
      JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (!data) return null;

    const { signature, repayRaw, minCollateralRaw, minContextSlot, lastValidBlockHeight } = data;
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) ||
        typeof repayRaw !== 'string' || !/^[1-9][0-9]{0,19}$/.test(repayRaw) ||
        typeof minCollateralRaw !== 'string' || !/^[1-9][0-9]{0,19}$/.test(minCollateralRaw) ||
        typeof minContextSlot !== 'number' || !Number.isSafeInteger(minContextSlot) || minContextSlot < 0 ||
        typeof lastValidBlockHeight !== 'number' || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1) return null;

    const repay = BigInt(repayRaw);
    const minimum = BigInt(minCollateralRaw);
    return repay <= maxU64 && minimum <= maxU64
      ? { signature, repayRaw: repay, minCollateralRaw: minimum, lifetime: { minContextSlot, lastValidBlockHeight } }
      : null;
  } catch {
    return null;
  }
}

/** 保留原签名，只有业务确认成功、确定失败或过期后才删除。 Retain the original signature until full confirmation, definitive failure, or expiry. */
function storePending(key: string, value?: Pending): void {
  try {
    if (!value) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify({
      signature: value.signature,
      repayRaw: value.repayRaw.toString(),
      minCollateralRaw: value.minCollateralRaw.toString(),
      ...value.lifetime,
    }));
  } catch {
    // 存储禁用时，仍由本页的查询缓存保留已广播的签名。
    // With browser storage disabled, the query cache still retains the broadcast signature.
  }
}

/**
 * 在显示候选之后提供独立的核对、Phantom 签名及最终回执步骤。
 * Provide separate review, Phantom signing, and verified receipt after selecting a candidate.
 *
 * @param props 当前市场、候选借款人、签名人和刷新回调。 Market, candidate borrower, signer, and refresh callback.
 */
export function LendingLiquidationOperation({ market, borrowerAddress, walletAddress, onConfirmed }: OperationProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const queryClient = useQueryClient();
  const wallet = usePhantomWallet();
  /** 通过完整登记资产和双方钱包隔离同名页面上的交易。 Scope transactions by the registered assets and both wallets. */
  const scope = [
    market.network, market.address, market.programId, market.debtAsset.mint, market.debtAsset.decimals,
    market.collateralAsset.mint, market.collateralAsset.decimals, borrowerAddress, walletAddress,
  ].join(':');
  const attemptKey = ['lending-liquidation-attempt', scope] as const;
  const storageKey = 'ggboy.liquidation:' + scope;
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const self = walletAddress === borrowerAddress;
  /** 页面或签名作用域切换时取消预检，避免离开旧页面后打开钱包。 Cancel preflight on page or signer changes to prevent a wallet prompt for the previous view. */
  const preflight = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => preflight.current?.abort(), []);

  /** 作用域一致时恢复签名，对同一交易重试回执永远不会再次打开 Phantom。 Restore the matching signature so receipt retries never reopen Phantom. */
  const { data: attempt } = useQuery<Attempt>({
    queryKey: attemptKey,
    queryFn: skipToken,
    gcTime: Infinity,
    initialData: () => {
      const saved = restorePending(storageKey);
      return saved ? { state: 'pending', pending: saved } : { state: 'idle' };
    },
  });
  const pending = attempt?.state === 'pending' || attempt?.state === 'confirming' || attempt?.state === 'complete'
    ? attempt.pending : null;
  const receipt = attempt?.state === 'complete' ? attempt.receipt : null;
  const reviewed = attempt?.state === 'preparing' || attempt?.state === 'wallet' ? attempt.review : review;

  /** 实时报价与后端候选分开读取，链上账户和时间决定是否还能执行。 Keep live quotes separate from the candidate index. Current chain accounts and time determine availability. */
  const quote = useQuery({
    queryKey: ['lending-liquidation-quote', scope],
    queryFn: ({ signal }) => readLendingLiquidationQuote({ market, borrowerAddress, walletAddress }, { signal }),
    enabled: !self && pending === null,
    refetchOnWindowFocus: 'always',
    retry: false,
  });

  const editable = attempt?.state === 'idle' || attempt?.state === 'failed';
  const debtSymbol = market.debtAsset.symbol ?? market.debtAsset.mint;
  const openQuote = !quote.isError && quote.data?.status === 'ready' && quote.data.maxRepayRaw > 0n;
  const canReview = editable && !reviewed && openQuote && Boolean(amount.trim());

  /** 写入作用域的交易缓存，让下一次点击可立刻检查原状态。 Write scoped transaction state so the next click can check it immediately. */
  function setAttempt(next: Attempt) {
    queryClient.setQueryData<Attempt>(attemptKey, next);
  }

  /** 使用快照之后重新取到的链上余额和价格生成核对项。 Build review values from live balances and price after selecting the candidate. */
  function reviewAmount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canReview || !quote.data) return;
    const repayRaw = parseAmount(amount, market.debtAsset.decimals);
    if (repayRaw === null || repayRaw > quote.data.maxRepayRaw) {
      setAttempt({ state: 'failed', code: repayRaw === null ? 'invalidAmount' : 'exceedsLimit' });
      return;
    }

    const estimatedCollateralRaw = quoteLendingLiquidation(quote.data, repayRaw);
    if (estimatedCollateralRaw === null) {
      setAttempt({ state: 'failed', code: 'tooSmall' });
      return;
    }

    // 用户明确核对 0.5% 以内的价格滑点，保留最少一最小单位抵押到账。
    // Review a 0.5% price tolerance explicitly while preserving at least one collateral base unit.
    const minCollateralRaw = estimatedCollateralRaw - estimatedCollateralRaw * 50n / 10_000n;
    setReview({ repayRaw, minCollateralRaw, estimatedCollateralRaw, slot: quote.data.slot });
    setAttempt({ state: 'idle' });
  }

  /** 核对原签名的结果，成交后同步候选、池现金、仓位和活动查询。 Verify the original signature, then refresh candidates, pool cash, positions, and activity. */
  async function confirm(submitted: Pending) {
    setAttempt({ state: 'confirming', pending: submitted });
    const request = { market, borrowerAddress, walletAddress, repayRaw: submitted.repayRaw, minCollateralRaw: submitted.minCollateralRaw };
    try {
      const settled = await waitForLendingLiquidation(submitted.signature, request, submitted.lifetime);
      storePending(storageKey);
      setAttempt({ state: 'complete', pending: submitted, receipt: settled });
      onConfirmed();
      void queryClient.invalidateQueries({ queryKey: ['activities', market.network] });
      void queryClient.invalidateQueries({ queryKey: ['lending-markets', market.network] });
      void queryClient.invalidateQueries({ queryKey: borrowMarketQueryKey(market) });
      void queryClient.invalidateQueries({ queryKey: borrowPositionQueryKey(market, borrowerAddress) });
      void queryClient.invalidateQueries({ queryKey: devnetLendingCashQueryKey(market) });
    } catch (error) {
      const code = error instanceof LendingLiquidationError ? error.code : 'confirmationUnknown';
      if (code === 'transactionFailed' || code === 'expired') {
        storePending(storageKey);
        setAttempt({ state: 'failed', code });
        return;
      }
      // RPC 暂时无法核验时保留原签名，重新查询也不会再次发送。
      // Preserve the original signature when verification is unavailable. Retrying never broadcasts.
      setAttempt({ state: 'pending', pending: submitted, code });
    }
  }

  /** 以同一份核对内容重读、模拟、交给 Phantom 签名，再跟踪原签名。 Refresh and simulate the reviewed terms, send them to Phantom, and track the original signature. */
  async function submit() {
    if (self || !reviewed || queryClient.getQueryData<Attempt>(attemptKey)?.state !== 'idle') return;

    const { repayRaw, minCollateralRaw, slot } = reviewed;
    const request: LendingLiquidationRequest = { market, borrowerAddress, walletAddress, repayRaw, minCollateralRaw };
    const controller = new AbortController();
    preflight.current = controller;
    setAttempt({ state: 'preparing', review: reviewed });
    try {
      const prepared = await prepareLendingLiquidation(request, slot, controller.signal);
      controller.signal.throwIfAborted();
      setAttempt({ state: 'wallet', review: reviewed });
      const signature = await wallet.signAndSendTransaction(
        prepared.transaction, walletAddress, prepared.minContextSlot, lendingLiquidationRpcUrl(market),
      );
      const lifetime = { minContextSlot: prepared.minContextSlot, lastValidBlockHeight: prepared.lastValidBlockHeight };
      const submitted = { signature, repayRaw, minCollateralRaw, lifetime };
      storePending(storageKey, submitted);
      setReview(null);
      await confirm(submitted);
    } catch (error) {
      if (controller.signal.aborted) {
        setAttempt({ state: 'idle' });
        return;
      }
      const code = error instanceof LendingLiquidationError || error instanceof WalletTransactionError
        ? error.code : 'preparationFailed';
      setReview(null);
      setAttempt({ state: 'failed', code });
      if (code === 'quoteChanged' || code === 'preparationFailed') void quote.refetch();
    } finally {
      preflight.current = null;
    }
  }

  /** 只恢复已广播签名的回执查询。 Resume receipt verification for a broadcast signature only. */
  function retryReceipt() {
    const current = queryClient.getQueryData<Attempt>(attemptKey);
    if (current?.state === 'pending') void confirm(current.pending);
  }

  /** 对应钱包确认、RPC 观察和交易执行失败的不同恢复方式。 Different recovery messages for wallet approval, RPC observation, and execution failures. */
  const attemptError = attempt?.state === 'failed' || attempt?.state === 'pending' ? attempt.code : null;
  const quoteStatus = quote.data && !openQuote
    ? quote.data.status !== 'ready' ? quote.data.status
      : quote.data.destinationFrozen ? 'destinationFrozen'
        : quote.data.debtBalanceRaw === 0n ? 'noWalletFunds' : 'noRepayableCollateral'
    : null;
  const receiptPath = pending && receipt ? withNetwork(generatePath(paths.activityReceipt, {
    signature: pending.signature, eventIndex: String(receipt.eventIndex),
  }), market.network) : null;

  return (
    <section className="liquidations__panel" aria-labelledby="liquidation-operation-title">
      <header className="liquidations__heading">
        <h2 id="liquidation-operation-title">{t('lendingLiquidations.actionTitle')}</h2>
      </header>
      <dl className="liquidations__context">
        <div>
          <dt>{t('lendingLiquidations.borrower')}</dt>
          <dd><code>{borrowerAddress}</code></dd>
        </div>
        <div>
          <dt>{t('lendingLiquidations.liquidator')}</dt>
          <dd><code>{walletAddress}</code></dd>
        </div>
      </dl>

      {self && <p className="liquidations__notice" role="status">{t('lendingLiquidations.self')}</p>}
      {!self && editable && !reviewed && (
        <>
          {quote.isPending && <p className="liquidations__notice" role="status">{t('lendingLiquidations.quoteLoading')}</p>}
          {quote.isError && <p className="liquidations__notice liquidations__notice--error" role="alert">{t('lendingLiquidations.quoteReadError')}</p>}
          {quoteStatus && !quote.isError && <p className="liquidations__notice" role="status">{t('lendingLiquidations.' + quoteStatus)}</p>}
          <button type="button" className="liquidations__button" disabled={quote.isFetching} onClick={() => void quote.refetch()}>
            {t('lendingLiquidations.refreshQuote')}
          </button>
          {quote.data && !quote.isError && (
            <dl className="liquidations__context">
              <div>
                <dt>{t('lendingLiquidations.walletBalance')}</dt>
                <dd>{formatPositionAmount(quote.data.debtBalanceRaw.toString(), market.debtAsset, locale)}</dd>
              </div>
              <div>
                <dt>{t('lendingLiquidations.maxRepay')}</dt>
                <dd>{formatPositionAmount(quote.data.maxRepayRaw.toString(), market.debtAsset, locale)}</dd>
              </div>
            </dl>
          )}
          {openQuote && quote.data && (
            <form className="liquidations__form" onSubmit={reviewAmount}>
              <label htmlFor="liquidation-amount">{t('lendingLiquidations.amount', { symbol: debtSymbol })}</label>
              <div className="liquidations__actions">
                <input id="liquidation-amount" inputMode="decimal" autoComplete="off" maxLength={40} value={amount}
                  onChange={(event) => { setAmount(event.currentTarget.value); setAttempt({ state: 'idle' }); }} />
                <button type="button" className="liquidations__button" onClick={() => {
                  if (quote.data) setAmount(formatTokenAmount(quote.data.maxRepayRaw, market.debtAsset.decimals, 'en-US').replaceAll(',', ''));
                  setAttempt({ state: 'idle' });
                }}>{t('lendingLiquidations.useMax')}</button>
              </div>
              <button type="submit" className="liquidations__button liquidations__button--primary" disabled={!canReview || quote.isFetching}>
                {t('lendingLiquidations.review')}
              </button>
            </form>
          )}
        </>
      )}
      {reviewed && (
        <>
          <dl className="liquidations__context">
            <div>
              <dt>{t('lendingLiquidations.maxAuthorized')}</dt>
              <dd>{formatPositionAmount(reviewed.repayRaw.toString(), market.debtAsset, locale)}</dd>
            </div>
            <div>
              <dt>{t('lendingLiquidations.estimatedCollateral')}</dt>
              <dd>{formatPositionAmount(reviewed.estimatedCollateralRaw.toString(), market.collateralAsset, locale)}</dd>
            </div>
            <div>
              <dt>{t('lendingLiquidations.minCollateral')}</dt>
              <dd>{formatPositionAmount(reviewed.minCollateralRaw.toString(), market.collateralAsset, locale)}</dd>
            </div>
          </dl>
          <div className="liquidations__actions">
            <button type="button" className="liquidations__button liquidations__button--primary" disabled={!editable}
              onClick={() => void submit()}>{t('lendingLiquidations.sign')}</button>
            <button type="button" className="liquidations__button" disabled={!editable}
              onClick={() => setReview(null)}>{t('lendingLiquidations.editAmount')}</button>
          </div>
        </>
      )}
      {(attempt?.state === 'preparing' || attempt?.state === 'wallet' || attempt?.state === 'confirming') && (
        <p className="liquidations__notice" role="status">{t('lendingLiquidations.' + attempt.state)}</p>
      )}
      {attemptError && <p className="liquidations__notice liquidations__notice--error" role="alert">
        {t('lendingLiquidations.errors.' + attemptError)}
      </p>}
      {attempt?.state === 'pending' && (
        <button type="button" className="liquidations__button" onClick={retryReceipt}>{t('lendingLiquidations.checkReceipt')}</button>
      )}
      {receipt && (
        <>
          <p className="liquidations__confirmed" role="status">{t('lendingLiquidations.confirmed')}</p>
          <dl className="liquidations__context">
            <div>
              <dt>{t('lendingLiquidations.actualRepaid')}</dt>
              <dd>{formatPositionAmount(receipt.repaidRaw.toString(), market.debtAsset, locale)}</dd>
            </div>
            <div>
              <dt>{t('lendingLiquidations.actualCollateral')}</dt>
              <dd>{formatPositionAmount(receipt.seizedCollateralRaw.toString(), market.collateralAsset, locale)}</dd>
            </div>
            {receipt.badDebtRaw > 0n && (
              <div>
                <dt>{t('lendingLiquidations.badDebt')}</dt>
                <dd>{formatPositionAmount(receipt.badDebtRaw.toString(), market.debtAsset, locale)}</dd>
              </div>
            )}
          </dl>
        </>
      )}
      {pending && (
        <dl className="liquidations__context">
          <div>
            <dt>{t('lendingLiquidations.signature')}</dt>
            <dd><code>{pending.signature}</code></dd>
          </div>
        </dl>
      )}
      {receiptPath && (
        <div className="liquidations__actions">
          <Link to={receiptPath}>{t('lendingLiquidations.activityReceipt')}</Link>
          <button type="button" className="liquidations__button" onClick={() => {
            setAmount('');
            setAttempt({ state: 'idle' });
            onConfirmed();
            void quote.refetch();
          }}>{t('lendingLiquidations.clearReceipt')}</button>
        </div>
      )}
    </section>
  );
}

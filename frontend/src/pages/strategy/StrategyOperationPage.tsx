import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { getActivityAssetLabel } from '../../features/activity/activityDisplay';
import { isActivitySignature } from '../../features/activity/activityIdentifiers';
import { maxCashVaultTokenAmount, minimumCashVaultOutput } from '../../features/vault/cashVaultAmounts';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import { PageLayout } from '../../shared/ui/PageLayout';
import { usePhantomWallet, WalletTransactionError } from '../../solana/phantomWallet';
import {
  quoteVaultStrategy, readVaultStrategyReceipt, StrategyVaultTransactionError, submitVaultStrategy,
  type StrategyRequest, type StrategyVaultState,
} from '../../solana/vault/strategyVault';
import { parseStrategyAmount, strategyAmountInput } from './strategyAmounts';
import { strategyGate, strategyLocation, useStrategyRoute, type StrategyAction } from './StrategyRouteLayout';
import './styles/strategy.css';

/** 报价对应的已确认交易回执。 Confirmed transaction receipt corresponding to a quote. */
type ConfirmedStrategy = Awaited<ReturnType<typeof submitVaultStrategy>>;

/** 已由用户核对的输入、预计输出和链上输出下限。 Input, estimated output, and minimum acknowledged by the user. */
interface StrategyReview extends StrategyRequest {
  /** 估算的输出资产最小单位，冻结在核对步骤。 Estimated output in base units, frozen at review time. */
  expectedRaw: bigint;
}

/** 表单状态。明确区分钱包核对、广播和链上成功。 Form state that distinguishes wallet approval, broadcast, and confirmed success. */
interface BroadcastStrategy {
  /** 已在 Phantom 核对的精确数量与方向。 Verified amounts and direction shown before Phantom signing. */
  review: StrategyReview;
  /** Phantom 广播返回的公开交易签名。 Public transaction signature returned by Phantom after broadcast. */
  signature: string;
  /** 交易 blockhash 的最后有效区块高度。 Last valid block height of the transaction's blockhash. */
  lastValidBlockHeight: number;
}

/** 表单专用阶段，广播后只允许核对原签名。 Form stages that allow only the original signature to be checked after broadcast. */
type Attempt =
  | { status: 'entry'; error?: string }
  | { status: 'review' | 'wallet'; review: StrategyReview }
  | ({ status: 'confirming' | 'unknown' } & BroadcastStrategy)
  | { status: 'complete'; review: StrategyReview; receipt: ConfirmedStrategy; syncStatus: 'pending' | 'error' | 'complete' };

/** 子表单包含能操作的已校验金库、已连接账户和操作类型。 An authorized form receives the verified vault, connected wallet, and operation. */
interface StrategyFormProps {
  /** 路由所确定的资金操作。 Funding action selected by the route. */
  action: StrategyAction;
  /** 对应同一链上观测的资金与策略配置。 Funds and strategy configuration from one chain read. */
  observation: StrategyVaultState & { config: NonNullable<StrategyVaultState['config']> };
  /** 当前连接的钱包地址，必须与管理者一致。 Connected wallet address, which must match the manager. */
  managerAddress: string;
  /** 暂时无法获取实时验证时禁用核对和签名。 Block review and signing when live verification is unavailable. */
  blocked: boolean;
  /** 交易成功后按到账 slot 同步余额和记录。 Refresh balances and activity at the confirmation slot. */
  refresh: (slot: number) => Promise<void>;
}

/** 人类可读标记对应的精度与单位。 Display label and precision for an asset. */
interface StrategyAmountUnit {
  /** 最小单位的小数位数。 Decimal places represented by base units. */
  decimals: number;
  /** 代币简称、Mint 地址缩写或出借份额单位。 Token symbol, abbreviated mint, or lending share label. */
  label: string;
}

/**
 * 定位链上已明确失败的情况，只有这些错误才解除重复提交保护。
 * Identify proven on-chain failures that allow a fresh submission.
 *
 * @param error 报价、钱包或链上核对失败原因。 Error from quoting, a wallet, or a chain lookup.
 */
function knownFailure(error: unknown): string | null {
  if (!(error instanceof StrategyVaultTransactionError)) return null;
  if (error.code === 'transactionFailed') return 'strategy.form.transactionFailed';
  if (error.code === 'transactionExpired') return 'strategy.form.transactionExpired';
  return null;
}

/**
 * 从此标签页恢复未核实的广播，绑定至原钱包、金库及操作路由。
 * Restore an unverified broadcast from this tab, scoped to the original wallet, vault, and operation.
 *
 * @param key 当前表单的会话键。 Session key for the current form.
 * @param action URL 所选操作。 Operation selected in the URL.
 * @returns 可继续查询的交易，缺少或无效时为空。 Transaction to recheck, or null if absent or invalid.
 */
function restoreBroadcast(key: string, action: StrategyAction): BroadcastStrategy | null {
  try {
    /** 仅从公开的 JSON 数据中复原精确金额，并检查数字范围与方向。 Restore exact public amounts only after checking their numeric ranges and direction. */
    const saved = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (!saved || typeof saved.signature !== 'string' || !isActivitySignature(saved.signature)) return null;
    const { kind, amountRaw, minOutRaw, expectedRaw, lastValidBlockHeight } = saved;
    if (typeof lastValidBlockHeight !== 'number' || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) return null;
    if ((action === 'swap' ? kind !== 'buy' && kind !== 'sell' : kind !== action) ||
        ![amountRaw, minOutRaw, expectedRaw].every((value) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value))) {
      return null;
    }
    /** 恢复的序列化金额仍受 u64 与报价下限约束。 Restored amounts still observe u64 limits and the reviewed minimum. */
    const amount = BigInt(amountRaw);
    const minimum = BigInt(minOutRaw);
    const expected = BigInt(expectedRaw);
    if (amount > maxCashVaultTokenAmount || expected > maxCashVaultTokenAmount || minimum > expected) return null;
    return { signature: saved.signature, lastValidBlockHeight, review: { kind, amountRaw: amount, minOutRaw: minimum, expectedRaw: expected } };
  } catch {
    return null;
  }
}

/**
 * 恢复保护只保存公开签名和报价，不持久化钱包凭据。
 * Save only public signatures and quote values for recovery without persisting wallet credentials.
 *
 * @param key 当前表单的会话键。 Session key for the current form.
 * @param pending 广播中的交易，省略时清除已核实签名。 Pending broadcast, or omit to clear a verified signature.
 */
function keepBroadcast(key: string, pending?: BroadcastStrategy): void {
  try {
    if (!pending) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify({
      signature: pending.signature,
      lastValidBlockHeight: pending.lastValidBlockHeight,
      kind: pending.review.kind,
      amountRaw: pending.review.amountRaw.toString(),
      minOutRaw: pending.review.minOutRaw.toString(),
      expectedRaw: pending.review.expectedRaw.toString(),
    }));
  } catch {
    // 存储无法使用时，此次页面加载仍在内存中跟踪原签名。
    // If storage is unavailable, this page load still tracks the original signature in memory.
  }
}

/**
 * 选择一个操作页，只有已登记金库上的管理者才会看到签名表单。
 * Open an operation screen and show the signing form only to the registered vault's manager.
 *
 * @param props 路由匹配的操作。 Operation matched by the route.
 */
export function StrategyOperationPage({ action }: { action: StrategyAction }) {
  /** 所选网络、金库和钱包与策略管理首页共用。 Share network, vault, and wallet selection with the management page. */
  const route = useStrategyRoute();
  const { t } = useTranslation();
  const { network, selected, chain, wallet, refreshAfterTransaction } = route;
  const gate = strategyGate(route);
  /** 连接钱包与链上权限必须匹配，配置未生效时不挂载表单。 Mount the form only when the connected wallet matches the on-chain authority. */
  const observation = chain.data;
  const config = observation?.config;
  const address = wallet.status === 'connected' ? wallet.walletAddress : null;
  const canRender = route.supported && observation && config && address && config.manager.toBase58() === address;
  const copy = 'strategy.actions.' + action;

  useEffect(() => {
    // 独立操作路由从页面正文开始，避免沿用上一页的滚动位置。
    // Start the dedicated operation at the main content rather than the previous scroll position.
    window.scrollTo(0, 0);
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [action]);

  return (
    <PageLayout title={t(copy + '.title')} description={t(copy + '.description')}>
      <div className="strategy-operation">
        <Link className="text-link" to={strategyLocation(network, selected?.address)}>
          <span aria-hidden="true">‹</span> {t('strategy.back')}
        </Link>
        {gate && <p className="strategy-note" role="status">{t(gate)}</p>}
        {gate === 'strategy.connectManager' && wallet.status === 'disconnected' && (
          <button type="button" className="strategy-button" onClick={() => void wallet.connect()}>
            {t('wallet.connect')}
          </button>
        )}
        {canRender && (
          <StrategyForm
            key={[network, action, selected?.address, address].join(':')}
            action={action}
            observation={{ ...observation, config }}
            managerAddress={address}
            blocked={gate !== null}
            refresh={refreshAfterTransaction}
          />
        )}
      </div>
    </PageLayout>
  );
}

/**
 * 预览每种策略交易的转入、转出和下限，直到读取实际成交事件后才展示成功。
 * Review input, output, and limits for a strategy transaction; show success only after the executed event is read.
 *
 * @param props 已授权操作和读链状态。 Authorized operation and chain state.
 */
function StrategyForm({ action, observation, managerAddress, blocked, refresh }: StrategyFormProps) {
  /** 金额与状态文案跟随当前界面语言。 Format amounts and status copy in the current interface language. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const wallet = usePhantomWallet();
  /** 会话记录按网络、金库、管理者和操作隔离。 Scope recovery by network, vault, manager, and operation. */
  const storageKey = ['ggboy.strategy', observation.vault.network, observation.vault.address, managerAddress, action].join(':');
  const [restored] = useState(() => restoreBroadcast(storageKey, action));
  /** 兑换默认买入策略资产，恢复交易时沿用已核对的方向。 Swaps default to buying the strategy asset, preserving direction when a broadcast is restored. */
  const [kind, setKind] = useState<StrategyRequest['kind']>(restored?.review.kind ?? (action === 'swap' ? 'buy' : action));
  const [amount, setAmount] = useState('');
  const [attempt, setAttempt] = useState<Attempt>(restored ? { status: 'unknown', ...restored } : { status: 'entry' });
  /** Phantom 打开前锁住本次操作，阻止连续点击触发同一笔预览。 Lock the attempt before opening Phantom to prevent double-clicking the same preview. */
  const inFlight = useRef(false);

  /** 金库结算资产、实际绑定策略币种和池份额的独立单位。 Separate units for settlement, the bound strategy token, and pool shares. */
  const quoteAsset = observation.vault.quoteAsset;
  const spotAsset = observation.vault.strategyAsset;
  const spotMint = observation.config.strategyMint.toBase58();
  const cash = { decimals: quoteAsset.decimals, label: getActivityAssetLabel(quoteAsset, observation.vault.network) };
  const spot = {
    decimals: observation.config.strategyDecimals,
    label: getActivityAssetLabel({
      mint: spotMint, symbol: spotAsset?.mint === spotMint ? spotAsset.symbol : null,
    }, observation.vault.network),
  };
  const shares = { decimals: 6, label: t('strategy.form.poolShares') };
  const input = kind === 'sell' ? spot : kind === 'recall' ? shares : cash;
  const output = kind === 'buy' ? spot : kind === 'lend' ? shares : cash;
  /** 输入上限按此动作的资金来源和池规则选取，以最小单位计。 Maximum input by funding source and pool policy, in base units. */
  const maxInput = kind === 'lend' ? observation.maxLendRaw : kind === 'recall' ? observation.maxRecallSharesRaw
    : kind === 'sell' ? observation.spotRaw : observation.cashRaw;
  const entered = parseStrategyAmount(amount, input.decimals);
  const estimate = entered === null ? null : quoteVaultStrategy(observation, kind, entered);
  /** 允许最多 50 基点的预计输出变化，向上舍入成正的最小单位。 Allow up to 50 basis points of output movement, rounded up to a positive base unit. */
  const safeMinimum = estimate !== null && estimate > 0n ? minimumCashVaultOutput(estimate) : null;

  /**
   * 把最小单位和经核验的资产标签格式化为可读数值。
   * Format a base-unit quantity with its verified asset label.
   *
   * @param raw 精确的整数代币数量。 Exact integer token quantity.
   * @param unit 当前字段使用的精度与单位。 Precision and unit for this field.
   */
  function shown(raw: bigint, unit: StrategyAmountUnit): string {
    return formatTokenAmount(raw, unit.decimals, locale) + ' ' + unit.label;
  }

  /**
   * 冻结用户实际将要签名的输入和下限，进入独立核对步骤。
   * Freeze the input and minimum to be signed before entering the review step.
   *
   * @param event 输入表单的提交事件。 Submit event from the entry form.
   */
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || entered === null || estimate === null || safeMinimum === null) return;
    setAttempt({ status: 'review', review: { kind, amountRaw: entered, minOutRaw: safeMinimum, expectedRaw: estimate } });
  }

  /**
   * 清除已经核对的签名，更新公共余额与策略活动。
   * Clear the verified broadcast, then refresh public balances and strategy activity.
   *
   * @param locked 由管理者核对的交易参数。 Transaction terms reviewed by the manager.
   * @param receipt 已核验的链上成交回执。 Verified receipt from on-chain execution.
   */
  async function finish(locked: StrategyReview, receipt: ConfirmedStrategy) {
    keepBroadcast(storageKey);
    setAttempt({ status: 'complete', review: locked, receipt, syncStatus: 'pending' });
    try {
      await refresh(receipt.slot);
      setAttempt({ status: 'complete', review: locked, receipt, syncStatus: 'complete' });
    } catch {
      setAttempt({ status: 'complete', review: locked, receipt, syncStatus: 'error' });
    }
  }

  /**
   * 复核当前报价，再构造交易并由已核验的管理者签名，最终读取成交事件。
   * Revalidate the quote, build and sign as the verified manager, then read the executed event.
   *
   * @param locked 由用户明确核对的报价。 Quote that the user explicitly reviewed.
   */
  async function sign(locked: StrategyReview) {
    if (blocked || inFlight.current) return;
    /** 保留确认页的原始下限，最新状态低于该金额时要求重新核对。 Preserve the reviewed minimum and require a new review when the current quote falls below it. */
    const latest = quoteVaultStrategy(observation, locked.kind, locked.amountRaw);
    if (latest === null || latest < locked.minOutRaw) {
      setAttempt({ status: 'entry', error: 'strategy.form.quoteChanged' });
      return;
    }
    inFlight.current = true;
    setAttempt({ status: 'wallet', review: locked });
    /** 广播后保留公开签名，RPC 暂时失败时仍能追踪同一交易。 Retain the public signature so a temporary RPC failure can still be traced to the same transaction. */
    let broadcast: BroadcastStrategy | undefined;
    try {
      const receipt = await submitVaultStrategy(observation, locked, managerAddress, wallet.signAndSendTransaction, (signature, lastValidBlockHeight) => {
        broadcast = { signature, lastValidBlockHeight, review: locked };
        keepBroadcast(storageKey, broadcast);
        setAttempt({ status: 'confirming', ...broadcast });
      });
      await finish(locked, receipt);
    } catch (error) {
      /** 只有确定失败或未广播时才允许重新填金额，避免重复调仓。 Return to entry only before broadcast or after definitive failure to avoid a duplicate operation. */
      const irreversibleFailure = knownFailure(error);
      if (broadcast && !irreversibleFailure) {
        setAttempt({ status: 'unknown', ...broadcast });
      } else {
        keepBroadcast(storageKey);
        setAttempt({
          status: 'entry',
          error: error instanceof WalletTransactionError ? 'strategy.form.walletErrors.' + error.code
            : irreversibleFailure ?? 'strategy.form.error',
        });
      }
    } finally {
      inFlight.current = false;
    }
  }

  /**
   * 用同一个已广播签名重新查验成交，永远不构造新交易。
   * Recheck execution using the original broadcast signature without building a new transaction.
   *
   * @param pending 先前广播的交易参数和签名。 Previously broadcast transaction terms and signature.
   */
  async function recheck(pending: BroadcastStrategy) {
    if (inFlight.current) return;
    inFlight.current = true;
    setAttempt({ ...pending, status: 'confirming' });
    try {
      const receipt = await readVaultStrategyReceipt(
        observation, pending.review, managerAddress, pending.signature, pending.lastValidBlockHeight,
      );
      if (receipt) await finish(pending.review, receipt);
      else setAttempt({ ...pending, status: 'unknown' });
    } catch (error) {
      const irreversibleFailure = knownFailure(error);
      if (irreversibleFailure) {
        keepBroadcast(storageKey);
        setAttempt({ status: 'entry', error: irreversibleFailure });
      } else {
        setAttempt({ ...pending, status: 'unknown' });
      }
    } finally {
      inFlight.current = false;
    }
  }

  /** 当前表单已经广播的签名。 Signature already broadcast by the form. */
  const signature = attempt.status === 'complete' ? attempt.receipt.signature
    : attempt.status === 'confirming' || attempt.status === 'unknown' ? attempt.signature : undefined;

  return (
    <section className="strategy-panel" aria-labelledby="strategy-form-title">
      <header className="strategy-panel__header">
        <h2 id="strategy-form-title">{t('strategy.form.' + (attempt.status === 'entry' ? 'entry'
          : attempt.status === 'complete' ? 'confirmed' : 'review'))}</h2>
      </header>
      {attempt.status === 'entry' ? (
        <form className="strategy-form" onSubmit={review}>
          {action === 'swap' && (
            <label className="strategy-field" htmlFor="strategy-direction">
              {t('strategy.form.direction')}
              <select
                id="strategy-direction"
                value={kind}
                onChange={(event) => {
                  setKind(event.currentTarget.value === 'sell' ? 'sell' : 'buy');
                  setAmount('');
                }}
              >
                <option value="buy">{cash.label} → {spot.label}</option>
                <option value="sell">{spot.label} → {cash.label}</option>
              </select>
            </label>
          )}
          <div className="strategy-input-row">
            <label className="strategy-field" htmlFor="strategy-amount">
              {t('strategy.form.amount', { asset: input.label })}
              <input
                id="strategy-amount"
                value={amount}
                onChange={(event) => setAmount(event.currentTarget.value)}
                inputMode="decimal"
                autoComplete="off"
                maxLength={21}
                placeholder="0.00"
                aria-describedby="strategy-amount-hint"
              />
            </label>
            {action !== 'swap' && maxInput !== null && maxInput > 0n && (
              <button className="strategy-button" type="button" onClick={() => setAmount(strategyAmountInput(maxInput, input.decimals))}>
                {t('strategy.form.max')}
              </button>
            )}
          </div>
          <p className="strategy-note" id="strategy-amount-hint">
            {maxInput === null ? t('strategy.form.limitMissing')
              : t(action === 'swap' ? 'strategy.form.inputBalance' : 'strategy.form.limit', { amount: shown(maxInput, input) })}
          </p>
          {amount.trim() !== '' && estimate === null && (
            <p className="strategy-note strategy-note--error" role="status">{t(entered === null ? 'strategy.form.invalidAmount'
              : maxInput !== null && entered > maxInput ? 'strategy.form.overLimit' : 'strategy.form.quoteUnavailable')}</p>
          )}
          {attempt.error && <p className="strategy-note strategy-note--error" role="alert">{t(attempt.error)}</p>}
          <button className="strategy-button strategy-button--primary" type="submit" disabled={blocked || safeMinimum === null}>
            {t('strategy.form.review')}
          </button>
        </form>
      ) : (
        <div className="strategy-form">
          <dl className="strategy-config">
            <dt>{t('strategy.form.vault')}</dt>
            <dd><code>{observation.vault.address}</code></dd>
            {attempt.status === 'complete' && action !== 'swap' ? (
              <>
                <dt>{t(action === 'lend' ? 'strategy.form.actualInput' : 'strategy.form.actualOutput')}</dt>
                <dd>{shown(attempt.receipt.inputRaw, cash)}</dd>
              </>
            ) : (
              <>
                <dt>{t(attempt.status === 'complete' ? 'strategy.form.actualInput' : 'strategy.form.input')}</dt>
                <dd>{shown(attempt.status === 'complete' ? attempt.receipt.inputRaw : attempt.review.amountRaw, input)}</dd>
                <dt>{t(attempt.status === 'complete' ? 'strategy.form.actualOutput' : 'strategy.form.expected')}</dt>
                <dd>{shown(attempt.status === 'complete' ? attempt.receipt.outputRaw : attempt.review.expectedRaw, output)}</dd>
                {attempt.status !== 'complete' && (
                  <>
                    <dt>{t('strategy.form.minimum')}</dt>
                    <dd>{shown(attempt.review.minOutRaw, output)}</dd>
                  </>
                )}
              </>
            )}
          </dl>
          {attempt.status === 'review' && (
            <>
              <p className="strategy-note">{t('strategy.form.minimumHelp')}</p>
              <div className="strategy-controls">
                <button type="button" className="strategy-button" onClick={() => setAttempt({ status: 'entry' })}>{t('strategy.form.edit')}</button>
                <button type="button" className="strategy-button strategy-button--primary" disabled={blocked} onClick={() => void sign(attempt.review)}>
                  {t('strategy.form.sign')}
                </button>
              </div>
            </>
          )}
          {attempt.status === 'wallet' && <p className="strategy-note" role="status">{t('strategy.form.wallet')}</p>}
          {attempt.status === 'confirming' && <p className="strategy-note" role="status">{t('strategy.form.confirming')}</p>}
          {attempt.status === 'unknown' && (
            <>
              <p className="strategy-note" role="alert">{t('strategy.form.unknown')}</p>
              <button className="strategy-button" type="button" onClick={() => void recheck(attempt)}>{t('strategy.form.recheck')}</button>
            </>
          )}
          {signature && <code className="strategy-signature">{signature}</code>}
          {signature && observation.vault.network === 'devnet' && (
            <a className="text-link" href={'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + '?cluster=devnet'} target="_blank" rel="noreferrer">
              {t('strategy.form.explorer')}
            </a>
          )}
          {attempt.status === 'complete' && (
            <>
              <p className="strategy-note" role="status">{t(attempt.syncStatus === 'pending' ? 'strategy.form.syncing'
                : attempt.syncStatus === 'error' ? 'strategy.form.syncFailed' : 'strategy.form.completionHelp')}</p>
              <button className="strategy-button" type="button" disabled={attempt.syncStatus === 'pending' || blocked} onClick={() => {
                setAmount('');
                setAttempt({ status: 'entry' });
              }}>{t('strategy.form.another')}</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

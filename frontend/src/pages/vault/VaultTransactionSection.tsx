import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { VaultListItem } from '../../features/vault/api/listVaults';
import { depositDecimals, formatDepositInput, quoteVaultDeposit } from '../../features/vault/depositQuote';
import { quoteVaultRedeem } from '../../features/vault/redeemQuote';
import { formatVaultAmount } from '../../features/vault/vaultAmounts';
import { usePhantomWallet } from '../../solana/phantomWallet';
import { prepareVaultDeposit } from '../../solana/vault/depositVault';
import type { DevnetVaultState } from '../../solana/vault/devnetVault';
import { prepareVaultRedeem } from '../../solana/vault/redeemVault';
import { type PreparedVaultTransaction, VaultTransactionError, waitForVaultTransaction } from '../../solana/vault/vaultTransaction';
import './styles/vault-transaction.css';

/** 现金金库当前支持的链上操作。 On-chain actions available for a cash vault. */
type VaultAction = 'deposit' | 'redeem';

/** 所选 Devnet 金库及确认后刷新链上读数的方法。 Selected Devnet vault and its post-confirmation refresh callback. */
export interface VaultTransactionSectionProps {
  /** 同时读取的金库和钱包状态，尚无读取结果时为空。 Vault and wallet state read together, undefined until available. */
  state?: DevnetVaultState;
  /** 已登记的金库信息，用于获取代币简称及隔离交易进度。 Registered vault providing token tickers and the transaction scope. */
  vault?: VaultListItem;
  /** 正在首次读取此钱包对应的链上数据。 Initial on-chain reads for the selected wallet are in progress. */
  isReadPending?: boolean;
  /** 最近一次读链失败，需要暂停报价和发起交易。 The latest chain read failed so quoting and submission must pause. */
  isReadError?: boolean;
  /** 成功后按确认所在 slot 或更新读取金库及钱包余额。 Reload vault and wallet balances at or after the confirmed slot. */
  refreshAfterDeposit(slot: number): Promise<void>;
}

/** 用不同操作区分报价和界面文案。 Use the action to determine the quote and its interface copy. */
interface VaultActionSectionProps extends VaultTransactionSectionProps {
  /** 当前表单对应的存入或赎回。 Deposit or redemption represented by this form. */
  action: VaultAction;
}

/** 交易输入、预计到账和最低到账均为各代币的最小单位。 Inputs, estimates and limits are in each token's base units. */
interface ActionQuote {
  /** 用户提供的 mockUSDC 或 GG-V 最小单位数。 Base units of mockUSDC or GG-V supplied by the user. */
  inputRaw: bigint;
  /** 预计收到的 GG-V 或 mockUSDC 最小单位数。 Estimated GG-V or mockUSDC received, in base units. */
  estimatedRaw: bigint;
  /** 写入指令的最低到账最小单位数。 Minimum receivable base units encoded in the instruction. */
  minimumRaw: bigint;
}

/** 两种报价允许的错误代码与各自界面文案对应。 Quote errors for the two actions match their respective interface messages. */
type ActionQuoteError = Extract<
  ReturnType<typeof quoteVaultDeposit> | ReturnType<typeof quoteVaultRedeem>,
  { error: string }
>;

/**
 * 将金额转换为同一链上观测下的交易预览。
 * Convert an amount to a transaction preview from one on-chain observation.
 *
 * @param action 存入或赎回，决定输入和到账代币。 Deposit or redemption, which determines the input and output tokens.
 * @param text 用户输入的金额文本。 User-entered amount text.
 * @param state 已观测的金库和钱包状态。 Observed vault and wallet state.
 */
function quoteVaultAction(action: VaultAction, text: string, state: DevnetVaultState): ActionQuote | ActionQuoteError | null {
  if (!state.wallet || text.trim() === '') return null;

  /** 两种操作共用这一读取结果中的金库余额和份额供给。 Both actions use custody cash and share supply from this read. */
  const { cashRaw, totalSharesRaw, wallet } = state;
  if (action === 'deposit') {
    /** 存入报价的输入为 mockUSDC，到账为 GG-V。 Deposit uses mockUSDC as input and GG-V as output. */
    const result = quoteVaultDeposit(text, { cashRaw, totalSharesRaw, assetBalanceRaw: wallet.assetBalanceRaw });
    return 'error' in result
      ? result
      : { inputRaw: result.assetsRaw, estimatedRaw: result.estimatedSharesRaw, minimumRaw: result.minSharesRaw };
  }

  /** 赎回报价的输入为 GG-V，到账为 mockUSDC。 Redemption uses GG-V as input and mockUSDC as output. */
  const result = quoteVaultRedeem(text, {
    cashRaw,
    totalSharesRaw,
    shareBalanceRaw: wallet.redeemableSharesRaw,
    assetBalanceRaw: wallet.receivableAssetBalanceRaw,
  });
  return 'error' in result
    ? result
    : { inputRaw: result.sharesRaw, estimatedRaw: result.estimatedAssetsRaw, minimumRaw: result.minAssetsRaw };
}

/** 可以在切换页面或刷新时用于恢复查询的公开交易信息。 Public transaction information for resuming confirmation after navigating or reloading. */
interface VaultReceipt {
  /** Phantom 返回的 Devnet 交易签名。 Devnet transaction signature returned by Phantom. */
  signature: string;
  /** 交易 blockhash 的最后有效块高，用于判断未落链是否已经过期。 Last valid block height of the blockhash, for deciding expiry. */
  lastValidBlockHeight: number;
  /** 读确认状态时允许使用的最小 RPC 观测 slot。 Minimum RPC context slot the confirmation check may use. */
  minContextSlot: number;
}

/** 尚无可查询签名时的流程状态和错误文案键。 Workflow states and messages before a signature becomes available. */
type BeforeSignature = 'idle' | 'preparing' | 'awaitingSignature' | 'preparationFailed' | 'quoteChanged'
  | 'insufficientBalance' | 'insufficientSol' | 'insufficientVaultCash' | 'tooManyShareAccounts'
  | 'rejected' | 'walletChanged' | 'approvalPending' | 'submissionFailed';

/** 已知签名时展示确认、失败或未知结果。 Present confirmation, failure, or an unknown outcome when the signature is known. */
type VaultAttempt = { status: BeforeSignature } | {
  /** 交易结果，以及已确认后余额仍在刷新这一展示状态。 Transaction outcome, including post-confirmation balance refresh. */
  status: 'confirming' | 'refreshing' | 'confirmed' | 'confirmationUnknown' | 'transactionFailed' | 'transactionExpired';
  /** 继续确认和跳转区块浏览器使用的公开信息。 Public details used to recheck confirmation and open the explorer. */
  receipt: VaultReceipt;
  /** 交易已确认，但页面未刷新到账金额。 Transaction confirmed, but the page could not refresh received balances. */
  readRefreshFailed?: true;
};

/** 同一个钱包和金库的两种操作共享交易占用状态，并各自保留回执。 The two actions share a transaction lock for one wallet and vault while retaining separate receipts. */
type VaultAttempts = Partial<Record<VaultAction, VaultAttempt>>;

/**
 * 追踪未结交易，阻止同一钱包发起另一条指令。
 * Track unsettled transactions to block another instruction for the same wallet.
 *
 * @param status 当前交易状态，可为空。 Current transaction status, if present.
 */
function isActionPending(status: VaultAttempt['status'] | undefined): boolean {
  return status === 'preparing' || status === 'awaitingSignature' || status === 'confirming'
    || status === 'refreshing' || status === 'confirmationUnknown';
}

/**
 * 从以前存入流程沿用的会话键和对应的赎回键恢复待确认交易。
 * Restore an unsettled transaction from the existing deposit session key or its redemption counterpart.
 *
 * @param depositKey 当前钱包和金库的存入签名存储键。 Deposit signature storage key scoped to the wallet and vault.
 * @param redeemKey 当前钱包和金库的赎回签名存储键。 Redemption signature storage key scoped to the wallet and vault.
 */
function restoreAttempts(depositKey: string | null, redeemKey: string | null): VaultAttempts {
  /** 存入会话沿用已有键；赎回单独恢复，以便只在正确的表单中查询签名。 Keep the existing deposit key and restore redemption separately so signatures are rechecked from the correct form. */
  const deposit = readPendingReceipt(depositKey);
  const redeem = readPendingReceipt(redeemKey);
  return {
    deposit: deposit ? { status: 'confirmationUnknown', receipt: deposit } : undefined,
    redeem: redeem ? { status: 'confirmationUnknown', receipt: redeem } : undefined,
  };
}

/**
 * 从当前浏览器会话恢复待确认的公开签名和有效期。
 * Restore a public signature and its validity window from the current browser session.
 *
 * @param key 按 Devnet 金库和钱包公钥隔离的存储键。 Session key scoped to the Devnet vault and wallet.
 */
function readPendingReceipt(key: string | null): VaultReceipt | undefined {
  if (key === null) return undefined;

  try {
    /** 浏览器存储可被修改，按未知类型检查数值与签名。 Browser storage is mutable, so validate the signature and numeric metadata. */
    const receipt: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (receipt !== null && typeof receipt === 'object'
      && 'signature' in receipt && typeof receipt.signature === 'string'
      && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(receipt.signature)
      && 'lastValidBlockHeight' in receipt && typeof receipt.lastValidBlockHeight === 'number'
      && Number.isSafeInteger(receipt.lastValidBlockHeight) && receipt.lastValidBlockHeight > 0
      && 'minContextSlot' in receipt && typeof receipt.minContextSlot === 'number'
      && Number.isSafeInteger(receipt.minContextSlot) && receipt.minContextSlot >= 0) {
      return {
        signature: receipt.signature,
        lastValidBlockHeight: receipt.lastValidBlockHeight,
        minContextSlot: receipt.minContextSlot,
      };
    }
  } catch {
    // 存储关闭或内容损坏时，内存中的同会话进度仍可用。
    // If storage is blocked or corrupt, in-memory progress still works.
  }
  return undefined;
}

/**
 * 保存或清除待确认的交易。只保存公开签名和有效期，不保存交易字节。
 * Store or clear a pending receipt. Only public signature and validity metadata are stored, without transaction bytes.
 */
function savePendingReceipt(key: string, receipt: VaultReceipt | null): void {
  try {
    if (receipt === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(receipt));
  } catch {
    // 存储不可写时仍在查询缓存记录进度。
    // The query cache still tracks the attempt when storage cannot be written.
  }
}

/**
 * 读出钱包或交易模块提供的业务错误码。
 * Read the domain error code provided by the wallet or transaction module.
 */
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** 预览阶段的代码映射到适合页面的提示。 Map transaction preparation errors to their UI messages. */
function preparationStatus(error: unknown): BeforeSignature {
  switch (errorCode(error)) {
    case 'quoteChanged': return 'quoteChanged';
    case 'insufficientAsset':
    case 'insufficientShares': return 'insufficientBalance';
    case 'insufficientSol': return 'insufficientSol';
    case 'insufficientVaultCash': return 'insufficientVaultCash';
    case 'tooManyShareAccounts': return 'tooManyShareAccounts';
    default: return 'preparationFailed';
  }
}

/** 钱包拒绝、切换或弹窗被占用时保留准确的提示。 Preserve specific rejection, account switch, and approval dialog messages. */
function walletStatus(error: unknown): BeforeSignature {
  switch (errorCode(error)) {
    case 'rejected':
    case 4001: return 'rejected';
    case 'walletChanged': return 'walletChanged';
    case 'approvalPending': return 'approvalPending';
    default: return 'submissionFailed';
  }
}

/**
 * 展示现金金库报价，使用同一流程签名和确认存入或赎回。
 * Present a cash-vault quote and use one workflow to sign and confirm a deposit or redemption.
 */
export function VaultTransactionSection({
  action, state, vault, isReadPending = false, isReadError = false, refreshAfterDeposit: refreshAfterTransaction,
}: VaultActionSectionProps) {
  /** 界面文案与金额格式使用当前的中英文语言。 UI messages and amounts use the selected Chinese or English locale. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 每个操作独立的文案和元素 ID，以便同一页的两张表单同时存在。 Separate message and element namespaces allow both forms on one page. */
  const redeem = action === 'redeem';
  const message = redeem ? 'vaultRedeem.' : 'vaultDeposit.';
  const formId = 'vault-' + action;
  /** 另一种操作可以占用当前金库钱包的交易锁。 The other action can hold the same vault and wallet transaction lock. */
  const otherAction = redeem ? 'deposit' : 'redeem';
  /** 钱包公开地址及由用户触发的交易签名入口。 Wallet public address and the user-triggered transaction signer. */
  const { walletAddress, signAndSendTransaction } = usePhantomWallet();
  /** 现金金库的公开地址用于绑定本次点击和恢复查询。 Public vault address binds this click and its recovered receipt. */
  const vaultAddress = vault?.address;
  /** 用户输入是普通十进制文本，保留编辑中的小数点和尾零。 Decimal input text preserves the in-progress dot and trailing zeroes. */
  const [amount, setAmount] = useState('');
  /** 当前送签报价单独保存，读数刷新时也展示用户实际确认的最低到账金额。 Keep the signing quote so a refreshed read does not change the minimum shown to the user. */
  const [signingQuote, setSigningQuote] = useState<ActionQuote | null>(null);
  /** 离开页面后可以继续确认已签名交易，但不能弹出尚未请求的 Phantom 窗口。 Leaving permits confirmation of a signed transaction but prevents opening a new Phantom prompt. */
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** 查询缓存仅在浏览器会话内共享交易进度，防止切换页面后重复发起。 The query cache shares local attempt state across navigation to prevent duplicate submissions. */
  const queryClient = useQueryClient();
  const attemptKey = ['vault-transaction-attempts', vaultAddress, walletAddress];
  /** 记录钱包已返回的公开签名。存入沿用已有会话键，赎回按相同规则单独存储。 Store returned public signatures. Keep the existing deposit key and store redemptions separately using the same rule. */
  const receiptScope = vaultAddress && walletAddress ? vaultAddress + ':' + walletAddress : null;
  const depositKey = receiptScope ? 'ggboy:devnet:vault-deposit:' + receiptScope : null;
  const redeemKey = receiptScope ? 'ggboy:devnet:vault-redeem:' + receiptScope : null;
  const receiptKey = redeem ? redeemKey : depositKey;
  /** 本地进度在两种表单间共享，不发起 HTTP 请求。 Local progress is shared between both forms without an HTTP request. */
  const { data: attempts } = useQuery<VaultAttempts>({
    queryKey: attemptKey,
    queryFn: skipToken,
    gcTime: Infinity,
    initialData: () => restoreAttempts(depositKey, redeemKey),
  });
  /** 本操作的确认结果和另一操作的占用状态分别用于反馈和禁用按钮。 This action's result drives its feedback, and the other action's progress can disable the form. */
  const attempt = attempts?.[action];
  const status = attempt?.status ?? 'idle';
  const otherStatus = attempts?.[otherAction]?.status;
  const otherPending = isActionPending(otherStatus);
  const editingLocked = isActionPending(status) || otherPending;
  /** 余额由已确认读取决定。存款使用 mockUSDC，赎回使用可销毁的 GG-V。 Use confirmed balances: mockUSDC for deposits and burnable GG-V for redemptions. */
  const walletState = isReadError ? undefined : state?.wallet;
  const balanceRaw = redeem ? walletState?.redeemableSharesRaw : walletState?.assetBalanceRaw;
  const receivingFrozen = redeem && walletState?.receivableAssetBalanceRaw === null;
  /** 签名和确认期间保持报价稳定，其他情况使用同一读数中的现金、份额与余额。 Freeze the quote while signing and confirming; otherwise use cash, supply, and balances from the same read. */
  const quote = state && balanceRaw !== undefined && !receivingFrozen ? quoteVaultAction(action, amount, state) : null;
  const preview = isActionPending(status) ? signingQuote : quote;
  /** 已知签名在等待、失败和成功时都可在区块浏览器检查。 Known signatures can be checked in the explorer during confirmation, after failure, and on success. */
  const receipt = attempt && 'receipt' in attempt ? attempt.receipt : undefined;
  /** 展示简称取自已匹配的金库元数据。输入与到账代币取决于操作方向。 Validated vault metadata supplies symbols; the action determines the input and output tokens. */
  const asset = vault?.quoteAsset.symbol || 'mockUSDC';
  const shares = vault?.shareAsset.symbol || 'GG-V';
  const inputSymbol = redeem ? shares : asset;
  const outputSymbol = redeem ? asset : shares;
  const estimatedMessage = redeem ? 'estimatedAssets' : 'estimatedShares';
  const minimumMessage = redeem ? 'minAssets' : 'minShares';
  /** 输入错误与交易结果分开显示，避免把未知余额当作零。 Separate input errors from transaction results and do not treat an unread balance as zero. */
  const quoteError = preview && 'error' in preview ? preview.error : null;

  /** 写入当前点击所属的钱包和金库状态，切换后也不会混用。 Write progress to the exact vault and wallet of this attempt even after switching. */
  function setAttempt(next: VaultAttempt) {
    queryClient.setQueryData<VaultAttempts>(attemptKey, (current) => ({ ...current, [action]: next }));
  }

  /**
   * 按签名查看 Devnet 确认结果，成功后只刷新该笔交易对应的链上读数。
   * Check the Devnet transaction by signature and refresh the matching chain reads after confirmation.
   */
  async function confirmTransaction(knownReceipt: VaultReceipt, storageKey: string) {
    setAttempt({ status: 'confirming', receipt: knownReceipt });

    /** 已执行交易在 Devnet 上的 slot，后续余额读取至少达到这个 slot。 Executed transaction's Devnet slot, the lower bound for subsequent balance reads. */
    let confirmedSlot: number;
    try {
      confirmedSlot = await waitForVaultTransaction(knownReceipt.signature, knownReceipt);
    } catch (error) {
      // 查到链上执行失败或确认过期后才能清除待确认签名。传输失败保留原签名。
      // Clear the pending signature only after reading an execution failure or confirmed expiry. Keep it on transport failures.
      if (error instanceof VaultTransactionError && (error.code === 'transactionFailed' || error.code === 'expired')) {
        savePendingReceipt(storageKey, null);
        setAttempt({
          status: error.code === 'expired' ? 'transactionExpired' : 'transactionFailed',
          receipt: knownReceipt,
        });
      } else {
        setAttempt({ status: 'confirmationUnknown', receipt: knownReceipt });
      }
      return;
    }

    savePendingReceipt(storageKey, null);
    if (mounted.current) setAmount('');
    setAttempt({ status: 'refreshing', receipt: knownReceipt });
    try {
      await refreshAfterTransaction(confirmedSlot);
      setAttempt({ status: 'confirmed', receipt: knownReceipt });
    } catch {
      // 余额更新失败不会改变已确认的交易结果。
      // A failed balance refresh does not change the confirmed transaction outcome.
      setAttempt({ status: 'confirmed', receipt: knownReceipt, readRefreshFailed: true });
    }
  }

  /**
   * 锁定本次预览并准备交易。只有链上模拟通过后才向 Phantom 请求签名。
   * Freeze this quote and prepare the transaction. Request a Phantom signature only after chain simulation passes.
   */
  async function submitTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!walletAddress || !receiptKey || !state?.wallet || !quote || 'error' in quote) return;

    // 在网络请求之前同步检查并更新缓存，拦截同一钱包的连点或返回页面后再次点击。
    // Check and update the cache synchronously before any network request to block rapid clicks and remounts.
    const current = queryClient.getQueryData<VaultAttempts>(attemptKey);
    if (isActionPending(current?.deposit?.status) || isActionPending(current?.redeem?.status)) return;
    setSigningQuote(quote);
    setAttempt({ status: 'preparing' });

    /** 包含本次金额、最低到账及 blockhash 有效期的待签名交易。 Unsigned transaction containing amounts and its blockhash validity window. */
    let prepared: PreparedVaultTransaction;
    try {
      prepared = redeem
        ? await prepareVaultRedeem({
          walletAddress,
          sharesRaw: quote.inputRaw,
          minAssetsRaw: quote.minimumRaw,
          minContextSlot: state.slot,
          shareAccounts: state.wallet.shareAccounts,
        })
        : await prepareVaultDeposit({
          walletAddress,
          assetsRaw: quote.inputRaw,
          minSharesRaw: quote.minimumRaw,
          minContextSlot: state.slot,
        });
    } catch (error) {
      setAttempt({ status: preparationStatus(error) });
      return;
    }

    if (!mounted.current) {
      setAttempt({ status: 'idle' });
      return;
    }
    setAttempt({ status: 'awaitingSignature' });

    /** 钱包广播交易后提供可公开查询的签名。 Publicly queryable signature returned after the wallet broadcasts the transaction. */
    let signature: string;
    try {
      signature = await signAndSendTransaction(prepared.transaction, walletAddress, prepared.minContextSlot);
    } catch (error) {
      setAttempt({ status: walletStatus(error) });
      return;
    }

    /** 仅记录用于恢复状态查询的公开值。 Keep only public fields required to resume checking the attempt. */
    const knownReceipt = {
      signature,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      minContextSlot: prepared.minContextSlot,
    };
    savePendingReceipt(receiptKey, knownReceipt);
    await confirmTransaction(knownReceipt, receiptKey);
  }

  /** 重新查询同一个签名，始终不构造或广播另一笔交易。 Recheck the same signature without preparing or broadcasting another transaction. */
  function recheckTransaction() {
    /** 恢复原交易时同样检查另一操作是否正在确认。 Allow only one active confirmation even when recovering a saved transaction. */
    const current = queryClient.getQueryData<VaultAttempts>(attemptKey);
    const pending = current?.[action];
    const other = current?.[otherAction]?.status;
    if (receiptKey && pending?.status === 'confirmationUnknown'
      && (!isActionPending(other) || other === 'confirmationUnknown')) {
      void confirmTransaction(pending.receipt, receiptKey);
    }
  }

  return (
    <section className="vault-transaction" aria-labelledby={formId + '-title'}>
      <h2 id={formId + '-title'}>{t(message + 'title')}</h2>
      {walletAddress === null ? (
        <p className="vault-transaction__notice">{t(message + 'connectPrompt')}</p>
      ) : (
        <form className="vault-transaction__form" onSubmit={submitTransaction}>
          <div className="vault-transaction__field">
            <label htmlFor={formId + '-amount'}>{t(message + 'amount')} ({inputSymbol})</label>
            <div className="vault-transaction__input-row">
              <input
                id={formId + '-amount'}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                maxLength={27}
                placeholder="0.00"
                value={amount}
                disabled={editingLocked || balanceRaw === undefined || receivingFrozen}
                aria-invalid={quoteError !== null}
                aria-describedby={quoteError ? formId + '-balance ' + formId + '-quote-error' : formId + '-balance'}
                onChange={(event) => setAmount(event.currentTarget.value)}
              />
              <button
                type="button"
                className="vault-transaction__max"
                disabled={editingLocked || balanceRaw === undefined || balanceRaw === 0n || receivingFrozen}
                onClick={() => balanceRaw !== undefined && setAmount(formatDepositInput(balanceRaw))}
              >
                {t(message + 'useMax')}
              </button>
            </div>
            <p id={formId + '-balance'} className="vault-transaction__hint">
              {balanceRaw === undefined
                ? t(message + (isReadPending && !isReadError ? 'readPending' : 'balanceUnavailable'))
                : <>{t(message + 'availableBalance')} {formatVaultAmount(balanceRaw, depositDecimals, locale)} {inputSymbol}</>}
            </p>
            {receivingFrozen && (
              <p className="vault-transaction__error" role="alert">{t(message + 'receivingAccountFrozen')}</p>
            )}
            {quoteError && (
              <p id={formId + '-quote-error'} className="vault-transaction__error" role="alert">{t(message + quoteError)}</p>
            )}
          </div>

          {preview && 'estimatedRaw' in preview && (
            <div className="vault-transaction__quote">
              <dl>
                <div>
                  <dt>{t(message + estimatedMessage)}</dt>
                  <dd>{formatVaultAmount(preview.estimatedRaw, depositDecimals, locale)} {outputSymbol}</dd>
                </div>
                <div>
                  <dt>{t(message + minimumMessage)}</dt>
                  <dd>{formatVaultAmount(preview.minimumRaw, depositDecimals, locale)} {outputSymbol}</dd>
                </div>
              </dl>
              <p className="vault-transaction__hint">{t(message + 'toleranceHint')}</p>
            </div>
          )}

          <button
            type="submit"
            className="vault-transaction__submit"
            disabled={editingLocked || quote === null || 'error' in quote}
          >
            {t(message + 'submit')}
          </button>
          {otherPending && (
            <p className="vault-transaction__hint" role="status">{t(message + 'otherActionPending')}</p>
          )}
          {status !== 'idle' && (
            <div className="vault-transaction__feedback" role="status">
              <p>{t(message + status)}</p>
              {attempt && 'readRefreshFailed' in attempt && attempt.readRefreshFailed && (
                <p>{t(message + 'readRefreshFailed')}</p>
              )}
              {receipt && (
                <a
                  href={'https://explorer.solana.com/tx/' + encodeURIComponent(receipt.signature) + '?cluster=devnet'}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t(message + 'explorerLink')}
                </a>
              )}
              {status === 'confirmationUnknown' && (
                <button
                  type="button"
                  className="vault-transaction__max"
                  disabled={otherPending && otherStatus !== 'confirmationUnknown'}
                  onClick={recheckTransaction}
                >
                  {t(message + 'recheck')}
                </button>
              )}
            </div>
          )}
        </form>
      )}
    </section>
  );
}

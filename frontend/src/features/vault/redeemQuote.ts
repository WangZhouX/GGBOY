import { maxCashVaultTokenAmount, minimumCashVaultOutput, parseCashVaultAmount } from './cashVaultAmounts';

/** 请求报价所用的同 slot 余额，单位为各 Mint 最小单位。 Same-slot balance inputs for the quote, in each mint's base units. */
export interface RedeemQuoteInputs {
  /** 本笔可即时支付的 mockUSDC，自动收回启用时含池内可提金额。 Immediately payable mockUSDC, including withdrawable pool cash when recall is enabled. */
  cashRaw: bigint;
  /** 含策略持仓和出借仓位的总净值，单位为 mockUSDC 最小单位，无法估值时为空。 NAV including strategy and lending positions in mockUSDC base units, or null when valuation is unavailable. */
  navRaw: bigint | null;
  /** 未能在本笔交易清空的非现金仓位阻止销毁最后一份 GG-V。 Positions that cannot be unwound in this transaction prevent burning the last GG-V. */
  hasNonCashPosition: boolean;
  /** GG-V Mint 的总供给量。 Total supply of the GG-V mint. */
  totalSharesRaw: bigint;
  /** 钱包可销毁的 GG-V 数量，忽略不能作为来源的冻结账户。 GG-V the wallet can burn, excluding frozen sources. */
  shareBalanceRaw: bigint;
  /** 钱包收款账户余额，未创建时是零，账户已冻结时为空。 Wallet payout account balance, zero before creation and null when frozen. */
  assetBalanceRaw: bigint | null;
}

/** 对应界面文案的赎回报价错误。 Redemption quote errors with matching UI messages. */
type RedeemQuoteError = 'amountInvalid' | 'insufficientBalance' | 'invalidVaultPrice'
  | 'quoteTooSmall' | 'quoteOverflow' | 'receivingAccountFrozen' | 'insufficientVaultCash' | 'lastSharesRequireCash';

/** 赎回预览或需要处理的原因。 Redemption preview or a validation error. */
type RedeemQuote = { error: RedeemQuoteError } | {
  /** 将销毁的 GG-V 最小单位数量。 GG-V base units to burn. */
  sharesRaw: bigint;
  /** 预计到账的 mockUSDC 最小单位数量。 Estimated payout in mockUSDC base units. */
  estimatedAssetsRaw: bigint;
  /** 用户接受的最低 mockUSDC 最小单位数量。 Minimum accepted payout in mockUSDC base units. */
  minAssetsRaw: bigint;
};

/**
 * 按链上赎回公式向下取整报价，并计算保护用户的最低到账数量。
 * Floor the quote with the on-chain redemption formula and compute the user's minimum accepted payout.
 *
 * @param text 用户输入的 GG-V 数量，最多六位小数。 GG-V entered by the user, with up to six decimal places.
 * @param inputs 同一次读链的净值、份额和收款账户。 NAV, shares, and payout account from the same read.
 */
export function quoteVaultRedeem(
  text: string,
  { cashRaw, navRaw, hasNonCashPosition, totalSharesRaw, shareBalanceRaw, assetBalanceRaw }: RedeemQuoteInputs,
): RedeemQuote {
  /** 需要销毁的 GG-V，已限定在正的 u64 范围。 GG-V to burn, bounded to a positive u64. */
  const sharesRaw = parseCashVaultAmount(text);
  if (sharesRaw === null) return { error: 'amountInvalid' };
  if (sharesRaw > shareBalanceRaw) return { error: 'insufficientBalance' };
  if (assetBalanceRaw === null) return { error: 'receivingAccountFrozen' };
  if (navRaw === null || navRaw <= 0n || totalSharesRaw <= 0n || sharesRaw > totalSharesRaw) {
    return { error: 'invalidVaultPrice' };
  }
  if (sharesRaw === totalSharesRaw && hasNonCashPosition) return { error: 'lastSharesRequireCash' };

  // 按赎回前的总净值统一向下取整，实付受当前托管现金约束。
  // Price the full redemption from pre-redemption NAV, flooring once and limiting payment to current custody cash.
  const estimatedAssetsRaw = navRaw * sharesRaw / totalSharesRaw;
  if (estimatedAssetsRaw === 0n) return { error: 'quoteTooSmall' };
  if (estimatedAssetsRaw > cashRaw) return { error: 'insufficientVaultCash' };
  if (assetBalanceRaw + estimatedAssetsRaw > maxCashVaultTokenAmount) return { error: 'quoteOverflow' };

  return { sharesRaw, estimatedAssetsRaw, minAssetsRaw: minimumCashVaultOutput(estimatedAssetsRaw) };
}

/**
 * 计算此钱包在现有现金和收款余额约束下可执行的最大赎回。
 * Find the largest executable redemption for this wallet within custody cash and destination balance limits.
 *
 * @param inputs 与报价相同的链上读数，单位为各自 Mint 最小单位。 The same on-chain inputs used for a quote, in each mint's base units.
 * @returns 最大份额和应付金额。缺少有效净值时为空。 Maximum shares and payout, or null without a valid NAV.
 */
export function getVaultRedemptionLimit({
  cashRaw, navRaw, hasNonCashPosition, totalSharesRaw, shareBalanceRaw, assetBalanceRaw,
}: RedeemQuoteInputs): { sharesRaw: bigint; assetsRaw: bigint } | null {
  if (navRaw === null || (totalSharesRaw === 0n && navRaw > 0n)) return null;
  if (totalSharesRaw === 0n || navRaw === 0n || assetBalanceRaw === null || shareBalanceRaw === 0n) {
    return { sharesRaw: 0n, assetsRaw: 0n };
  }

  /** 金库状态允许的最大销毁量，必要时至少保留一个最小单位。 Largest burn allowed by vault state, keeping at least one base unit if necessary. */
  const supplyLimit = hasNonCashPosition ? totalSharesRaw - 1n : totalSharesRaw;
  /** 钱包余额和总供给共同限制可销毁份额。 The wallet and total supply both limit shares available to burn. */
  const walletLimit = shareBalanceRaw < supplyLimit ? shareBalanceRaw : supplyLimit;
  /** 到账余额还可容纳的 mockUSDC 最小单位。 Remaining capacity of the destination account in mockUSDC base units. */
  const receivingCapacity = maxCashVaultTokenAmount - assetBalanceRaw;
  const payoutLimit = cashRaw < receivingCapacity ? cashRaw : receivingCapacity;

  // 解 floor(NAV × s / supply) ≤ payout 得到精确上限，包含可以向下舍入到现金上限的份额。
  // Invert floor(NAV × s / supply) ≤ payout exactly, including shares whose payout rounds down to the cash limit.
  const cashLimitedShares = ((payoutLimit + 1n) * totalSharesRaw - 1n) / navRaw;
  const sharesRaw = walletLimit < cashLimitedShares ? walletLimit : cashLimitedShares;
  const assetsRaw = navRaw * sharesRaw / totalSharesRaw;
  return { sharesRaw: assetsRaw > 0n ? sharesRaw : 0n, assetsRaw };
}

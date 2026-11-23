import { maxCashVaultTokenAmount, minimumCashVaultOutput, parseCashVaultAmount } from './cashVaultAmounts';

/** 请求报价所用的同 slot 余额，单位为各 Mint 最小单位。 Same-slot balance inputs for the quote, in each mint's base units. */
interface RedeemQuoteInputs {
  /** 金库托管账户中的 mockUSDC。 mockUSDC in the vault custody account. */
  cashRaw: bigint;
  /** GG-V Mint 的总供给量。 Total supply of the GG-V mint. */
  totalSharesRaw: bigint;
  /** 钱包可销毁的 GG-V 数量，忽略不能作为来源的冻结账户。 GG-V the wallet can burn, excluding frozen sources. */
  shareBalanceRaw: bigint;
  /** 钱包收款账户余额，未创建时是零，账户已冻结时为空。 Wallet payout account balance, zero before creation and null when frozen. */
  assetBalanceRaw: bigint | null;
}

/** 对应界面文案的赎回报价错误。 Redemption quote errors with matching UI messages. */
type RedeemQuoteError = 'amountInvalid' | 'insufficientBalance' | 'invalidVaultPrice'
  | 'quoteTooSmall' | 'quoteOverflow' | 'receivingAccountFrozen';

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
  { cashRaw, totalSharesRaw, shareBalanceRaw, assetBalanceRaw }: RedeemQuoteInputs,
): RedeemQuote {
  /** 需要销毁的 GG-V，已限定在正的 u64 范围。 GG-V to burn, bounded to a positive u64. */
  const sharesRaw = parseCashVaultAmount(text);
  if (sharesRaw === null) return { error: 'amountInvalid' };
  if (sharesRaw > shareBalanceRaw) return { error: 'insufficientBalance' };
  if (assetBalanceRaw === null) return { error: 'receivingAccountFrozen' };
  if (cashRaw <= 0n || totalSharesRaw <= 0n || sharesRaw > totalSharesRaw) {
    return { error: 'invalidVaultPrice' };
  }

  // 全部份额按同一赎回指令定价，只做一次向下取整。
  // Quote all input shares with one redeem instruction and round down only once.
  const estimatedAssetsRaw = cashRaw * sharesRaw / totalSharesRaw;
  if (estimatedAssetsRaw === 0n) return { error: 'quoteTooSmall' };
  if (assetBalanceRaw + estimatedAssetsRaw > maxCashVaultTokenAmount) return { error: 'quoteOverflow' };

  return { sharesRaw, estimatedAssetsRaw, minAssetsRaw: minimumCashVaultOutput(estimatedAssetsRaw) };
}

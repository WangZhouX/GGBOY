import { maxCashVaultTokenAmount, minimumCashVaultOutput, parseCashVaultAmount } from './cashVaultAmounts';

export { cashVaultDecimals as depositDecimals, formatCashVaultInput as formatDepositInput } from './cashVaultAmounts';

/** 同一链上读数提供的存入定价与钱包余额，以各自 Mint 最小单位计。 Deposit pricing and wallet balance from the same chain read, in each mint's base units. */
interface DepositQuoteInputs {
  /** 金库现金托管账户的 mockUSDC。 mockUSDC in the cash custody account. */
  cashRaw: bigint;
  /** 按同一链上状态估值的总净值，以 mockUSDC 最小单位计，缺少必要估值时为空。 Total NAV from the same observation, in mockUSDC base units, or null if required pricing is unavailable. */
  navRaw: bigint | null;
  /** GG-V Mint 当前总供给。 Current GG-V mint supply. */
  totalSharesRaw: bigint;
  /** 本次交易扣款所用关联账户的 mockUSDC。 mockUSDC in the associated account used to fund the deposit. */
  assetBalanceRaw: bigint;
}

/** 对应可本地化提示的报价失败原因。 Quote failure reasons with matching localized messages. */
type DepositQuoteError = 'amountInvalid' | 'insufficientBalance' | 'invalidVaultPrice' | 'quoteTooSmall' | 'quoteOverflow';

/** 可提交的金额报价，或需要解决的输入问题。 Submit-ready amounts or an input issue to resolve. */
type DepositQuote = { error: DepositQuoteError } | {
  /** 存入的 mockUSDC 最小单位。 Deposited mockUSDC base units. */
  assetsRaw: bigint;
  /** 用当前净值和供给估算的 GG-V 最小单位。 GG-V base units estimated using NAV and share supply. */
  estimatedSharesRaw: bigint;
  /** 写入链上指令的最低 GG-V 最小单位。 Minimum GG-V base units encoded in the on-chain instruction. */
  minSharesRaw: bigint;
};

/**
 * 用程序相同的向下取整计算份额，再按 50 基点偏差向上取整最低到账数量。
 * Calculate shares with the program's floor rounding, then round the minimum up at a 50 basis point tolerance.
 *
 * @param text 带小数点的 mockUSDC 输入。 Decimal mockUSDC input.
 * @param inputs 同一链上读取获得的最小单位状态。 Chain inputs read together, in base units.
 * @returns 供展示和构造指令使用的数值或错误。 Values for display and instruction construction, or an error.
 */
export function quoteVaultDeposit(text: string, { cashRaw, navRaw, totalSharesRaw, assetBalanceRaw }: DepositQuoteInputs): DepositQuote {
  /** 严格校验后的 mockUSDC 最小单位金额。 Validated mockUSDC amount in base units. */
  const assetsRaw = parseCashVaultAmount(text);
  if (assetsRaw === null) return { error: 'amountInvalid' };
  if (assetsRaw > assetBalanceRaw) return { error: 'insufficientBalance' };
  if (navRaw === null || (navRaw === 0n) !== (totalSharesRaw === 0n)) return { error: 'invalidVaultPrice' };

  // 空金库两种 Mint 的精度相同，按 1:1 铸造，后续以存入前的净值和供给按比例计算。
  // An empty vault issues 1:1 because both mints have equal precision. Later deposits use pre-deposit NAV and supply.
  const estimatedSharesRaw = navRaw === 0n ? assetsRaw : assetsRaw * totalSharesRaw / navRaw;
  if (estimatedSharesRaw === 0n) return { error: 'quoteTooSmall' };
  if (assetsRaw + cashRaw > maxCashVaultTokenAmount || estimatedSharesRaw + totalSharesRaw > maxCashVaultTokenAmount) {
    return { error: 'quoteOverflow' };
  }

  // 除法向上舍入，避免少量份额因向下取整突破 0.5% 偏差，也保证最低数量为正。
  // Round the division up so small quotes stay within 0.5% drift and the minimum stays positive.
  const minSharesRaw = minimumCashVaultOutput(estimatedSharesRaw);
  return { assetsRaw, estimatedSharesRaw, minSharesRaw };
}

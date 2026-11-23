/** 现金金库的 mockUSDC 和 GG-V 共用六位小数。 Both classic cash vault mints use six decimals. */
export const cashVaultDecimals = 6;
/** SPL Token 最小单位使用 u64，最大值用于校验输入和到账余额。 SPL Token amounts use u64, bounding input and resulting balances. */
export const maxCashVaultTokenAmount = (1n << 64n) - 1n;
/** 一枚完整代币所包含的最小单位数。 Number of base units in a whole token. */
const unitsPerToken = 10n ** BigInt(cashVaultDecimals);
/** 100% 为 10,000 个基点，默认允许报价下调 50 个基点。 10,000 basis points represents 100%; the expected output may decrease by 50 basis points. */
const basisPointScale = 10_000n;
const retainedQuoteBps = basisPointScale - 50n;

/**
 * 将十进制输入转换为现金金库的最小单位，保留六位小数精度。
 * Convert a decimal token input to base units with six decimals of precision.
 *
 * @param text 用户输入的代币数量。 User-entered token amount.
 * @returns 正的 u64 数量，超出范围或精度时为空。 Positive u64 amount, or null if its range or precision is invalid.
 */
export function parseCashVaultAmount(text: string): bigint | null {
  /** 允许编辑中的尾随小数点和省略前导零的小数。 Allow a trailing decimal point or a fraction without its leading zero. */
  const match = /^(?:([0-9]{1,20})(?:\.([0-9]{0,6}))?|\.([0-9]{1,6}))$/.exec(text.trim());
  if (!match) return null;

  /** 补足精度后的代币最小单位数。 Token base units after decimal padding. */
  const rawAmount = BigInt(match[1] ?? '0') * unitsPerToken + BigInt((match[2] ?? match[3] ?? '').padEnd(cashVaultDecimals, '0'));
  return rawAmount > 0n && rawAmount <= maxCashVaultTokenAmount ? rawAmount : null;
}

/**
 * 允许报价下调最多 0.5%，向上取整得到链上最低份额或到账金额。
 * Allow up to a 0.5% decrease and round the minimum on-chain output up.
 *
 * @param expectedRaw 正的预期份额或到账金额，使用代币最小单位。 Positive expected shares or payout, in token base units.
 */
export function minimumCashVaultOutput(expectedRaw: bigint): bigint {
  // 小额也保留正数下限，实际可接受的偏差至多为 50 个基点。
  // Keep a positive bound for small amounts and allow at most 50 basis points of drift.
  return (expectedRaw * retainedQuoteBps + basisPointScale - 1n) / basisPointScale;
}

/**
 * 为「全部」按钮生成无分组符的小数文本。
 * Format a decimal input without grouping separators for the Max button.
 *
 * @param rawAmount 代币最小单位数。 Token amount in base units.
 * @returns 用小数点分隔的数量文本。 Decimal token text using a period separator.
 */
export function formatCashVaultInput(rawAmount: bigint): string {
  /** 把精确的最小单位切成整数部分和六位小数。 Split the exact base units into whole and fractional parts. */
  const digits = rawAmount.toString().padStart(cashVaultDecimals + 1, '0');
  const whole = digits.slice(0, -cashVaultDecimals);
  const fraction = digits.slice(-cashVaultDecimals).replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}

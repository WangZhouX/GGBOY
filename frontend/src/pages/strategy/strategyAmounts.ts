import { maxCashVaultTokenAmount } from '../../features/vault/cashVaultAmounts';

/**
 * 将管理者输入的正数转换成当前资产的 u64 最小单位。
 * Convert the manager's positive decimal input to the current asset's u64 base units.
 *
 * @param text 表单使用小数点分隔的金额文本。 Form amount using a decimal point.
 * @param decimals 链上已核验的资产或池份额精度。 Verified on-chain precision of the asset or pool shares.
 * @returns 正的最小单位金额，超出精度或范围时为空。 Positive amount in base units, or null for an invalid precision or range.
 */
export function parseStrategyAmount(text: string, decimals: number): bigint | null {
  /** 支持正常整数及省去前导零的小数，拒绝负数、指数和分组符号。 Accept plain integers and fractions without a leading zero, rejecting signs, exponents, and grouping. */
  const match = /^(?:([0-9]{1,20})(?:\.([0-9]*))?|\.([0-9]+))$/.exec(text.trim());
  if (!match) return null;
  /** 以输入资产的精度补零，完全使用整数计算。 Pad to the input asset's precision and calculate entirely with integers. */
  const fraction = match[2] ?? match[3] ?? '';
  if (fraction.length > decimals) return null;
  const raw = BigInt(match[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return raw > 0n && raw <= maxCashVaultTokenAmount ? raw : null;
}

/**
 * 按资产精度格式化供「使用上限」写回金额框的十进制文本。
 * Format base units for the form's Use maximum control at the asset precision.
 *
 * @param raw 已核验的输入上限，单位为所选资产或份额的最小单位。 Verified input limit in the selected asset's or share's base units.
 * @param decimals 当前资产或池份额精度。 Current asset or pool share precision.
 */
export function strategyAmountInput(raw: bigint, decimals: number): string {
  /** 整数除法和余数保留输入所需的全部小数位。 Integer division and remainder preserve all fractional input digits. */
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? whole.toString() + '.' + fraction : whole.toString();
}

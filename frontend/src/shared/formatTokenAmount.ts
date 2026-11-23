/**
 * 按资产精度将整数最小单位格式化为本地化金额，保留所有有效小数位。
 * Format integer base units as a localized amount at the asset's precision, preserving all significant fractional digits.
 *
 * @param raw 非负整数或其十进制文本，以最小单位计。 Nonnegative integer or its decimal text in base units.
 * @param decimals 资产最小单位对应的小数位数，必须为非负整数。 Nonnegative number of fractional digits in the asset's base unit.
 * @param locale 控制数字分组与小数点的界面语言。 UI locale for digit grouping and the decimal separator.
 * @returns 去掉末尾零且不带资产简称的金额文本。 Amount text with trailing zeros trimmed and no asset ticker.
 */
export function formatTokenAmount(raw: string | bigint, decimals: number, locale: string): string {
  // 切分整数文本，避免整数经过浮点数转换而丢失精度。
  // Split the integer text without converting the balance to a floating-point number.
  const digits = BigInt(raw).toString().padStart(decimals + 1, '0');
  const decimalIndex = digits.length - decimals;

  /** 保留前导零，去掉小数末尾的零。 Preserve leading fractional zeros and trim trailing zeros. */
  const fraction = digits.slice(decimalIndex).replace(/0+$/, '');

  /** 按当前语言显示整数分组、小数点和数字字形。 Locale-specific grouping, decimal separator, and digit glyphs. */
  const formatter = new Intl.NumberFormat(locale);
  const whole = formatter.format(BigInt(digits.slice(0, decimalIndex)));
  if (!fraction) return whole;

  // 样例只用于取小数点符号，实际小数位逐位格式化以保留精度。
  // Use a sample only to find the separator; format each actual fractional digit independently.
  const separator = formatter.formatToParts(0.1).find((part) => part.type === 'decimal')?.value ?? '.';
  const fractionText = fraction.replace(/[0-9]/g, (digit) => formatter.format(BigInt(digit)));
  return whole + separator + fractionText;
}

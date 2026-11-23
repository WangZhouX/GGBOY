import { formatTokenAmount } from '../../shared/formatTokenAmount';

/** 对外保留金库的金额格式化入口，使用共享的精确格式化。 Keep the vault formatting entry point backed by the shared exact formatter. */
export { formatTokenAmount as formatVaultAmount };

/** 每份净值保留的最大小数位数。 Maximum fractional digits shown for NAV per share. */
const navDisplayDecimals = 6;

/**
 * 将每份净值换算成指定精度的定点整数，供概况展示和历史绘图共同使用。
 * Convert NAV per share to a fixed-point integer at the requested precision for the overview and chart.
 *
 * @param navRaw 可估值的总净值，以计价资产最小单位计。 Available NAV in quote asset base units.
 * @param totalSharesRaw 已发行份额的最小单位数量，必须为正。 Positive outstanding supply in share base units.
 * @param quoteDecimals 计价资产 Mint 的小数位数。 Quote mint decimal places.
 * @param shareDecimals 份额 Mint 的小数位数。 Share mint decimal places.
 * @param outputDecimals 返回的定点整数所用小数位数。 Decimal places of the fixed-point result.
 * @returns 按输出精度向下舍入的每份净值。 NAV per share rounded down at the requested precision.
 */
export function calculateVaultNavPerShareRaw(
  navRaw: string,
  totalSharesRaw: string,
  quoteDecimals: number,
  shareDecimals: number,
  outputDecimals: number,
): bigint {
  // 按两种 Mint 精度换算后再做整数除法，保留调用方需要的小数位。
  // Apply both mint precisions before integer division to retain the caller's requested decimal places.
  const numerator = BigInt(navRaw) * 10n ** BigInt(shareDecimals + outputDecimals);
  const denominator = BigInt(totalSharesRaw) * 10n ** BigInt(quoteDecimals);
  return numerator / denominator;
}

/**
 * 用整数按计价资产及份额的精度换算每份净值，并向下保留到六位小数。
 * Computes NAV per share with integer arithmetic using quote and share precisions, rounded down to six fractional digits.
 *
 * @param navRaw 可估值的总净值，以计价资产最小单位计。 Available total NAV in quote asset base units.
 * @param totalSharesRaw 已发行份额的最小单位数量，必须为正。 Positive outstanding shares in share asset base units.
 * @param quoteDecimals 计价资产 Mint 精度。 Quote asset mint precision.
 * @param shareDecimals 份额 Mint 精度。 Share mint precision.
 * @param locale 界面语言标记，用于数字分组和小数点。 UI locale tag for grouping and the decimal separator.
 * @returns 每一整份份额对应的计价资产文本，正值小于展示精度时以小于号标示。 Quote asset per whole share as text, with a less-than sign for positive sub-resolution values.
 */
export function formatVaultNavPerShare(
  navRaw: string,
  totalSharesRaw: string,
  quoteDecimals: number,
  shareDecimals: number,
  locale: string,
): string {
  /** 用现有六位展示精度换算后的每份净值。 NAV per share at the existing six-place display precision. */
  const displayRaw = calculateVaultNavPerShareRaw(navRaw, totalSharesRaw, quoteDecimals, shareDecimals, navDisplayDecimals);
  // 小于展示精度的正值用小于号表达。
  // Use a less-than sign for positive amounts below display precision.
  if (displayRaw === 0n && BigInt(navRaw) > 0n) {
    return '<' + formatTokenAmount(1n, navDisplayDecimals, locale);
  }
  return formatTokenAmount(displayRaw, navDisplayDecimals, locale);
}

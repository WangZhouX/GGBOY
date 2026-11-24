import type { LendingMarketAsset } from '../../features/lending/api/listLendingMarkets';
import { formatTokenAmount } from '../../shared/formatTokenAmount';

/**
 * 显示资产简称，元数据没有简称时使用明确的 Mint 缩写。
 * Show the asset ticker, falling back to an identifiable mint abbreviation.
 *
 * @param asset 公开市场登记的资产元数据。 Asset metadata from the public lending registry.
 * @returns 资产简称或 Mint 公钥缩写。 Asset ticker or mint public key abbreviation.
 */
export function positionAssetLabel(asset: LendingMarketAsset): string {
  return asset.symbol?.trim() || asset.mint.slice(0, 4) + '…' + asset.mint.slice(-4);
}

/**
 * 将最小单位资产金额格式化为本地化的完整金额。
 * Format an asset amount in base units as a localized exact amount.
 *
 * @param raw SPL Token 最小单位的整数字符串。 Integer string in SPL Token base units.
 * @param asset 该金额对应 Mint 的精度及简称。 Decimal precision and ticker of the mint used for this amount.
 * @param locale 界面语言。 Interface language tag.
 * @returns 带资产简称的显示金额。 Display amount with asset ticker.
 */
export function formatPositionAmount(raw: string, asset: LendingMarketAsset, locale: string): string {
  return formatTokenAmount(raw, asset.decimals, locale) + ' ' + positionAssetLabel(asset);
}

/**
 * 精确展示接口直接给出的定点数，价格、比率和健康度都保留原有有效位。
 * Format server decimals exactly, preserving significant digits of prices, ratios, and health factors.
 *
 * @param value 非负十进制定点文本。 Nonnegative decimal string.
 * @param locale 界面语言。 Interface language tag.
 * @param asPercent 将无量纲比率换算成百分比。 Whether to convert a dimensionless ratio to a percentage.
 * @returns 精确的本地化小数或百分比文本。 Exact localized decimal or percentage text.
 */
export function formatPositionDecimal(value: string, locale: string, asPercent = false): string {
  /** 小数位数确定定点缩放，乘以 100 用整数完成。 Fraction length supplies the fixed-point scale, and multiplication by 100 uses integers. */
  const [whole, fraction = ''] = value.split('.');
  const raw = BigInt(whole + fraction);
  return asPercent
    ? formatTokenAmount(raw * 100n, fraction.length, locale) + '%'
    : formatTokenAmount(raw, fraction.length, locale);
}

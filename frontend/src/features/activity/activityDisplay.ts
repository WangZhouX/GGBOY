import { formatTokenAmount } from '../../shared/formatTokenAmount';
import type { Network } from '../../shared/navigation/network';
import { devnetVaultConfig } from '../../solana/vault/devnetVault';
import type { ActivityAsset } from './api/listActivities';

/** 来自 GGBOY Devnet 部署且已知显示简称的 Mint。 Mint tickers known from the GGBOY Devnet deployment. */
const knownDevnetMints = new Map<string, string>([
  [devnetVaultConfig.assetMint.toBase58(), 'mockUSDC'],
  [devnetVaultConfig.shareMint.toBase58(), 'GG-V'],
  // 借贷市场在 Devnet 登记的测试抵押 Mint，以完整公钥区分同名代币。
  // Match the registered Devnet test collateral mint by its full public key to distinguish tokens with the same ticker.
  ['AfJQ7YcnvUDncihfh9NoeF41Bw6eiB1eFcubmdw9fAg1', 'tSOL'],
]);

/** 借贷操作预期的资产变动代码，用于补充资金流向的上下文。 Expected movement codes for lending operations, used to clarify the directions. */
const lendingLegTypes = new Map([
  ['LENDING_DEPOSIT_COLLATERAL', 'ASSET_IN'],
  ['LENDING_BORROW', 'ASSET_OUT'],
  ['LENDING_REPAY', 'DEBT_REPAID'],
  ['LENDING_WITHDRAW_COLLATERAL', 'ASSET_OUT'],
  // 提取出借资金时，实际代币从资金池转回出借人钱包。 The payout moves from the pool back to the supplier's wallet.
  ['LENDING_WITHDRAW_SUPPLY', 'ASSET_OUT'],
]);

/**
 * 显示较长公钥或签名的首尾六位。
 * Show the first and last six characters of a longer public key or signature.
 *
 * @param address 完整的链上公钥或主签名。 Complete on-chain public key or primary signature.
 */
export function shortenActivityAddress(address: string): string {
  return address.length > 12 ? address.slice(0, 6) + '…' + address.slice(-6) : address;
}

/**
 * 优先显示后端匹配的代币简称，缺失时按网络和精确 Mint 查找已知简称或缩略地址。
 * Prefer the ticker matched by the backend, falling back to a known ticker or abbreviated address.
 *
 * @param asset 活动中的代币 Mint 与可选的目录简称。 Token mint and optional registry ticker from the activity.
 * @param network 活动所属网络。 Network containing the activity.
 */
export function getActivityAssetLabel({ mint, symbol }: Pick<ActivityAsset, 'mint' | 'symbol'>, network: Network): string {
  return symbol?.trim() || (network === 'devnet' ? knownDevnetMints.get(mint) : undefined) || shortenActivityAddress(mint);
}

/**
 * 取得资产变动的文案键。事件与变动匹配时说明借贷资金流向，其他事件使用通用标签。
 * Get a movement label key. Describe the lending direction for a matching event and movement, otherwise use the general label.
 *
 * @param eventType 后端活动类型代码。 Event type code from the backend.
 * @param legType 后端资产变动代码。 Asset movement code from the backend.
 */
export function getActivityLegTranslationKey(eventType: string, legType: string): string {
  return lendingLegTypes.get(eventType) === legType ? 'activity.lendingLegs.' + eventType : 'activity.legs.' + legType;
}

/**
 * 以 UTC 显示已索引的区块时间，未知时间交给页面处理。
 * Display the indexed block time in UTC, leaving missing times to the page.
 *
 * @param blockTime API 返回的区块时间或 null。 Block timestamp from the API, or null.
 * @param locale 当前界面语言。 Current UI locale.
 */
export function formatActivityTime(blockTime: string | null, locale: string): string | null {
  if (blockTime === null) return null;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short',
  }).format(new Date(blockTime));
}

/**
 * 按交易时记录的 Mint 精度格式化该笔实际数量，保留整数精度。
 * Format the exact moved quantity at the mint precision recorded for the transaction.
 *
 * @param asset 含最小单位数量和精度的资产变动。 Asset movement with a base-unit amount and mint precision.
 * @param locale 当前界面语言。 Current UI locale.
 */
export function formatActivityAmount(asset: ActivityAsset, locale: string): string {
  return formatTokenAmount(asset.amountRaw, asset.decimals, locale);
}

/**
 * 取得活动类型的文案键，未知代码由调用方用代码本身回退。
 * Get a translation key for an event type. The caller can fall back to the code for unknown events.
 *
 * @param type 来自索引接口的业务事件类型。 Business event type returned by the index API.
 */
export function getActivityTypeTranslationKey(type: string): string {
  return 'activity.events.' + type;
}

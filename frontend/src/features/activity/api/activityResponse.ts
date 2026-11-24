import { isActivityEventIndex, isActivityPublicKey, isActivitySignature } from '../activityIdentifiers';
import type { ActivityAsset, ActivityItem, ActivityParticipant } from './listActivities';

/** u64 可以保存的最大 slot 或 SPL Token 最小单位数量。 Maximum u64 slot or SPL Token amount in base units. */
const maxUnsignedLong = 18_446_744_073_709_551_615n;

/**
 * 检查 JSON 中代表 slot 或数量的 u64 十进制字符串。
 * Check a decimal u64 JSON string for a slot or amount.
 *
 * @param value 待校验的 JSON 字段。 JSON field to validate.
 */
function isRawUnsignedLong(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value) && BigInt(value) <= maxUnsignedLong;
}

/**
 * 检查后端传来的稳定代码格式，允许后续合法新代码。
 * Validate the format of a stable backend code while allowing new valid values.
 *
 * @param value 业务模块、事件、参与角色或资产流向代码。 Code for a module, event, participant role, or asset movement.
 */
function isActivityCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(value);
}

/**
 * 检查可用于列表和回执的参与钱包及身份。
 * Validate a participant's wallet and role for the list and receipt.
 *
 * @param value 后端返回的一项参与记录。 One participant from the backend payload.
 */
function isActivityParticipant(value: unknown): value is ActivityParticipant {
  return typeof value === 'object' && value !== null &&
    'walletAddress' in value && typeof value.walletAddress === 'string' && isActivityPublicKey(value.walletAddress) &&
    'role' in value && isActivityCode(value.role);
}

/**
 * 检查一项资产变动的字段，避免显示无效金额或精度。
 * Validate an asset movement so malformed amounts or decimals cannot reach display.
 *
 * @param value 后端返回的一项代币变动。 One token movement from the backend payload.
 */
function isActivityAsset(value: unknown): value is ActivityAsset {
  return typeof value === 'object' && value !== null &&
    'legIndex' in value && isActivityEventIndex(value.legIndex) &&
    'mint' in value && typeof value.mint === 'string' && isActivityPublicKey(value.mint) &&
    // 目录未提供简称或旧版接口未返回该字段时，详情仍可使用 Mint 显示。
    // The mint remains available for display when the directory lacks a ticker or an older API omits it.
    (!('symbol' in value) || value.symbol === null || typeof value.symbol === 'string') &&
    'decimals' in value && typeof value.decimals === 'number' &&
    Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 255 &&
    'amountRaw' in value && isRawUnsignedLong(value.amountRaw) &&
    'legType' in value && isActivityCode(value.legType);
}

/**
 * 根据真实 JSON 契约校验列表或回执的事件，保留可空区块时间。
 * Validate an activity event against the JSON contract and keep nullable block time.
 *
 * @param value 取自活动列表或单笔回执的事件。 Event from the list or receipt endpoint.
 */
export function isActivityItem(value: unknown): value is ActivityItem {
  return typeof value === 'object' && value !== null &&
    'network' in value && (value.network === 'localnet' || value.network === 'devnet') &&
    'signature' in value && typeof value.signature === 'string' && isActivitySignature(value.signature) &&
    'eventIndex' in value && isActivityEventIndex(value.eventIndex) &&
    'slot' in value && isRawUnsignedLong(value.slot) &&
    'blockTime' in value && (value.blockTime === null ||
      (typeof value.blockTime === 'string' && Number.isFinite(Date.parse(value.blockTime)))) &&
    'programId' in value && typeof value.programId === 'string' && isActivityPublicKey(value.programId) &&
    'module' in value && isActivityCode(value.module) &&
    'type' in value && isActivityCode(value.type) &&
    'subjectAddress' in value && typeof value.subjectAddress === 'string' && isActivityPublicKey(value.subjectAddress) &&
    'participants' in value && Array.isArray(value.participants) && value.participants.every(isActivityParticipant) &&
    'assets' in value && Array.isArray(value.assets) && value.assets.every(isActivityAsset);
}

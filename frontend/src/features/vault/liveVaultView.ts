import type { VaultPositionSnapshot } from './api/getVaultPosition';
import type { VaultLatestSnapshot } from './api/listVaults';
import type { DevnetVaultState } from '../../solana/vault/devnetVault';
import { getVaultRedemptionLimit, type RedeemQuoteInputs } from './redeemQuote';

/**
 * 把同一 slot 的现金、持仓估值与份额映射为金库概况使用的字段。
 * Map custody cash, position values and share supply from one slot to the overview fields.
 *
 * @param state 已验证的 Devnet 金库状态。 Verified Devnet vault state.
 * @param readFailed 最新读链失败时标记上次成功观测。 Mark a prior successful observation when the latest read failed.
 * @returns 金额和份额使用代币最小单位。 Amounts and shares use token base units.
 */
export function toLiveVaultOverview(state: DevnetVaultState, readFailed: boolean): VaultLatestSnapshot {
  return {
    slot: state.slot.toString(),
    observedAt: state.observedAt,
    oracleSlot: null,
    cashRaw: state.cashRaw.toString(),
    strategyAmountRaw: state.spotRaw.toString(),
    strategyValueRaw: state.strategyValueRaw?.toString() ?? null,
    lendValueRaw: state.lendingValueRaw.toString(),
    lendingWithdrawableRaw: state.maxRecallRaw.toString(),
    autoRecallEnabled: state.autoRecallEnabled,
    navRaw: state.navRaw?.toString() ?? null,
    totalSharesRaw: state.totalSharesRaw.toString(),
    freshness: readFailed ? 'STALE' : 'FRESH',
  };
}

/**
 * 将同一 slot 的钱包与金库状态统一转换为赎回报价和限额所需的输入。
 * Convert wallet and vault state from one slot into the inputs for quotes and redemption limits.
 *
 * @param state 已验证的链上余额和估值。 Verified on-chain balances and valuation.
 * @returns 赎回报价输入，未连接钱包时为空。 Redemption inputs, or null without a connected wallet.
 */
export function toVaultRedemptionInputs(state: DevnetVaultState): RedeemQuoteInputs | null {
  if (!state.wallet) return null;

  return {
    cashRaw: state.cashRaw + (state.autoRecallEnabled ? state.maxRecallRaw : 0n),
    navRaw: state.navRaw,
    hasNonCashPosition: state.spotRaw > 0n || (state.lendingSharesRaw > 0n &&
      (!state.autoRecallEnabled || (state.lendingValueRaw > 0n && state.maxRecallSharesRaw < state.lendingSharesRaw))),
    totalSharesRaw: state.totalSharesRaw,
    shareBalanceRaw: state.wallet.redeemableSharesRaw,
    assetBalanceRaw: state.wallet.receivableAssetBalanceRaw,
  };
}

/**
 * 用相同 slot 的 GG-V 余额、发行量和金库净值估算钱包份额价值。
 * Estimate wallet position value with its GG-V balance, supply, and NAV from the same slot.
 *
 * @param state 用于当前公钥的已验证状态。 Verified state for the current wallet.
 * @param readFailed 最新读链是否失败。 Whether the latest chain read failed.
 * @returns 仓位金额使用代币最小单位，未连接钱包时为空。 Position fields in base units, or undefined when disconnected.
 */
export function toLiveVaultPosition(state: DevnetVaultState, readFailed: boolean): VaultPositionSnapshot | undefined {
  if (!state.wallet) return undefined;

  /** 钱包份额使用 GG-V 最小单位。 Wallet shares in GG-V base units. */
  const shares = state.wallet.sharesRaw;
  /** 份额供给使用 GG-V 最小单位，净值使用 mockUSDC 最小单位。 Supply uses GG-V base units and NAV uses mockUSDC base units. */
  const { totalSharesRaw, navRaw } = state;

  // 无净值时无法定价。零供给且净值为零是正常的空金库。
  // No pricing is possible without NAV. Zero NAV and zero supply represent an empty vault.
  const value = navRaw === null ? null
    : totalSharesRaw > 0n ? navRaw * shares / totalSharesRaw : navRaw === 0n ? 0n : null;
  /** 赎回报价输入和由当前现金决定的可支付上限。 Redemption inputs and payout limits from current custody cash. */
  const redemptionInputs = toVaultRedemptionInputs(state);
  const redeemable = redemptionInputs ? getVaultRedemptionLimit(redemptionInputs) : null;

  return {
    slot: state.slot.toString(),
    observedAt: state.observedAt,
    freshness: readFailed ? 'STALE' : 'FRESH',
    sharesRaw: shares.toString(),
    positionValueRaw: value?.toString() ?? null,
    redeemableRaw: redeemable?.assetsRaw.toString() ?? null,
    maxRedeemSharesRaw: redeemable?.sharesRaw.toString() ?? null,
  };
}

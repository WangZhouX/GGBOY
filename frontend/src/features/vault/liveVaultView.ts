import type { VaultPositionSnapshot } from './api/getVaultPosition';
import type { VaultLatestSnapshot } from './api/listVaults';
import type { DevnetVaultState } from '../../solana/vault/devnetVault';

/**
 * 把同一 slot 的纯现金净值与份额映射为金库概况使用的字段。
 * Map cash-only NAV and share supply from one slot to the overview fields.
 *
 * @param state 已验证的 Devnet 金库状态。 Verified Devnet vault state.
 * @param readFailed 最新读链失败时标记上次成功观测。 Mark a prior successful observation when the latest read failed.
 * @returns 金额和份额使用代币最小单位。 Amounts and shares use token base units.
 */
export function toLiveVaultOverview(state: DevnetVaultState, readFailed: boolean): VaultLatestSnapshot {
  /** 纯现金金库的净值等于托管账户余额，使用 mockUSDC 最小单位。 Cash-only NAV equals the custody balance in mockUSDC base units. */
  const cash = state.cashRaw.toString();
  return {
    slot: state.slot.toString(),
    observedAt: state.observedAt,
    oracleSlot: null,
    cashRaw: cash,
    strategyAmountRaw: '0',
    strategyValueRaw: '0',
    lendValueRaw: '0',
    lendingWithdrawableRaw: '0',
    navRaw: cash,
    totalSharesRaw: state.totalSharesRaw.toString(),
    freshness: readFailed ? 'STALE' : 'FRESH',
  };
}

/**
 * 用相同 slot 的 GG-V 余额、发行量和托管现金估算钱包份额价值。
 * Estimate wallet position value with its GG-V balance, supply, and custody from the same slot.
 *
 * @param state 用于当前公钥的已验证状态。 Verified state for the current wallet.
 * @param readFailed 最新读链是否失败。 Whether the latest chain read failed.
 * @returns 仓位金额使用代币最小单位，未连接钱包时为空。 Position fields in base units, or undefined when disconnected.
 */
export function toLiveVaultPosition(state: DevnetVaultState, readFailed: boolean): VaultPositionSnapshot | undefined {
  if (!state.wallet) return undefined;

  /** 钱包份额使用 GG-V 最小单位。 Wallet shares in GG-V base units. */
  const shares = state.wallet.sharesRaw;
  /** 可以作为赎回来源的 GG-V 最小单位。 GG-V base units available as redemption sources. */
  const redeemableShares = state.wallet.redeemableSharesRaw;
  /** 份额供给使用 GG-V 最小单位，余额使用 mockUSDC 最小单位。 Supply uses GG-V base units; custody uses mockUSDC base units. */
  const { totalSharesRaw, cashRaw } = state;

  // 零供给且有现金时没有有效的份额价格。其余可估值路径遵守整数向下取整。
  // Nonzero cash with no supply has no valid share price. Floor the integer result where valuation is possible.
  const value = totalSharesRaw > 0n
    ? cashRaw * shares / totalSharesRaw
    : cashRaw === 0n ? 0n : null;

  /** 赎回估值只计可花费的份额，收款账户冻结时无法收款。 Estimate payout from spendable shares only when the destination can receive it. */
  const redeemable = value === null ? null
    : totalSharesRaw > 0n && state.wallet.receivableAssetBalanceRaw !== null ? cashRaw * redeemableShares / totalSharesRaw : 0n;

  return {
    slot: state.slot.toString(),
    observedAt: state.observedAt,
    freshness: readFailed ? 'STALE' : 'FRESH',
    sharesRaw: shares.toString(),
    positionValueRaw: value?.toString() ?? null,
    redeemableRaw: redeemable?.toString() ?? null,
    maxRedeemSharesRaw: redeemable === null ? null : redeemable > 0n ? redeemableShares.toString() : '0',
  };
}

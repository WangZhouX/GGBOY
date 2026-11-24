import type { DevnetLendingSupply } from './devnetLendingPool';

/** 计算出借份额和可用流动性所需的同一 slot 账户数据。 Same-slot account data needed to price supply shares and available liquidity. */
type SupplyAccounting = Pick<DevnetLendingSupply,
  'accountedAssetsRaw' | 'totalSharesRaw' | 'totalDebtRaw' | 'cashRaw' | 'sharesRaw' | 'walletAssetFrozen'>;

/**
 * 按操作前的池账本把出借份额换算为借款 Mint 最小单位，向下取整。
 * Convert supply shares to debt mint base units using the pool ledger before withdrawal, rounded down.
 *
 * @param pool 同槽的出借记账和总份额。 Same-slot recorded assets and total shares.
 * @param sharesRaw 待折算的出借份额最小单位数。 Supply share base units to convert.
 * @returns 可支付数量，空池为零。 Payout, or zero for an empty pool.
 */
export function valueSupplyShares(pool: SupplyAccounting, sharesRaw: bigint): bigint {
  return pool.totalSharesRaw === 0n ? 0n : sharesRaw * pool.accountedAssetsRaw / pool.totalSharesRaw;
}

/**
 * 确定钱包当前可以提取的最大份额和实际整数代币金额。
 * Determine the maximum currently withdrawable shares and exact integer token payout for this wallet.
 *
 * @param pool 同槽验证的池托管、出借账本、未偿本金和钱包份额。 Validated custody, supply ledger, outstanding principal, and wallet shares from the same slot.
 * @returns 冻结、空仓或最小到账为零时均为零，否则返回份额和借款 Mint 最小单位数。 Zero when frozen, empty, or payout rounds to zero; otherwise share and debt mint base units.
 */
export function getSupplyWithdrawalLimit(pool: SupplyAccounting) {
  /** 账外现金不增加份额持有人的权益，未偿本金仍然计在池资产中。 Unrecorded custody cash adds no entitlement, while unpaid principal remains recorded as a pool asset. */
  const { cashRaw, totalDebtRaw, accountedAssetsRaw, totalSharesRaw, sharesRaw } = pool;
  const recordedCashRaw = accountedAssetsRaw - totalDebtRaw;
  const availableCashRaw = cashRaw < recordedCashRaw ? cashRaw : recordedCashRaw;
  if (pool.walletAssetFrozen || availableCashRaw <= 0n || sharesRaw === 0n || totalSharesRaw === 0n) {
    return { sharesRaw: 0n, assetsRaw: 0n };
  }

  // floor(shares × assets ÷ totalShares) ≤ cash 等价于 shares × assets < (cash + 1) × totalShares。
  // floor(shares × assets ÷ totalShares) ≤ cash is equivalent to shares × assets < (cash + 1) × totalShares.
  const poolLimit = ((availableCashRaw + 1n) * totalSharesRaw - 1n) / accountedAssetsRaw;
  const walletLimit = sharesRaw < poolLimit ? sharesRaw : poolLimit;
  /** 现金受限的份额可能仍然小到付不出一个代币最小单位。 A cash-limited share amount can still round down to less than one token base unit. */
  const assetsRaw = valueSupplyShares(pool, walletLimit);
  return { sharesRaw: assetsRaw > 0n ? walletLimit : 0n, assetsRaw };
}

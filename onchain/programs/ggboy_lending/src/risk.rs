//! 借款与抵押提取共用的固定点风险计算。
//! Fixed-point risk arithmetic shared by borrowing and collateral withdrawal.

use anchor_lang::prelude::*;

use crate::LendingError;

/// 按 70% 借款 LTV 上限计算整数最小单位的最大债务。
/// Compute maximum debt in base units at the 70% borrowing LTV limit.
///
/// `collateral_raw` 是抵押最小单位数量，`collateral_decimals` 来自市场绑定的抵押 Mint，
/// `price_raw` 是一整单位抵押品对应的六位精度借款资产最小单位数。
/// `collateral_raw` is in collateral base units, `collateral_decimals` comes from the bound collateral mint,
/// and `price_raw` is the number of six-decimal debt base units per whole collateral token.
/// 金额向下取整，零报价拒绝。返回 u128 以容纳大于单笔 u64 数量的理论额度。
/// Rounds down, rejects a zero quote, and returns u128 to preserve theoretical capacities above a single u64 amount.
pub(crate) fn collateral_borrow_capacity(
    collateral_raw: u64,
    collateral_decimals: u8,
    price_raw: u64,
) -> Result<u128> {
    require!(price_raw > 0, LendingError::InvalidMockPrice);

    // 双 u64 的乘积能精确存入 u128，后续先除以 10 再计算 70%，避免乘 7 溢出。
    // The two u64 factors fit exactly in u128. Split by 10 before applying 70% to avoid overflow when multiplying by 7.
    let weighted_collateral = u128::from(collateral_raw) * u128::from(price_raw);
    let weighted_limit = weighted_collateral / 10 * 7 + (weighted_collateral % 10) * 7 / 10;

    // 分两次向下取整与在分母相乘后统一向下取整等价。若 10 的幂溢出，则分母大于 u128 范围内的分子，额度为零。
    // Flooring in two stages equals one division by both denominators. If the power of ten overflows, the denominator exceeds the u128 numerator and the limit is zero.
    let collateral_scale = 10u128.checked_pow(u32::from(collateral_decimals));
    Ok(collateral_scale.map_or(0, |scale| weighted_limit / scale))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 借款和取回抵押的共享计算应在抵押最小单位边界上向下取整。
    /// The shared borrow and withdrawal arithmetic must floor at a collateral base-unit boundary.
    #[test]
    fn floors_at_collateral_boundary() {
        // 价格为 100 mockUSDC/tSOL，借款上限为抵押价值的 70%。
        // The price is 100 mockUSDC per tSOL, with borrowing capped at 70% of collateral value.
        let price = 100_000_000;
        assert_eq!(
            collateral_borrow_capacity(10_000_000, 6, price).unwrap(),
            700_000_000
        );
        assert!(collateral_borrow_capacity(5_714_285, 6, price).unwrap() < 400_000_000);
        assert!(collateral_borrow_capacity(5_714_286, 6, price).unwrap() >= 400_000_000);
        assert_eq!(collateral_borrow_capacity(19, 1, 1).unwrap(), 1);
        assert_eq!(collateral_borrow_capacity(0, 6, price).unwrap(), 0);
        assert!(collateral_borrow_capacity(1, 6, 0).is_err());
    }

    /// 确认两个最大 u64 输入仍可精确计算，超大抵押精度则向下取整为零。
    /// Verify exact maximum-u64 inputs and floor to zero at very large collateral scales.
    #[test]
    fn handles_wide_inputs_without_overflow() {
        assert_eq!(
            collateral_borrow_capacity(u64::MAX, 0, u64::MAX).unwrap(),
            238_197_656_844_656_924_398_536_783_499_044_375_757,
        );
        assert_eq!(
            collateral_borrow_capacity(u64::MAX, u8::MAX, u64::MAX).unwrap(),
            0
        );
    }
}

//! 保存测试抵押品报价，并校验风险操作使用的价格时效。
//! Store the mock collateral quote and check its freshness for risk-increasing actions.

use anchor_lang::prelude::*;

use crate::{
    state::{MARKET_SEED, MOCK_COLLATERAL_PRICE_SEED},
    LendingError, LendingMarket, MockCollateralPrice,
};

/// 测试价格从链上发布时间起可使用的最大秒数，含最后一秒。
/// Maximum usable age of the mock price in seconds, inclusive.
const MAX_PRICE_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;

/// 只允许登记在市场中的管理员创建或更新对应报价。
/// Only the registered market administrator can create or update its price.
#[derive(Accounts)]
pub struct SetMockCollateralPrice<'info> {
    /// 市场登记的管理员，首次发布时支付价格 PDA 的免租金余额。
    /// Market administrator, who funds the rent-exempt price PDA at first publication.
    #[account(mut)]
    pub administrator: Signer<'info>,

    /// 通过规范 PDA 和管理员签名将测试价格限定在当前市场。
    /// Bind the mock price to this market through its canonical PDA and administrator signature.
    #[account(
        seeds = [MARKET_SEED],
        bump = market.bump,
        has_one = administrator @ LendingError::UnauthorizedAdministrator,
    )]
    pub market: Account<'info, LendingMarket>,

    /// 当前市场唯一的报价 PDA，初次发布时创建。
    /// Canonical quote PDA for this market, created upon first publication.
    #[account(
        init_if_needed,
        payer = administrator,
        space = MockCollateralPrice::DISCRIMINATOR.len() + MockCollateralPrice::INIT_SPACE,
        seeds = [MOCK_COLLATERAL_PRICE_SEED, market.key().as_ref()],
        bump,
    )]
    pub mock_collateral_price: Account<'info, MockCollateralPrice>,

    /// 创建价格账户时调用的系统程序。
    /// System Program used to allocate the quote account.
    pub system_program: Program<'info, System>,
}

/// 记录管理员设置的测试价格，发布时间取自当前链上时钟。
/// Publish the administrator's mock price with the current on-chain timestamp.
///
/// `context` 绑定管理员、市场和规范报价 PDA。 `price_raw` 表示一整单位抵押品对应的六位精度借款资产最小单位数。
/// `context` binds the administrator, market, and canonical quote PDA. `price_raw` gives six-decimal debt base units for one whole collateral token.
pub(super) fn handle(context: Context<SetMockCollateralPrice>, price_raw: u64) -> Result<()> {
    require!(price_raw > 0, LendingError::InvalidMockPrice);

    // 链上 Unix 秒由网络时钟提供，交易调用方不能延长报价的有效期。
    // Take Unix seconds from the network clock so the caller cannot extend the quote's lifetime.
    let published_at = Clock::get()?.unix_timestamp;
    require!(published_at > 0, LendingError::InvalidMockPrice);

    context
        .accounts
        .mock_collateral_price
        .set_inner(MockCollateralPrice {
            market: context.accounts.market.key(),
            price_raw,
            published_at,
        });
    Ok(())
}

/// 校验报价市场、数值和有效期。借款和有未偿债务的抵押提取都使用此校验。
/// Verify market binding, value, and freshness for borrowing and collateral withdrawal with outstanding debt.
///
/// `price` 为已加载的市场报价，`market` 为当前市场 PDA，`now` 是链上时钟的 Unix 秒。
/// `price` is the loaded quote, `market` the current market PDA, and `now` the chain clock in Unix seconds.
/// 返回每一整单位抵押资产的借款资产最小单位报价。零、错误市场、未来或过期报价会失败。
/// Returns debt base units per whole collateral token. Zero, mismatched, future, and expired quotes fail.
pub(crate) fn require_fresh_price(
    price: &MockCollateralPrice,
    market: Pubkey,
    now: i64,
) -> Result<u64> {
    require_keys_eq!(price.market, market, LendingError::InvalidMockPrice);
    require!(
        price.price_raw > 0 && price.published_at > 0,
        LendingError::InvalidMockPrice
    );

    // 使用有符号秒数检查未来报价，减法越界时也拒绝报价。
    // Check for future publications with signed seconds and reject subtraction overflow.
    let age = now.checked_sub(price.published_at);
    require!(
        age.is_some_and(|seconds| (0..=MAX_PRICE_AGE_SECONDS).contains(&seconds)),
        LendingError::StaleMockPrice,
    );
    Ok(price.price_raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 检查市场绑定、未来发布时间及有效期闭区间边界。
    /// Verify market binding, a future publication, and the inclusive freshness boundary.
    #[test]
    fn accepts_exact_price_age_boundary_and_rejects_invalid_quotes() {
        // 为价格选择非零 Unix 秒作为起点，兼容链上拒绝未初始化时间的约束。
        // Set a nonzero Unix publication time to match the chain's initialization constraint.
        let market = Pubkey::new_unique();
        let now = 1_700_000_000;
        let mut quote = MockCollateralPrice {
            market,
            price_raw: 100_000_000,
            published_at: now - MAX_PRICE_AGE_SECONDS,
        };

        assert_eq!(
            require_fresh_price(&quote, market, now).unwrap(),
            quote.price_raw
        );
        assert!(require_fresh_price(&quote, market, now + 1).is_err());
        assert!(require_fresh_price(&quote, Pubkey::new_unique(), now).is_err());
        quote.published_at = now + 1;
        assert!(require_fresh_price(&quote, market, now).is_err());
        quote.published_at = now;
        quote.price_raw = 0;
        assert!(require_fresh_price(&quote, market, now).is_err());
    }
}

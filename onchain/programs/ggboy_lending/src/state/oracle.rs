//! 测试预言机价格、发布时间及其 PDA 种子。
//! Test oracle price, publish time, and its PDA seed.

use anchor_lang::prelude::*;

/// 市场测试预言机 PDA 种子，后接市场地址。
/// Market test oracle PDA seed, followed by the market address.
pub(crate) const MOCK_COLLATERAL_PRICE_SEED: &[u8] = b"mock_collateral_price";

/// 由市场管理员写入的测试价格，价格比较在链上执行。
/// Test price written by the market administrator and checked on-chain.
#[account]
#[derive(InitSpace)]
pub struct MockCollateralPrice {
    /// 此预言机所属的市场公钥。
    /// Public key of the market that owns this oracle.
    pub market: Pubkey,

    /// 1 整单位抵押品对应的六位小数借款 Mint 最小单位数。
    /// Debt mint base units per whole unit of collateral, using the six-decimal debt mint.
    pub price_raw: u64,

    /// 链上 Clock 给出的价格发布时间，以 Unix 秒记录。
    /// Publication time in Unix seconds from the on-chain Clock.
    pub published_at: i64,
}

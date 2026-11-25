//! 借款总账、钱包仓位、PDA 种子及借款操作事件。
//! Borrowing ledger, wallet positions, PDA seeds, and borrowing action event.

use anchor_lang::prelude::*;

/// 借款总账 PDA 种子，后接市场地址。
/// Borrowing ledger PDA seed, followed by the market address.
pub(crate) const BORROW_MARKET_SEED: &[u8] = b"borrow_market";

/// 个人抵押和债务 PDA 种子，后接市场地址与借款人公钥。
/// Collateral and debt position PDA seed, followed by the market and borrower public keys.
pub(crate) const BORROW_POSITION_SEED: &[u8] = b"borrow_position";

/// 独立的市场借款总账，首次借款创建，沿用原市场和出借池的账户布局。
/// Separate market debt ledger created by the first borrow, preserving existing market and supply layouts.
#[account]
#[derive(InitSpace)]
pub struct BorrowMarket {
    /// 此借款总账所属的市场公钥。
    /// Public key of the market that owns this borrowing ledger.
    pub market: Pubkey,

    /// 全市场仍欠的本金，以六位小数借款 Mint 最小单位记录。
    /// Outstanding principal across the market, in base units of the six-decimal debt mint.
    pub total_debt_raw: u64,
}

/// 一个钱包在此借贷市场的抵押品余额和未偿本金。
/// Locked collateral and outstanding principal for one wallet in this market.
#[account]
#[derive(InitSpace)]
pub struct BorrowPosition {
    /// 此仓位所属的市场公钥。
    /// Public key of the market that owns this position.
    pub market: Pubkey,

    /// 可以操作仓位的签名钱包。
    /// Wallet authorized to sign operations against this position.
    pub borrower: Pubkey,

    /// 已锁定的抵押品，按抵押 Mint 最小单位记录。
    /// Locked collateral in collateral mint base units.
    pub collateral_raw: u64,

    /// 当前未偿还的本金，按六位小数借款 Mint 最小单位记录。
    /// Outstanding principal in base units of the six-decimal debt mint.
    pub debt_raw: u64,
}

/// 已生效的借款仓位操作与操作后的余额，供回执及历史读取。
/// Executed borrowing action and resulting balances for receipts and history.
#[event]
pub struct LendingBorrowAction {
    /// 本次操作的市场状态公钥。
    /// Market state public key for this action.
    pub market: Pubkey,
    /// 签名借款人公钥。
    /// Public key of the signing borrower.
    pub borrower: Pubkey,
    /// 0 追加抵押品，1 借款，2 还款，3 取回抵押品。
    /// 0 deposits collateral, 1 borrows, 2 repays, and 3 withdraws collateral.
    pub kind: u8,
    /// 实际转移的抵押或借款资产最小单位数，由 kind 决定使用的 Mint。
    /// Base units of assets actually transferred, with the mint determined by kind.
    pub amount_raw: u64,
    /// 操作后已锁定的抵押 Mint 最小单位数。
    /// Collateral mint base units locked after this action.
    pub collateral_raw: u64,
    /// 操作后剩余的借款 Mint 本金最小单位数。
    /// Outstanding principal in debt mint base units after this action.
    pub debt_raw: u64,
}

//! 按账户职责组织借贷市场状态和 PDA 种子。
//! Organizes lending market state and PDA seeds by account responsibility.

mod borrow;
mod market;
mod oracle;
mod supply;

pub use borrow::{BorrowMarket, BorrowPosition, LendingBorrowAction};
pub(crate) use borrow::{BORROW_MARKET_SEED, BORROW_POSITION_SEED};
pub use market::LendingMarket;
pub(crate) use market::{CASH_VAULT_SEED, COLLATERAL_VAULT_SEED, MARKET_SEED};
pub use oracle::MockCollateralPrice;
pub(crate) use oracle::MOCK_COLLATERAL_PRICE_SEED;
pub use supply::{SupplyPool, SupplyPosition};
pub(crate) use supply::{SUPPLY_POOL_SEED, SUPPLY_POSITION_SEED};

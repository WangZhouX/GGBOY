//! 账户约束、业务指令处理和 Anchor 生成的客户端账户类型。
//! Account constraints, instruction handlers, and Anchor-generated client account types.

pub(super) mod collateral;
pub(super) mod debt;
pub(super) mod initialize;
pub(super) mod interest;
pub(super) mod liquidation;
pub(super) mod oracle;
pub(super) mod ping;
pub(super) mod prepare_supply;
pub(super) mod supply;
pub(super) mod withdraw_supply;

// Anchor 在程序根模块解析生成的客户端和 CPI 账户模块。
// Anchor resolves generated client and CPI account modules at the crate root.
pub use collateral::*;
pub use debt::*;
pub use initialize::*;
pub(crate) use interest::__client_accounts_enable_interest;
#[cfg(feature = "cpi")]
pub(crate) use interest::__cpi_client_accounts_enable_interest;
pub use interest::{project_pool_assets, project_pool_cash, project_position_debt, EnableInterest};
pub use liquidation::*;
pub use oracle::*;
pub use ping::*;
pub use prepare_supply::*;
pub use supply::*;
pub use withdraw_supply::*;

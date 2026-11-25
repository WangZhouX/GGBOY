//! 金库及策略的链上持久化账户。
//! Persistent account layouts for the vault and its strategy.

mod vault;
mod vault_strategy;

pub use vault::Vault;
pub use vault_strategy::VaultStrategy;

// 程序内部用相同的种子和长度校验状态账户。
// Program modules share seeds and layout length for state account validation.
pub(crate) use vault::{STRATEGY_VAULT_LEN, VAULT_SEED};
pub(crate) use vault_strategy::{STRATEGY_CUSTODY_SEED, STRATEGY_SEED};

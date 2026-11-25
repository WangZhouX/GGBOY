//! 检查策略金库的 Anchor 指令入口。
//! Check the Anchor instruction entry point of the strategy vault.

use anchor_lang::prelude::*;

/// `ping` 指令不需要传入账户。
/// The `ping` instruction accepts no accounts.
#[derive(Accounts)]
pub struct Ping {}

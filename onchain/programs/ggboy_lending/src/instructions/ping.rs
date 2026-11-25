//! 不读写链上账户的程序连通性检查。
//! Program connectivity check with no on-chain account access.

use anchor_lang::prelude::*;

/// `ping` 指令不需要传入账户。
/// The `ping` instruction accepts no accounts.
#[derive(Accounts)]
pub struct Ping {}

/// 返回成功，确认程序入口可调用。
/// Return success to confirm the program entry point is callable.
pub(crate) fn handle() -> Result<()> {
    Ok(())
}

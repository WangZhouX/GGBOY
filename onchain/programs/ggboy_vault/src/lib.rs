//! 策略金库程序入口，后续实现资产托管、份额铸销、存入、赎回和策略调用。
//! GGBOY strategy vault entry point for custody, share accounting, deposits, redemptions, and strategy calls.

use anchor_lang::prelude::*;

// 工作区为本程序记录的 Localnet 公钥。
// Localnet public key configured for this program in the workspace.
declare_id!("FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75");

/// 策略金库的 Anchor 指令入口。
/// Anchor instruction entry points for the GGBOY strategy vault.
#[program]
pub mod ggboy_vault {
    use super::*;

    /// 验证脚手架指令可以调用，返回成功且不读写链上账户。
    /// Confirm the scaffold instruction is callable and return success without accessing on-chain accounts.
    ///
    /// `_context` 是 Anchor 传入的指令上下文，本指令无需读取其中的数据。
    /// `_context` is the Anchor instruction context. This instruction does not read it.
    pub fn ping(_context: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

/// `ping` 指令不需要传入账户。
/// The `ping` instruction accepts no accounts.
#[derive(Accounts)]
pub struct Ping {}

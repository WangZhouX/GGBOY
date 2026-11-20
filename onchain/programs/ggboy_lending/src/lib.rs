//! 抵押借贷市场程序入口，后续实现共享资金池、抵押品、未偿债务和清算。
//! GGBOY lending market entry point for the loan pool, collateral, outstanding debt, and liquidations.

use anchor_lang::prelude::*;

// 工作区为本程序记录的 Localnet 公钥。
// Localnet public key configured for this program in the workspace.
declare_id!("8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H");

/// 抵押借贷市场的 Anchor 指令入口。
/// Anchor instruction entry points for the GGBOY collateralized lending market.
#[program]
pub mod ggboy_lending {
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

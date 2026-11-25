//! 策略金库程序入口，负责初始化、存赎、调仓及借贷联动。
//! Strategy vault entry point for initialization, investor flows, exchange, and lending.

use anchor_lang::prelude::*;

mod errors;
mod instructions;
mod state;
mod strategy_valuation;

// 在 crate 根保留公开类型和 Anchor 生成的账户绑定，供客户端和 CPI 使用。
// Keep public types and Anchor-generated account bindings at the crate root for clients and CPI.
pub use errors::VaultError;
pub use instructions::*;
pub use state::{Vault, VaultStrategy};

// 工作区为本程序记录的 Localnet 公钥。
// Localnet public key configured for this program in the workspace.
declare_id!("FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75");

/// 策略金库的 Anchor 指令入口。
/// Anchor instruction entry points for the GGBOY strategy vault.
#[program]
pub mod ggboy_vault {
    use super::*;

    /// 由程序升级权限持有者创建唯一金库，并把托管和份额铸造权授予金库 PDA。
    /// Create the singleton vault as the program upgrade authority and assign custody and minting to its PDA.
    ///
    /// `context` 包含管理员签名、六位小数的结算 Mint 和待创建的账户。
    /// `context` contains the administrator signature, the six-decimal settlement mint, and the new accounts.
    /// 成功时三个账户同时建立。权限、资产或地址校验失败会回滚整个初始化。
    /// All three accounts are created together. Permission, asset, or address validation failures revert initialization.
    pub fn initialize_vault(context: Context<InitializeVault>) -> Result<()> {
        instructions::initialize::handle(context)
    }

    /// 将投资者的结算资产转入金库，按存入前的净值铸造份额。
    /// Transfer the investor's settlement asset into custody and mint shares at the pre-deposit NAV.
    ///
    /// `context` 包含签名的投资者、已配置的金库账户和投资者的代币账户。
    /// `context` contains the signing investor, configured vault accounts, and investor token accounts.
    /// `assets_in` 是 mockUSDC 最小单位数，`min_shares_out` 是 GG-V 最小单位数，两者均须为正。
    /// `assets_in` is in mockUSDC base units and `min_shares_out` is in GG-V base units. Both must be positive.
    /// 成功时转账、铸造并记录成交事件。任何校验或代币操作失败时，整笔存入回滚。
    /// Success transfers funds, mints shares, and emits a receipt event. Failed checks or token operations revert the deposit.
    pub fn deposit(context: Context<Deposit>, assets_in: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handle(context, assets_in, min_shares_out)
    }

    /// 按赎回前的净值销毁投资者份额，现金不足时可先从出借仓位收回并支付。
    /// Burn investor shares at pre-redemption NAV, with optional recall from lending before payment.
    ///
    /// `context` 包含投资者签名、已配置的金库账户和投资者的代币账户。
    /// `context` contains the investor signer, configured vault accounts, and investor token accounts.
    /// `shares_in` 是 GG-V 最小单位数，`min_assets_out` 是 mockUSDC 最小单位数，两者均须为正。
    /// `shares_in` is in GG-V base units and `min_assets_out` is in mockUSDC base units. Both must be positive.
    /// 销毁、支付及成交记录在同一笔交易执行。任一代币操作失败时回滚赎回。
    /// The burn, payment, and receipt occur in one transaction. Either token operation failing reverts the redemption.
    pub fn redeem<'info>(
        context: Context<'info, Redeem<'info>>,
        shares_in: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        instructions::redeem::handle(context, shares_in, min_assets_out)
    }

    /// 管理员为现有金库启用策略，创建规范托管并保存比例参数。
    /// Enable strategy on an existing vault, create canonical custody, and store the ratio limits.
    ///
    /// `manager` 是策略钱包。留存、出借和每笔兑换限制使用基点。
    /// `manager` is the strategy wallet. Reserve, lending, and per-swap limits use basis points.
    pub fn initialize_vault_strategy(
        context: Context<InitializeVaultStrategy>,
        manager: Pubkey,
        reserve_bps: u16,
        lending_cap_bps: u16,
        max_trade_bps: u16,
    ) -> Result<()> {
        instructions::strategy::initialize(
            context,
            manager,
            reserve_bps,
            lending_cap_bps,
            max_trade_bps,
        )
    }

    /// 由现有金库管理员启用投资者自动收回功能。
    /// Enable investor auto recall as the vault's existing administrator.
    ///
    /// `context` 绑定签名管理员与已启用策略的规范金库。迁移只设置功能位。
    /// `context` binds the signing administrator and canonical active strategy vault. Migration only sets the capability bit.
    pub fn enable_auto_recall(context: Context<EnableAutoRecall>) -> Result<()> {
        instructions::strategy::enable_auto_recall(context)
    }

    /// 使用已绑定的测试储备和实时链上价格兑换金库资产。
    /// Exchange vault assets using the bound test reserves and current on-chain price.
    ///
    /// `buy` 为真时用现金买入策略资产。输入和到账下限按各自 Mint 最小单位计。
    /// `buy` uses cash to buy the spot asset when true. Input and minimum output use their respective mint base units.
    pub fn strategy_swap(
        context: Context<StrategySwap>,
        buy: bool,
        amount_in: u64,
        min_out: u64,
    ) -> Result<()> {
        instructions::strategy::swap(context, buy, amount_in, min_out)
    }

    /// 在约束范围内把闲置现金投入绑定的借贷市场。
    /// Supply idle cash to the bound lending market within configured limits.
    ///
    /// `assets_in` 和 `min_shares_out` 分别是现金和池份额最小单位。
    /// `assets_in` and `min_shares_out` are cash and pool share base units.
    pub fn strategy_lend(
        context: Context<StrategyLend>,
        assets_in: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::strategy_lending::lend(context, assets_in, min_shares_out)
    }

    /// 从借贷市场赎回金库持有的出借份额，把实际回款退回现金托管。
    /// Redeem the vault's lending shares and return realized cash to vault custody.
    ///
    /// `shares_in` 是池份额最小单位，`min_assets_out` 是最低到账的现金最小单位。
    /// `shares_in` and `min_assets_out` use pool share and minimum cash base units, respectively.
    pub fn strategy_recall(
        context: Context<StrategyRecall>,
        shares_in: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        instructions::strategy_lending::recall(context, shares_in, min_assets_out)
    }

    /// 清理按有效预言机价无法产生一单位现金到账的完整现货尾仓。
    /// Clear the full spot balance only when its valid oracle quote cannot pay one cash base unit.
    ///
    /// `context` 使用与换币相同的账户约束。指令将尾仓转入测试储备并记录事件。
    /// `context` uses the swap account constraints. The instruction transfers dust to the test reserve and logs it.
    pub fn clear_strategy_dust(context: Context<StrategySwap>) -> Result<()> {
        instructions::strategy::clear_dust(context)
    }

    /// 验证脚手架指令可以调用，返回成功且不读写链上账户。
    /// Confirm the scaffold instruction is callable and return success without accessing on-chain accounts.
    ///
    /// `_context` 是 Anchor 传入的指令上下文，本指令无需读取其中的数据。
    /// `_context` is the Anchor instruction context. This instruction does not read it.
    pub fn ping(_context: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

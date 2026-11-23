//! 策略金库程序入口，负责初始化金库、存入资产和赎回份额。
//! Strategy vault entry point for initialization, deposits, and redemptions.

use anchor_lang::prelude::*;

mod deposit;
mod initialize;
mod redeem;
mod state;

pub use deposit::*;
pub use initialize::*;
pub use redeem::*;
pub use state::Vault;

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
        initialize::handle(context)
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
        deposit::handle(context, assets_in, min_shares_out)
    }

    /// 按赎回前的净值销毁投资者份额，并从纯现金金库支付结算资产。
    /// Burn investor shares at the pre-redemption NAV and pay the settlement asset from cash custody.
    ///
    /// `context` 包含投资者签名、已配置的金库账户和投资者的代币账户。
    /// `context` contains the investor signer, configured vault accounts, and investor token accounts.
    /// `shares_in` 是 GG-V 最小单位数，`min_assets_out` 是 mockUSDC 最小单位数，两者均须为正。
    /// `shares_in` is in GG-V base units and `min_assets_out` is in mockUSDC base units. Both must be positive.
    /// 销毁、支付及成交记录在同一笔交易执行。任一代币操作失败时回滚赎回。
    /// The burn, payment, and receipt occur in one transaction. Either token operation failing reverts the redemption.
    pub fn redeem(context: Context<Redeem>, shares_in: u64, min_assets_out: u64) -> Result<()> {
        redeem::handle(context, shares_in, min_assets_out)
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

/// `ping` 指令不需要传入账户。
/// The `ping` instruction accepts no accounts.
#[derive(Accounts)]
pub struct Ping {}

/// 金库初始化、存入和赎回时的业务校验错误。
/// Validation errors for vault initialization, deposits, and redemptions.
#[error_code]
pub enum VaultError {
    /// 提供的 ProgramData 与当前金库程序不匹配。
    /// The supplied ProgramData does not belong to this vault program.
    #[msg("ProgramData does not match the vault program")]
    InvalidProgramData,
    /// 签名者不持有当前金库程序的升级权限。
    /// The signer is not the current upgrade authority of the vault program.
    #[msg("Only the vault program upgrade authority can initialize the vault")]
    UnauthorizedAdministrator,
    /// 结算资产的 Mint 必须使用六位小数。
    /// The settlement mint must have six decimal places.
    #[msg("The settlement mint must have six decimals")]
    InvalidAssetDecimals,
    /// 存入的结算资产最小单位数必须大于零。
    /// The settlement asset amount must be positive in base units.
    #[msg("Deposit amount must be greater than zero")]
    InvalidDepositAmount,
    /// 最少到账份额的最小单位数必须大于零。
    /// The minimum share output must be positive in base units.
    #[msg("Minimum shares out must be greater than zero")]
    InvalidMinimumSharesOut,
    /// 托管余额与份额供给中只有一项为零，无法计算存入报价。
    /// A deposit cannot be priced when exactly one of custody cash and share supply is zero.
    #[msg("Vault cash and share supply are inconsistent for deposit pricing")]
    InvalidVaultPricingState,
    /// 计算出的份额数量超出 SPL Token 支持的 u64 最小单位范围。
    /// The calculated shares exceed the SPL Token u64 amount range.
    #[msg("Calculated share amount exceeds the token amount range")]
    DepositSharesOverflow,
    /// 按最小单位向下取整后无法铸造正额份额。
    /// Rounding down leaves no whole base unit of shares to mint.
    #[msg("Deposit rounds down to zero shares")]
    ZeroSharesOut,
    /// 链上计算出的份额低于投资者签名时指定的下限。
    /// The calculated shares fall below the investor's signed minimum.
    #[msg("Calculated share output is below the minimum")]
    MinimumSharesOutNotMet,
    /// 投资者指定的扣款账户余额小于存入金额。
    /// The investor's source account balance is below the deposit amount.
    #[msg("Insufficient settlement asset balance for the deposit")]
    InsufficientDepositBalance,
    /// 赎回的 GG-V 最小单位数必须大于零。
    /// The share amount to redeem must be positive in base units.
    #[msg("Redemption shares must be greater than zero")]
    InvalidRedeemAmount,
    /// 最低到账的 mockUSDC 最小单位数必须大于零。
    /// The minimum settlement amount must be positive in base units.
    #[msg("Minimum assets out must be greater than zero")]
    InvalidMinimumAssetsOut,
    /// 投资者选定的来源账户持有份额不足。
    /// The selected investor source account does not have enough shares.
    #[msg("Insufficient shares in the redemption source account")]
    InsufficientRedeemShares,
    /// 总份额为零或小于要销毁的份额，无法按份额占比定价。
    /// Share supply is zero or below the requested burn, so proportional pricing is invalid.
    #[msg("Share supply cannot support redemption pricing")]
    InvalidRedemptionPricingState,
    /// 应付金额向下取整后不足一个 mockUSDC 最小单位。
    /// The payout rounds down to less than one mockUSDC base unit.
    #[msg("Redemption rounds down to zero settlement assets")]
    ZeroAssetsOut,
    /// 现金托管账户余额为零或无法覆盖本笔应付金额。
    /// Cash custody is empty or cannot cover the required payout.
    #[msg("Vault cash is insufficient for redemption")]
    InsufficientVaultCash,
    /// 链上应付金额低于投资者签名时指定的下限。
    /// The calculated payout falls below the investor's signed minimum.
    #[msg("Calculated redemption payout is below the minimum")]
    MinimumAssetsOutNotMet,
}

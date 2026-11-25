//! 策略金库程序入口，负责初始化、存赎、调仓及借贷联动。
//! Strategy vault entry point for initialization, investor flows, exchange, and lending.

use anchor_lang::prelude::*;

mod deposit;
mod initialize;
mod redeem;
mod state;
mod strategy;
mod strategy_lending;
mod strategy_valuation;

pub use deposit::*;
pub use initialize::*;
pub use redeem::*;
pub use state::Vault;
pub use strategy::*;
pub use strategy_lending::*;

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
        redeem::handle(context, shares_in, min_assets_out)
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
        strategy::initialize(
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
        strategy::enable_auto_recall(context)
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
        strategy::swap(context, buy, amount_in, min_out)
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
        strategy_lending::lend(context, assets_in, min_shares_out)
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
        strategy_lending::recall(context, shares_in, min_assets_out)
    }

    /// 清理按有效预言机价无法产生一单位现金到账的完整现货尾仓。
    /// Clear the full spot balance only when its valid oracle quote cannot pay one cash base unit.
    ///
    /// `context` 使用与换币相同的账户约束。指令将尾仓转入测试储备并记录事件。
    /// `context` uses the swap account constraints. The instruction transfers dust to the test reserve and logs it.
    pub fn clear_strategy_dust(context: Context<StrategySwap>) -> Result<()> {
        strategy::clear_dust(context)
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
    /// 策略估值、绑定或者账户布局校验失败。
    /// Strategy valuation account bindings or layouts are invalid.
    #[msg("Required strategy accounts do not match the vault")]
    InvalidStrategyAccounts,
    /// 链上价格为空、无效或超过约定时效。
    /// The on-chain price is missing, invalid, or outside its freshness window.
    #[msg("The market test price is unavailable, invalid or stale")]
    InvalidStrategyPrice,
    /// 策略估值或输出超出支持的代币整数范围。
    /// Strategy valuation or a transfer output exceeds the supported integer range.
    #[msg("Vault strategy value exceeds the supported amount range")]
    StrategyValuationOverflow,
    /// 最后一次赎回前必须将现货与出借份额全部结清。
    /// Spot and lending positions must be cleared before the last redemption.
    #[msg("Sell all spot and recall all lending shares before redeeming the final vault shares")]
    StrategyPositionsRemain,
    /// 策略管理身份或基点参数不在允许范围内。
    /// The strategy manager identity or basis-point parameters are invalid.
    #[msg("Invalid strategy manager or limit parameters")]
    InvalidStrategyParameters,
    /// 策略动作的输入和到账下限必须为正。
    /// Strategy input and minimum output must be positive.
    #[msg("Strategy input and minimum output must be greater than zero")]
    InvalidStrategyAmount,
    /// 已成交输出为零或低于管理者要求的下限。
    /// Output is zero or below the minimum authorized by the manager.
    #[msg("Strategy output is below its minimum")]
    MinimumStrategyOutputNotMet,
    /// 本笔交易超出配置范围，或出借后现金低于要求。
    /// This action exceeds configured limits or would leave insufficient retained cash.
    #[msg("The operation exceeds the strategy limit")]
    StrategyLimitExceeded,
    /// 实际托管或测试储备余额不足。
    /// Actual custody or test reserves have insufficient liquidity.
    #[msg("Vault custody or test swap reserves are insufficient")]
    InsufficientStrategyLiquidity,
    /// 策略尾仓能变现，需用普通卖出换回金库现金。
    /// The spot balance can be sold for cash and cannot be discarded as dust.
    #[msg("The spot balance has value and must be sold for cash")]
    StrategyDustHasValue,
}

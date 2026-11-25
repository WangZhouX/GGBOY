//! 金库存赎和策略操作共用的校验错误。
//! Validation errors shared by investor flows and strategy operations.

use anchor_lang::prelude::*;

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

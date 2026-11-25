//! Anchor 业务错误及其公开编号按声明顺序定义。
//! Defines Anchor business errors in the order used to assign their public codes.

use anchor_lang::prelude::*;

/// 借贷市场初始化、出借及抵押借款的业务校验错误。
/// Validation errors for lending market initialization, supply, and borrowing.
#[error_code]
pub enum LendingError {
    /// 提供的 ProgramData 不属于当前借贷程序。
    /// The supplied ProgramData does not belong to the current lending program.
    #[msg("ProgramData does not match the lending program")]
    InvalidProgramData,
    /// 签名者不持有当前借贷程序的升级权限。
    /// The signer does not hold upgrade authority for the current lending program.
    #[msg("Only the program upgrade authority can initialize the lending market")]
    UnauthorizedAdministrator,
    /// 借款资产必须使用六位小数。
    /// The debt mint must use six decimal places.
    #[msg("The debt mint must have six decimals")]
    InvalidDebtMintDecimals,
    /// 借款资产与抵押资产必须来自不同的 Mint。
    /// Debt and collateral must use different mints.
    #[msg("Debt and collateral mints must differ")]
    IdenticalAssetMints,
    /// 两种托管使用自建测试 Mint，不能使用原生 SOL 的包装 Mint。
    /// Both custody accounts hold test mints and cannot use the wrapped native SOL mint.
    #[msg("The wrapped native SOL mint is unsupported")]
    UnsupportedNativeMint,
    /// 出借金额必须大于零，以借款资产最小单位计。
    /// Supply amount in debt asset base units must be positive.
    #[msg("Supply amount must be greater than zero")]
    InvalidSupplyAmount,
    /// 接受的最低到账份额必须大于零，以份额最小单位计。
    /// Minimum output in share base units must be positive.
    #[msg("Minimum supply shares must be greater than zero")]
    InvalidMinimumSupplyShares,
    /// 资金来源必须独立于资金池，防止转给自己却增加账面份额。
    /// Keep the source distinct from custody so self-transfers cannot create shares.
    #[msg("Supply source account must differ from cash custody")]
    InvalidSupplySource,
    /// 池记账比例、现金覆盖或个人份额与总份额之间不一致。
    /// Pool pricing balances, cash backing, or wallet share totals are inconsistent.
    #[msg("Lending pool supply accounting is inconsistent")]
    InvalidSupplyAccounting,
    /// 资产或份额最小单位数超出 u64 记账范围。
    /// An asset or share amount exceeds the u64 accounting range.
    #[msg("Supply assets or shares exceed the accounting range")]
    SupplyOverflow,
    /// 向下舍入后不足一个可记账的份额最小单位。
    /// The quote rounds down below one share base unit.
    #[msg("Supply rounds down to zero shares")]
    ZeroSupplyShares,
    /// 出借报价小于签名交易中的到账份额下限。
    /// The supply quote is below the signed share floor.
    #[msg("Calculated supply shares are below the minimum")]
    MinimumSupplySharesNotMet,
    /// 出借人指定的来源账户无法支付全部出借金额。
    /// The selected supplier token account cannot fund the full supply.
    #[msg("Insufficient source balance for the supply")]
    InsufficientSupplyBalance,
    /// 抵押或借款操作的最小单位金额必须为正。
    /// Collateral or debt actions require a positive base-unit amount.
    #[msg("Borrowing action amount must be greater than zero")]
    InvalidBorrowAmount,
    /// 仓位的市场或钱包与账户约束不匹配。
    /// The position does not belong to the specified market or wallet.
    #[msg("Borrow position does not belong to this wallet and market")]
    InvalidBorrowPosition,
    /// 代币转账必须发生在独立的钱包代币账户和市场托管账户之间。
    /// Wallet token and market custody accounts must differ.
    #[msg("Borrowing token account must differ from custody")]
    InvalidBorrowTokenAccount,
    /// 来源代币账户余额不足以支付此次转账。
    /// The source token account cannot fund the full transfer.
    #[msg("Insufficient token balance for the borrowing action")]
    InsufficientBorrowTokenBalance,
    /// 申请额超过可用抵押品，或操作后的抵押品无法覆盖新的债务。
    /// The request exceeds locked collateral or the resulting position fails the borrowing LTV limit.
    #[msg("Collateral is insufficient for the requested action")]
    CollateralTooLow,
    /// 借款计算或链上账户余额超出整数范围。
    /// A borrowing calculation or stored balance exceeds its integer range.
    #[msg("Borrowing calculation or balance exceeds its range")]
    BorrowOverflow,
    /// 测试预言机归属、价格或发布时间无效。
    /// The test oracle owner, price, or publication time is invalid.
    #[msg("Market test oracle price is unavailable or invalid")]
    InvalidMockPrice,
    /// 测试价格发布时间超过市场最大允许年龄。
    /// The test price publication time exceeds the market's maximum age.
    #[msg("Market test oracle price is stale")]
    StaleMockPrice,
    /// 尝试借出的金额超过池内已记账的可借流动性。
    /// The requested loan exceeds the pool's available accounted liquidity.
    #[msg("Insufficient accounted cash for the requested loan")]
    InsufficientBorrowLiquidity,
    /// 还款金额超过借款仓位的未偿本金。
    /// The requested repayment exceeds the position's outstanding principal.
    #[msg("Repayment amount exceeds the position's outstanding principal")]
    RepaymentExceedsDebt,
    /// 借款总账、出借池或现金托管之间的记账关系不一致。
    /// Debt ledger, supply pool, or cash custody balances are inconsistent.
    #[msg("Lending market debt accounting is inconsistent")]
    InvalidBorrowAccounting,
    /// 提取的出借份额最小单位数量必须为正。
    /// The withdrawal must redeem a positive quantity of share base units.
    #[msg("Supply withdrawal shares must be greater than zero")]
    InvalidSupplyWithdrawalShares,
    /// 最低到账的借款代币最小单位数量必须为正。
    /// The minimum payout in debt token base units must be positive.
    #[msg("Minimum supply withdrawal output must be greater than zero")]
    InvalidMinimumSupplyWithdrawal,
    /// 出借人的收款地址和托管地址不得相同，避免代币转给自己。
    /// The supplier's destination must differ from custody to avoid self-transfers.
    #[msg("Supply withdrawal destination must differ from cash custody")]
    InvalidSupplyWithdrawalDestination,
    /// 签名钱包没有足够的出借份额完成本次提取。
    /// The signing wallet does not own enough supply shares for this withdrawal.
    #[msg("Insufficient supply shares for the requested withdrawal")]
    InsufficientSupplyShares,
    /// 份额换算后不足一个借款代币最小单位。
    /// The share quote rounds down below one debt token base unit.
    #[msg("Supply withdrawal rounds down to zero assets")]
    ZeroSupplyWithdrawalAssets,
    /// 当前报价低于签名消息所要求的最低到账金额。
    /// The current quote is below the minimum payout authorized by the signed message.
    #[msg("Calculated supply withdrawal output is below the minimum")]
    MinimumSupplyWithdrawalNotMet,
    /// 本次报价超过池内可用现金或未借出的记账资产。
    /// The quote exceeds available custody cash or accounted assets not lent out.
    #[msg("Insufficient accounted cash for the requested supply withdrawal")]
    InsufficientSupplyWithdrawalLiquidity,
    /// 记账尾部未启用或账户数据不符合当前计息状态。
    /// The interest trailer is missing or inconsistent with the current accounting state.
    #[msg("Lending interest accounting is inconsistent")]
    InvalidInterestAccounting,
    /// 计息结算时缺少规范的可写出借池账户。
    /// Indexed settlement requires the canonical writable supply pool account.
    #[msg("Indexed lending requires its writable supply pool")]
    InterestAccountsRequired,
    /// 计息已启用，不能重新设定时间基准。
    /// Interest is already active. The activation timestamp cannot be reset.
    #[msg("Lending interest is already active")]
    InterestAlreadyEnabled,
    /// 旧账本的未偿债务必须先结清。
    /// Legacy outstanding debt must first be settled.
    #[msg("Repay outstanding legacy debt before enabling interest")]
    LegacyDebtOutstanding,
    /// 本次还款的授权金额太小，不能清偿可记账债务。
    /// The authorized payment is too small to settle a measurable debt amount.
    #[msg("Repayment rounds down to zero")]
    ZeroIndexedRepayment,
    /// 清算人必须与仓位借款人不同。
    /// A liquidator must be distinct from the position borrower.
    #[msg("A borrower cannot liquidate their own position")]
    SelfLiquidation,
    /// 清算人须使用对应市场 Mint 的规范钱包关联账户。
    /// A liquidator must use their canonical wallet ATA for each market mint.
    #[msg("Invalid associated token account for the liquidator")]
    InvalidLiquidatorTokenAccount,
    /// 仓位债务未严格超过按有效价格计算的清算阈值。
    /// Debt does not strictly exceed the liquidation threshold at the valid price.
    #[msg("Position does not exceed the liquidation threshold")]
    PositionNotLiquidatable,
    /// 代偿额不符合单笔上限、抵押覆盖及坏账零额规则。
    /// Repayment violates the close cap, collateral backing, or zero-amount write-off rules.
    #[msg("Invalid liquidation repayment or collateral minimum")]
    InvalidLiquidationAmount,
    /// 当前代偿额按抵押最小单位向下取整后无抵押品可领取。
    /// The current repayment rounds down to zero collateral base units.
    #[msg("Liquidation rounds down to zero collateral")]
    ZeroLiquidationCollateral,
    /// 重新报价的抵押品领取量小于签名时设定的最小值。
    /// Requoted collateral output is below the signed minimum.
    #[msg("Calculated collateral output is below the signed minimum")]
    MinimumLiquidationCollateralNotMet,
}

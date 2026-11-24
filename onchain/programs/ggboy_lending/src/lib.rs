//! 抵押借贷市场程序入口，负责市场初始化、出借及管理抵押借款仓位。
//! Entry point for lending market initialization, supply, and collateralized borrowing positions.

use anchor_lang::prelude::*;

mod collateral;
mod debt;
mod initialize;
mod oracle;
mod risk;
mod state;
mod supply;
mod withdraw_supply;

pub use collateral::*;
pub use debt::*;
pub use initialize::*;
pub use oracle::*;
pub use state::{
    BorrowMarket, BorrowPosition, LendingBorrowAction, LendingMarket, MockCollateralPrice,
    SupplyPool, SupplyPosition,
};
pub use supply::*;
pub use withdraw_supply::*;

// 工作区为本程序记录的 Localnet 和 Devnet 公钥。
// Localnet and Devnet public key configured for this program in the workspace.
declare_id!("8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H");

/// 抵押借贷市场的 Anchor 指令入口。
/// Anchor instruction entry points for the GGBOY collateralized lending market.
#[program]
pub mod ggboy_lending {
    use super::*;

    /// 由程序升级权限持有人创建市场及两种资产的独立托管账户。
    /// Create the market and separate custody accounts for both assets as the current program upgrade authority.
    ///
    /// `context` 提供管理员签名、两枚已初始化的 Mint 和待创建的三个 PDA。
    /// `context` supplies the administrator signature, two initialized mints, and the three new PDAs.
    /// 初始化将两类托管权绑定市场 PDA。任何账户约束失败都会回滚整个指令。
    /// Initialization assigns both custody authorities to the market PDA. Any constraint failure reverts the whole instruction.
    pub fn initialize_lending_market(context: Context<InitializeLendingMarket>) -> Result<()> {
        initialize::handle(context)
    }

    /// 将出借者的 mockUSDC 转入市场托管账户，按最低到账份额限制记录仓位。
    /// Transfer the supplier's mockUSDC into market custody and credit shares subject to the minimum output.
    ///
    /// `context` 包含签名出借人、对应的市场和代币账户。
    /// `context` supplies the signing supplier and matching market and token accounts.
    /// `assets_in` 与 `min_shares_out` 分别是资产与份额的最小单位，均使用六位精度且必须为正。
    /// `assets_in` and `min_shares_out` are positive six-decimal asset and share base units respectively.
    /// 转账、份额更新和事件在同一笔交易生效，失败时一同回滚。
    /// The transfer, share updates, and event take effect together or revert on failure.
    pub fn supply(context: Context<Supply>, assets_in: u64, min_shares_out: u64) -> Result<()> {
        supply::handle(context, assets_in, min_shares_out)
    }

    /// 发布管理员提供的市场测试价格，发布时间使用链上时钟。
    /// Publish an administrator-supplied test price using the on-chain clock.
    ///
    /// `context` 绑定市场管理员和规范预言机 PDA。
    /// `context` binds the market administrator and canonical oracle PDA.
    /// `price_raw` 是 1 整单位抵押品对应的借款 Mint 最小单位数，必须为正。
    /// `price_raw` is positive debt mint base units per whole collateral token.
    pub fn set_mock_collateral_price(
        context: Context<SetMockCollateralPrice>,
        price_raw: u64,
    ) -> Result<()> {
        oracle::handle(context, price_raw)
    }

    /// 将抵押品转入托管，首次操作创建签名钱包的独立仓位。
    /// Transfer collateral into custody and create the signing wallet's position on first deposit.
    ///
    /// `context` 绑定签名钱包、其来源账户和市场托管。
    /// `context` binds the signing wallet, its source account, and market custody.
    /// `amount_raw` 是大于零的抵押 Mint 最小单位数。
    /// `amount_raw` is a positive amount in collateral mint base units.
    pub fn deposit_collateral(context: Context<DepositCollateral>, amount_raw: u64) -> Result<()> {
        collateral::deposit(context, amount_raw)
    }

    /// 在价格、抵押率和池流动性约束下发放借款并增加未偿本金。
    /// Lend debt tokens within price, LTV, and pool liquidity limits and increase outstanding principal.
    ///
    /// `context` 绑定借款仓位、资金池、市场价格和借款人的收款账户。
    /// `context` binds the position, cash pool, market price, and borrower's destination.
    /// `amount_raw` 是大于零的借款 Mint 最小单位数。
    /// `amount_raw` is a positive amount in debt mint base units.
    pub fn borrow(context: Context<Borrow>, amount_raw: u64) -> Result<()> {
        debt::borrow(context, amount_raw)
    }

    /// 从借款人转回借款资产并减少该仓位与市场的未偿本金。
    /// Transfer debt tokens back from the borrower and reduce position and market principal.
    ///
    /// `context` 绑定签名人、其仓位和市场的借款资产账户。
    /// `context` binds the signer, their position, and the market's debt token account.
    /// `amount_raw` 是大于零且不超过本金的借款 Mint 最小单位数。
    /// `amount_raw` is positive debt mint base units at or below the outstanding principal.
    pub fn repay(context: Context<Repay>, amount_raw: u64) -> Result<()> {
        debt::repay(context, amount_raw)
    }

    /// 在剩余抵押品覆盖未偿本金的前提下取回抵押资产。
    /// Release collateral while keeping enough locked collateral to cover any outstanding principal.
    ///
    /// `context` 绑定签名人、仓位和托管，存有债务时还需有效价格。
    /// `context` binds the signer, position, and custody. An active debt also requires a valid price.
    /// `amount_raw` 是大于零的抵押 Mint 最小单位数。
    /// `amount_raw` is a positive amount in collateral mint base units.
    pub fn withdraw_collateral(
        context: Context<WithdrawCollateral>,
        amount_raw: u64,
    ) -> Result<()> {
        collateral::withdraw(context, amount_raw)
    }

    /// 用签名人的出借份额换回借款代币，受已记账现金和实际托管余额约束。
    /// Redeem the signer's supply shares for debt tokens within accounted and actual custody cash limits.
    ///
    /// `context` 绑定市场、出借仓位和签名人的收款账户。两项输入均须为正。
    /// `context` binds the market, supply position, and signer's destination. Both inputs must be positive.
    /// `shares_raw` 使用出借份额最小单位，`min_amount_out_raw` 使用借款代币最小单位。
    /// `shares_raw` is in share base units and `min_amount_out_raw` is in debt token base units.
    /// 转账、份额扣减与实际结果事件同时生效。
    /// The transfer, share debits, and result event take effect together.
    pub fn withdraw_supply(
        context: Context<WithdrawSupply>,
        shares_raw: u64,
        min_amount_out_raw: u64,
    ) -> Result<()> {
        withdraw_supply::handle(context, shares_raw, min_amount_out_raw)
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
}

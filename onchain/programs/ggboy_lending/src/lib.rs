//! 抵押借贷市场程序入口，负责市场初始化、出借及管理抵押借款仓位。
//! Entry point for lending market initialization, supply, and collateralized borrowing positions.

use anchor_lang::prelude::*;

mod errors;
mod instructions;
mod risk;
mod state;

// 沿用客户端和跨程序调用使用的公开类型与报价函数。
// Preserve the public types and quote functions used by clients and CPI consumers.
pub use errors::LendingError;
pub use instructions::*;
pub use state::{
    BorrowMarket, BorrowPosition, LendingBorrowAction, LendingMarket, MockCollateralPrice,
    SupplyPool, SupplyPosition,
};

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
        instructions::initialize::handle(context)
    }

    /// 在未偿旧债务归零后，由市场管理员启用固定点计息。
    /// The administrator enables fixed-point interest after outstanding legacy debt reaches zero.
    pub fn enable_interest(context: Context<EnableInterest>) -> Result<()> {
        instructions::interest::enable(context)
    }

    /// 准备借贷池和签名出借人的仓位，由独立付款人承担首次创建费用。
    /// Prepare the lending pool and signing supplier's position using a separate rent payer.
    ///
    /// `context` 识别市场、签名出借人与付款人。已有份额和记账余额不变，无代币转账。
    /// `context` identifies the market, signing supplier, and payer. Existing shares and accounting balances are preserved without moving tokens.
    pub fn prepare_supply(context: Context<PrepareSupply>) -> Result<()> {
        instructions::prepare_supply::handle(context)
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
        instructions::supply::handle(context, assets_in, min_shares_out)
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
        instructions::oracle::handle(context, price_raw)
    }

    /// 将抵押品转入托管，首次操作创建签名钱包的独立仓位。
    /// Transfer collateral into custody and create the signing wallet's position on first deposit.
    ///
    /// `context` 绑定签名钱包、其来源账户和市场托管。
    /// `context` binds the signing wallet, its source account, and market custody.
    /// `amount_raw` 是大于零的抵押 Mint 最小单位数。
    /// `amount_raw` is a positive amount in collateral mint base units.
    pub fn deposit_collateral(context: Context<DepositCollateral>, amount_raw: u64) -> Result<()> {
        instructions::collateral::deposit(context, amount_raw)
    }

    /// 在价格、抵押率和池流动性约束下发放借款并增加未偿本金。
    /// Lend debt tokens within price, LTV, and pool liquidity limits and increase outstanding principal.
    ///
    /// `context` 绑定借款仓位、资金池、市场价格和借款人的收款账户。
    /// `context` binds the position, cash pool, market price, and borrower's destination.
    /// `amount_raw` 是大于零的借款 Mint 最小单位数。
    /// `amount_raw` is a positive amount in debt mint base units.
    pub fn borrow(context: Context<Borrow>, amount_raw: u64) -> Result<()> {
        instructions::debt::borrow(context, amount_raw)
    }

    /// 从借款人转回借款资产并减少该仓位与市场的未偿本金。
    /// Transfer debt tokens back from the borrower and reduce position and market principal.
    ///
    /// `context` 绑定签名人、其仓位和市场的借款资产账户。
    /// `context` binds the signer, their position, and the market's debt token account.
    /// `amount_raw` 是大于零且不超过本金的借款 Mint 最小单位数。
    /// `amount_raw` is positive debt mint base units at or below the outstanding principal.
    pub fn repay(context: Context<Repay>, amount_raw: u64) -> Result<()> {
        instructions::debt::repay(context, amount_raw)
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
        instructions::collateral::withdraw(context, amount_raw)
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
        instructions::withdraw_supply::handle(context, shares_raw, min_amount_out_raw)
    }

    /// 清算人代付超出清算阈值仓位的债务并获得抵押品，无法回收的债务冲减出借池资产。
    /// Repay a position beyond the liquidation threshold and seize collateral. Write unrecoverable debt off against pool assets.
    ///
    /// 两项参数是各自资产最小单位。双零仅用于无法覆盖一最小单位代偿的坏账。
    /// Both arguments use their respective asset base units. Two zeros are accepted only for debt with no repayable unit.
    pub fn liquidate(
        context: Context<Liquidate>,
        repay_raw: u64,
        min_collateral_raw: u64,
    ) -> Result<()> {
        instructions::liquidation::handle(context, repay_raw, min_collateral_raw)
    }

    /// 验证脚手架指令可以调用，返回成功且不读写链上账户。
    /// Confirm the scaffold instruction is callable and return success without accessing on-chain accounts.
    ///
    /// `_context` 是 Anchor 传入的指令上下文，本指令无需读取其中的数据。
    /// `_context` is the Anchor instruction context. This instruction does not read it.
    pub fn ping(_context: Context<Ping>) -> Result<()> {
        instructions::ping::handle()
    }
}

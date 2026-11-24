//! 借贷市场初始化指令的账户约束和状态写入。
//! Account constraints and state persistence for lending market initialization.

use anchor_lang::prelude::*;
use anchor_spl::token::{spl_token::native_mint, Mint, Token, TokenAccount};

use crate::{
    program::GgboyLending,
    state::{CASH_VAULT_SEED, COLLATERAL_VAULT_SEED, MARKET_SEED},
    LendingError, LendingMarket,
};

/// mockUSDC 借款资产使用的精度，单位为小数位数。
/// Required decimal precision of the mockUSDC debt asset.
const DEBT_MINT_DECIMALS: u8 = 6;

/// 创建市场状态、借款资金池和抵押托管账户所需的链上账户。
/// Accounts required to create market state, cash custody, and collateral custody.
#[derive(Accounts)]
pub struct InitializeLendingMarket<'info> {
    /// 持有程序升级权限的签名人，支付三个账户的免租金余额，单位为 lamports。
    /// Upgrade authority signer who pays the rent-exempt balance of the three accounts in lamports.
    #[account(mut)]
    pub administrator: Signer<'info>,

    /// Anchor 核对当前部署的借贷程序地址及可执行状态。
    /// Anchor checks the address and executable flag of the current lending program.
    pub lending_program: Program<'info, GgboyLending>,

    /// 校验升级权限属于当前借贷程序，防止借用其他程序的 ProgramData。
    /// Bind upgrade authority to this deployment by rejecting another program's ProgramData.
    #[account(
        constraint = lending_program.programdata_address()? == Some(program_data.key())
            @ LendingError::InvalidProgramData,
        constraint = program_data.upgrade_authority_address == Some(administrator.key())
            @ LendingError::UnauthorizedAdministrator,
    )]
    pub program_data: Account<'info, ProgramData>,

    /// 管理员选择的经典 SPL mockUSDC Mint，通过公钥和精度绑定。
    /// Classic SPL mockUSDC mint selected by the administrator. Its address and precision identify it.
    #[account(
        constraint = debt_mint.key() != native_mint::ID @ LendingError::UnsupportedNativeMint,
        constraint = debt_mint.decimals == DEBT_MINT_DECIMALS @ LendingError::InvalidDebtMintDecimals,
    )]
    pub debt_mint: Account<'info, Mint>,

    /// 管理员选择的经典 SPL tSOL Mint。独立于借款资产，精度沿用 Mint。
    /// Classic SPL tSOL mint selected by the administrator. Its address differs from the debt mint and its precision is read from the mint.
    #[account(
        constraint = collateral_mint.key() != debt_mint.key() @ LendingError::IdenticalAssetMints,
        constraint = collateral_mint.key() != native_mint::ID @ LendingError::UnsupportedNativeMint,
    )]
    pub collateral_mint: Account<'info, Mint>,

    /// 单次创建的市场状态，同时作为两个托管账户的代币操作权限。
    /// One-time market state creation. The same PDA authorizes token operations for both custody accounts.
    #[account(
        init,
        payer = administrator,
        space = LendingMarket::DISCRIMINATOR.len() + LendingMarket::INIT_SPACE,
        seeds = [MARKET_SEED],
        bump,
    )]
    pub market: Account<'info, LendingMarket>,

    /// 新建的空资金池，只托管绑定的 mockUSDC，转出必须使用市场 PDA 授权。
    /// New empty cash custody holding only the bound mockUSDC. Outflows require the market PDA's authority.
    #[account(
        init,
        payer = administrator,
        seeds = [CASH_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = debt_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub cash_vault: Account<'info, TokenAccount>,

    /// 新建的空抵押托管，只托管绑定的 tSOL，转出必须使用市场 PDA 授权。
    /// New empty collateral custody holding only the bound tSOL. Outflows require the market PDA's authority.
    #[account(
        init,
        payer = administrator,
        seeds = [COLLATERAL_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    /// 初始化两个代币托管账户的经典 SPL Token 程序。
    /// Classic SPL Token program initializing both custody accounts.
    pub token_program: Program<'info, Token>,

    /// 为市场和两个托管账户分配链上空间和免租金余额的系统程序。
    /// System program allocating space and rent-exempt balances for the market and both custody accounts.
    pub system_program: Program<'info, System>,
}

/// 将经过校验的管理员、Mint 和托管账户绑定保存到市场。
/// Persist validated administrator, mint, and custody bindings in the market.
///
/// `context` 包含 Anchor 校验和创建的账户。交易成功时三个账户一同生效。
/// `context` contains the accounts Anchor validates and creates. All three accounts take effect together on success.
pub(super) fn handle(context: Context<InitializeLendingMarket>) -> Result<()> {
    // 两种资产的实际余额保存在各自的 SPL 账户，市场状态集中保存绑定关系。
    // Each SPL account holds its actual token balance. Market state stores their bindings.
    context.accounts.market.set_inner(LendingMarket {
        administrator: context.accounts.administrator.key(),
        debt_mint: context.accounts.debt_mint.key(),
        collateral_mint: context.accounts.collateral_mint.key(),
        cash_vault: context.accounts.cash_vault.key(),
        collateral_vault: context.accounts.collateral_vault.key(),
        bump: context.bumps.market,
    });
    Ok(())
}

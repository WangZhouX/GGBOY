//! tSOL 抵押品存取的账户约束、可借额度和代币结算。
//! Account constraints, borrowing limits, and token settlement for tSOL collateral operations.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use super::interest;
use super::oracle::require_fresh_price;
use crate::{
    risk::collateral_borrow_capacity,
    state::{BORROW_POSITION_SEED, COLLATERAL_VAULT_SEED, MARKET_SEED, MOCK_COLLATERAL_PRICE_SEED},
    BorrowPosition, LendingBorrowAction, LendingError, LendingMarket, MockCollateralPrice,
};

/// 增加由签名借款人独立持有的抵押仓位所需账户。
/// Accounts required to increase the signing borrower's own collateral position.
#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    /// 既授权本人代币转账，也为新抵押仓位提供免租金余额的签名人。
    /// Signer authorizing a transfer from their token account and funding the new position's rent reserve.
    #[account(mut)]
    pub borrower: Signer<'info>,

    /// 规范市场 PDA，将指令绑定到已配置的抵押 Mint 和托管账户。
    /// Canonical market PDA binding the instruction to its configured collateral mint and custody.
    #[account(
        seeds = [MARKET_SEED],
        bump = market.bump,
        has_one = collateral_mint,
        has_one = collateral_vault,
    )]
    pub market: Account<'info, LendingMarket>,

    /// 市场登记的经典 SPL 抵押 Mint，提供真实转账精度。
    /// Registered classic SPL collateral mint supplying the actual transfer precision.
    pub collateral_mint: Account<'info, Mint>,

    /// 市场 PDA 控制的抵押托管账户，与借款现金隔离。
    /// Collateral custody under market PDA authority, separate from borrowing cash.
    #[account(
        mut,
        seeds = [COLLATERAL_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    /// 签名借款人持有的同 Mint 代币来源，用实际最小单位余额支付。
    /// Matching-mint token source owned by the signing borrower and debited in base units.
    #[account(
        mut,
        constraint = source.key() != collateral_vault.key() @ LendingError::InvalidBorrowTokenAccount,
        token::mint = collateral_mint,
        token::authority = borrower,
        token::token_program = token_program,
    )]
    pub source: Account<'info, TokenAccount>,

    /// 按市场和借款人派生的抵押债务仓位，首笔存入时创建。
    /// Collateral and debt position derived from market and borrower, created on first deposit.
    #[account(
        init_if_needed,
        payer = borrower,
        space = interest::borrow_position_space(borrow_position.data_len()),
        seeds = [BORROW_POSITION_SEED, market.key().as_ref(), borrower.key().as_ref()],
        bump,
    )]
    pub borrow_position: Account<'info, BorrowPosition>,

    /// 核对 Mint 精度并执行转账的经典 SPL Token 程序。
    /// Classic SPL Token program checking mint precision and executing the transfer.
    pub token_program: Program<'info, Token>,

    /// 分配首次抵押仓位时调用的系统程序。
    /// System Program called to allocate a first collateral position.
    pub system_program: Program<'info, System>,
}

/// 把当前签名借款人可取的抵押品退回同钱包所需账户。
/// Accounts required to return safely withdrawable collateral to the signing borrower.
#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    /// 授权减少本人仓位并持有收款账户的签名借款人。
    /// Signing borrower authorizing the decrease in their position and owning the destination.
    pub borrower: Signer<'info>,

    /// 规范市场 PDA，既绑定抵押账户，也用于授权托管转出。
    /// Canonical market PDA that binds collateral accounts and authorizes custody outflows.
    #[account(
        seeds = [MARKET_SEED],
        bump = market.bump,
        has_one = collateral_mint,
        has_one = collateral_vault,
    )]
    pub market: Account<'info, LendingMarket>,

    /// 市场登记的抵押 Mint，用于额度运算和精度校验转账。
    /// Registered collateral mint used for limit arithmetic and decimal-checked transfers.
    pub collateral_mint: Account<'info, Mint>,

    /// 市场持有的规范抵押托管，实际最小单位余额须覆盖请求。
    /// Canonical market-owned collateral custody whose base-unit balance must cover the request.
    #[account(
        mut,
        seeds = [COLLATERAL_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    /// 同 Mint 且由借款人持有的代币收款账户。
    /// Matching-mint destination token account owned by the borrower.
    #[account(
        mut,
        constraint = destination.key() != collateral_vault.key() @ LendingError::InvalidBorrowTokenAccount,
        token::mint = collateral_mint,
        token::authority = borrower,
        token::token_program = token_program,
    )]
    pub destination: Account<'info, TokenAccount>,

    /// 已存在的抵押仓位，核对规范 PDA 与存储的市场和借款人身份。
    /// Existing collateral position with its canonical PDA and stored market and borrower verified.
    #[account(
        mut,
        seeds = [BORROW_POSITION_SEED, market.key().as_ref(), borrower.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidBorrowPosition,
        has_one = borrower @ LendingError::InvalidBorrowPosition,
    )]
    pub borrow_position: Account<'info, BorrowPosition>,

    /// CHECK: 始终绑定规范测试价格 PDA。有债务取回时，处理函数验证程序归属、Anchor 布局、市场绑定和时效。
    /// Always bind the canonical mock price PDA. When debt remains, the handler validates ownership, layout, market, and freshness.
    #[account(seeds = [MOCK_COLLATERAL_PRICE_SEED, market.key().as_ref()], bump)]
    pub mock_collateral_price: UncheckedAccount<'info>,

    /// 负责精度校验和托管转出的经典 SPL Token 程序。
    /// Classic SPL Token program for decimal checks and custody transfers.
    pub token_program: Program<'info, Token>,
}

/// 从签名借款人转入抵押资产并更新其仓位，成功后发出抵押变动事件。
/// Transfer collateral in from the signing borrower, update their position, and emit the resulting amounts.
///
/// `context` 绑定市场、借款人和代币账户。`amount_raw` 是正数抵押 Mint 最小单位。
/// `context` binds the market, borrower, and token accounts. `amount_raw` is positive collateral mint base units.
/// 代币转账或仓位账户校验失败会让首次建仓和余额变动一同回滚。
/// A transfer or account check failure reverts any first-position creation and balance changes.
pub(crate) fn deposit(context: Context<DepositCollateral>, amount_raw: u64) -> Result<()> {
    require_gt!(amount_raw, 0, LendingError::InvalidBorrowAmount);

    // 记录规范市场与签名人的公钥，便于同时验证已有仓位和初始化新仓位。
    // Record the canonical market and signer keys to validate an existing position or initialize a fresh one.
    let accounts = context.accounts;
    let market = accounts.market.key();
    let borrower = accounts.borrower.key();
    let position = &mut accounts.borrow_position;
    let is_new = position.market == Pubkey::default()
        && position.borrower == Pubkey::default()
        && position.collateral_raw == 0
        && position.debt_raw == 0;
    require!(
        is_new || (position.market == market && position.borrower == borrower),
        LendingError::InvalidBorrowPosition
    );

    // 以抵押 Mint 最小单位验证钱包余额并预先检查记账是否溢出。
    // Check the wallet amount and validate the new ledger balance in collateral mint base units before transfer.
    require_gte!(
        accounts.source.amount,
        amount_raw,
        LendingError::InsufficientBorrowTokenBalance
    );
    let collateral_after = position
        .collateral_raw
        .checked_add(amount_raw)
        .ok_or(LendingError::BorrowOverflow)?;

    // 抵押资产必须实际进入托管，再给当前签名人增加账面抵押品。
    // The collateral must reach custody before increasing the signing wallet's recorded collateral.
    token::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.source.to_account_info(),
                mint: accounts.collateral_mint.to_account_info(),
                to: accounts.collateral_vault.to_account_info(),
                authority: accounts.borrower.to_account_info(),
            },
        ),
        amount_raw,
        accounts.collateral_mint.decimals,
    )?;

    position.market = market;
    position.borrower = borrower;
    position.collateral_raw = collateral_after;
    let current_debt = interest::project_position_debt(
        &position.to_account_info(),
        position.debt_raw,
        Clock::get()?.unix_timestamp,
    )?;

    emit!(LendingBorrowAction {
        market,
        borrower,
        kind: 0, // 事件类型 0 表示存入抵押品。 Event kind 0 is a collateral deposit.
        amount_raw,
        collateral_raw: collateral_after,
        debt_raw: current_debt,
    });
    Ok(())
}

/// 在取回后的抵押率仍满足借款上限时返还抵押资产。
/// Return collateral when the remaining collateral still satisfies the borrowing limit.
///
/// `context` 绑定现有仓位和托管，`amount_raw` 是正数抵押 Mint 最小单位。
/// `context` binds the existing position and custody. `amount_raw` is positive collateral mint base units.
/// 无债仓位可在价格不可用时取回全部抵押品。有债仓位须通过价格时效和额度校验。
/// A debt-free position can withdraw all collateral without a price. An open loan requires fresh pricing and sufficient backing.
pub(crate) fn withdraw(context: Context<WithdrawCollateral>, amount_raw: u64) -> Result<()> {
    require_gt!(amount_raw, 0, LendingError::InvalidBorrowAmount);

    // 先限制可付金额和当前借款人登记的余额，避免动用其他仓位的抵押品。
    // First cap the payout by custody and the borrower's recorded balance so other positions' collateral stays reserved.
    let accounts = context.accounts;
    let market = accounts.market.key();
    let position = &mut accounts.borrow_position;
    let collateral_after = position
        .collateral_raw
        .checked_sub(amount_raw)
        .ok_or(LendingError::CollateralTooLow)?;
    require_gte!(
        accounts.collateral_vault.amount,
        amount_raw,
        LendingError::InsufficientBorrowTokenBalance
    );

    let now = Clock::get()?.unix_timestamp;
    let current_debt =
        interest::project_position_debt(&position.to_account_info(), position.debt_raw, now)?;
    if current_debt != 0 {
        // 规范账户可尚未初始化。仅有债务时要求它内有由本程序管理的 Anchor 价格状态。
        // The canonical account may still be uninitialized. With debt outstanding, require an Anchor price state owned by this program.
        let price_info = accounts.mock_collateral_price.to_account_info();
        require_keys_eq!(*price_info.owner, crate::ID, LendingError::InvalidMockPrice);
        let price_data = price_info.try_borrow_data()?;
        let price_account = MockCollateralPrice::try_deserialize(&mut &price_data[..])
            .map_err(|_| error!(LendingError::InvalidMockPrice))?;

        // 用取回后的余额按同一借款 LTV 向下取整债务上限，确保至少留下所需抵押量。
        // Floor the debt limit from the remaining collateral at the borrowing LTV, ensuring the required collateral stays locked.
        let price_raw = require_fresh_price(&price_account, market, now)?;
        let remaining_capacity = collateral_borrow_capacity(
            collateral_after,
            accounts.collateral_mint.decimals,
            price_raw,
        )?;
        require!(
            remaining_capacity >= u128::from(current_debt),
            LendingError::CollateralTooLow
        );
    }

    // 使用初始化时绑定的市场 PDA 签名。只有托管实际出账后才扣减账面余额。
    // Sign with the market PDA stored at initialization and debit the position only after custody pays out.
    let market_bump = [accounts.market.bump];
    let signer_seeds: &[&[u8]] = &[MARKET_SEED, &market_bump];
    token::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.collateral_vault.to_account_info(),
                mint: accounts.collateral_mint.to_account_info(),
                to: accounts.destination.to_account_info(),
                authority: accounts.market.to_account_info(),
            },
        )
        .with_signer(&[signer_seeds]),
        amount_raw,
        accounts.collateral_mint.decimals,
    )?;

    position.collateral_raw = collateral_after;

    emit!(LendingBorrowAction {
        market,
        borrower: accounts.borrower.key(),
        kind: 3, // 事件类型 3 表示取回抵押品。 Event kind 3 is a collateral withdrawal.
        amount_raw,
        collateral_raw: collateral_after,
        debt_raw: current_debt,
    });
    Ok(())
}

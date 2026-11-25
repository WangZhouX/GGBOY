//! 发放和归还借款的账户校验、资金托管及本金记账。
//! Account validation, cash custody, and principal accounting for loans and repayments.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use super::interest::{self, PositionInterest};
use super::oracle::require_fresh_price;
use crate::{
    risk::collateral_borrow_capacity,
    state::{
        BORROW_MARKET_SEED, BORROW_POSITION_SEED, CASH_VAULT_SEED, MARKET_SEED,
        MOCK_COLLATERAL_PRICE_SEED, SUPPLY_POOL_SEED,
    },
    BorrowMarket, BorrowPosition, LendingBorrowAction, LendingError, LendingMarket,
    MockCollateralPrice, SupplyPool,
};

/// 发放新借款需要的签名钱包、借款总账、风险价格和资产账户。
/// Signing wallet, debt ledger, risk price, and asset accounts for issuing a loan.
#[derive(Accounts)]
pub struct Borrow<'info> {
    /// 借款人签名，首笔借款时出资创建市场借款总账 PDA。
    /// Signing borrower pays the rent exemption for the market debt ledger on its first loan.
    #[account(mut)]
    pub borrower: Signer<'info>,

    /// 市场及其绑定的借款 Mint、抵押 Mint 和现金托管地址。
    /// Market with its bound debt mint, collateral mint, and cash custody address.
    #[account(seeds = [MARKET_SEED], bump = market.bump, has_one = debt_mint, has_one = collateral_mint, has_one = cash_vault)]
    pub market: Account<'info, LendingMarket>,

    /// 借款资产 Mint，按其精度执行代币转账。
    /// Debt asset mint. Transfers check its decimal precision.
    pub debt_mint: Account<'info, Mint>,

    /// 抵押资产 Mint，提供抵押余额和价格的换算精度。
    /// Collateral mint, supplying the scale for valuing locked collateral.
    pub collateral_mint: Account<'info, Mint>,

    /// 现金从市场自己的规范 PDA 托管账户转出。
    /// Loan cash comes from the market's canonical custody account.
    #[account(
        mut,
        seeds = [CASH_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = debt_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub cash_vault: Account<'info, TokenAccount>,

    /// 本次款项到账的签名借款人代币账户。
    /// Debt token account belonging to the borrower that receives the loan.
    #[account(
        mut,
        constraint = destination.key() != cash_vault.key() @ LendingError::InvalidBorrowTokenAccount,
        token::mint = debt_mint,
        token::authority = borrower,
        token::token_program = token_program,
    )]
    pub destination: Account<'info, TokenAccount>,

    /// 已记账的出借资产限制市场能发放的借款总额。
    /// Recorded supplied assets limit the total principal this market may lend.
    #[account(seeds = [SUPPLY_POOL_SEED, market.key().as_ref()], bump, has_one = market)]
    pub supply_pool: Account<'info, SupplyPool>,

    /// 单独的市场本金总账，首次借款创建。
    /// Separate market principal ledger, initialized by the first successful loan.
    #[account(
        init_if_needed,
        payer = borrower,
        space = BorrowMarket::DISCRIMINATOR.len() + BorrowMarket::INIT_SPACE,
        seeds = [BORROW_MARKET_SEED, market.key().as_ref()],
        bump,
    )]
    pub borrow_market: Account<'info, BorrowMarket>,

    /// 先前建立的个人仓位。只有指定钱包可以借款。
    /// The existing position. Only the recorded borrower may borrow against it.
    #[account(
        mut,
        seeds = [BORROW_POSITION_SEED, market.key().as_ref(), borrower.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidBorrowPosition,
        has_one = borrower @ LendingError::InvalidBorrowPosition,
    )]
    pub borrow_position: Account<'info, BorrowPosition>,

    /// 市场管理员发布的规范价格账户，执行时仍须核对时效。
    /// Canonical price published by the market administrator, checked again for freshness at execution.
    #[account(
        seeds = [MOCK_COLLATERAL_PRICE_SEED, market.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidMockPrice,
    )]
    pub mock_collateral_price: Account<'info, MockCollateralPrice>,

    /// 用于支付借款资产的经典 SPL Token 程序。
    /// Classic SPL Token program for paying out debt assets.
    pub token_program: Program<'info, Token>,

    /// 首笔借款时创建总账用的 System Program。
    /// System Program used to allocate the ledger on the first loan.
    pub system_program: Program<'info, System>,
}

/// 还款需要的钱包代币来源、托管账户和两个本金账本。
/// Wallet token source, custody, and both principal balances required to repay.
#[derive(Accounts)]
pub struct Repay<'info> {
    /// 付款并减少自己未偿本金的签名钱包。
    /// Wallet paying to reduce its own outstanding principal.
    pub borrower: Signer<'info>,

    /// 市场状态，绑定借款资产和托管账户。
    /// Market state binding the debt mint and custody.
    #[account(seeds = [MARKET_SEED], bump = market.bump, has_one = debt_mint, has_one = cash_vault)]
    pub market: Account<'info, LendingMarket>,

    /// 转回资金池的借款资产 Mint。
    /// Debt asset mint returned to the pool.
    pub debt_mint: Account<'info, Mint>,

    /// 由市场 PDA 授权的规范现金托管账户。
    /// Canonical cash custody controlled by the market PDA.
    #[account(
        mut,
        seeds = [CASH_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = debt_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub cash_vault: Account<'info, TokenAccount>,

    /// 签名借款人用于付款的独立代币账户。
    /// Separate debt token account used by the signing borrower to pay.
    #[account(
        mut,
        constraint = source.key() != cash_vault.key() @ LendingError::InvalidBorrowTokenAccount,
        token::mint = debt_mint,
        token::authority = borrower,
        token::token_program = token_program,
    )]
    pub source: Account<'info, TokenAccount>,

    /// 本金偿还后同步减少的市场总账。
    /// Market ledger reduced by the repayment amount.
    #[account(
        mut,
        seeds = [BORROW_MARKET_SEED, market.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidBorrowAccounting,
    )]
    pub borrow_market: Account<'info, BorrowMarket>,

    /// 记有签名人目前未偿本金的个人借款仓位。
    /// Signing borrower's existing position with outstanding principal.
    #[account(
        mut,
        seeds = [BORROW_POSITION_SEED, market.key().as_ref(), borrower.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidBorrowPosition,
        has_one = borrower @ LendingError::InvalidBorrowPosition,
    )]
    pub borrow_position: Account<'info, BorrowPosition>,

    /// 转回借款资产所用的经典 SPL Token 程序。
    /// Classic SPL Token program used to return the debt assets.
    pub token_program: Program<'info, Token>,
}

/// 借款和出借提取共用的可付现金，不含直接转入托管的额外代币。
/// Cash available for borrowing and supply withdrawals, excluding extra direct deposits into custody.
///
/// `recorded_assets`、`cash`、`total_debt` 均为借款 Mint 最小单位。未偿本金、现金与记账资产不一致时拒绝。
/// `recorded_assets`, `cash`, and `total_debt` use debt mint base units. Reject inconsistent amounts.
pub(crate) fn available_accounted_cash(
    recorded_assets: u64,
    cash: u64,
    total_debt: u64,
) -> Result<u64> {
    // 已记账资产中尚未借出的部分必须能由当前托管余额覆盖。
    // Current custody must cover the portion of recorded assets that is not lent out.
    let accounted_cash = recorded_assets
        .checked_sub(total_debt)
        .ok_or(LendingError::InvalidBorrowAccounting)?;
    require!(
        accounted_cash <= cash,
        LendingError::InvalidBorrowAccounting
    );
    Ok(accounted_cash.min(cash))
}

/// 校验抵押与资金池的限制，利用市场 PDA 转账，再提交两个本金账本。
/// Check collateral and pool limits, sign the payout with the market PDA, then commit both principal balances.
///
/// `context` 绑定市场、签名借款人、价格和托管。`amount_raw` 为借款 Mint 最小单位，必须为正。
/// `context` binds the market, signing borrower, oracle, and custody. `amount_raw` is positive debt mint base units.
pub(crate) fn borrow(context: Context<Borrow>, amount_raw: u64) -> Result<()> {
    require!(amount_raw > 0, LendingError::InvalidBorrowAmount);
    let accounts = context.accounts;

    // 新建总账初始为零；后续使用规范种子找到总账，再比较其已存市场地址。
    // A new ledger starts at zero. Later borrows load the canonical PDA and verify its stored market key.
    let market = accounts.market.key();
    let ledger = &accounts.borrow_market;
    let total_debt = ledger.total_debt_raw;
    require!(
        (ledger.market == Pubkey::default() && total_debt == 0) || ledger.market == market,
        LendingError::InvalidBorrowAccounting
    );
    let position = &accounts.borrow_position;
    // 借款定价、抵押限额与计息采用同一个链上时间。
    // Use one on-chain time for debt pricing, collateral limits, and accrued interest.
    let now = Clock::get()?.unix_timestamp;
    let pool_info = accounts.supply_pool.to_account_info();
    let position_info = accounts.borrow_position.to_account_info();
    let prior_position = interest::read_position(&position_info)?;
    let (new_debt, new_total, indexed) = if let Some(mut pool) = interest::read_pool(&pool_info)? {
        // 激活后供给池存放归一化总债务。旧的只读传法不能绕过计息。
        // An active pool stores normalized aggregate debt. The legacy readonly meta cannot bypass interest.
        require!(
            pool_info.is_writable,
            LendingError::InterestAccountsRequired
        );
        require!(
            pool.cash <= accounts.cash_vault.amount,
            LendingError::InvalidBorrowAccounting
        );
        pool.cash = pool
            .cash
            .checked_sub(amount_raw)
            .ok_or(LendingError::InsufficientBorrowLiquidity)?;
        let mut indexed_position = prior_position.unwrap_or(PositionInterest {
            start: pool.start,
            shares: 0,
        });
        require!(
            indexed_position.start == pool.start
                && indexed_position.shares <= pool.shares
                && (prior_position.is_some() || position.debt_raw == 0),
            LendingError::InvalidInterestAccounting
        );
        let index = pool.project(now)?.index;
        let issued = interest::normalize_borrow(amount_raw, index);
        indexed_position.shares = indexed_position
            .shares
            .checked_add(issued)
            .ok_or(LendingError::BorrowOverflow)?;
        pool.shares = pool
            .shares
            .checked_add(issued)
            .ok_or(LendingError::BorrowOverflow)?;
        let projected = pool.project(now)?;
        (
            interest::debt_due(indexed_position.shares, index)?,
            projected.debt,
            Some((pool, indexed_position, projected.assets)),
        )
    } else {
        require!(
            prior_position.is_none() && position.debt_raw <= total_debt,
            LendingError::InvalidBorrowAccounting
        );
        // 原模式仅把登记现金换成本金，不能支付直接捐入的代币。
        // In a legacy pool a loan exchanges recorded cash for principal and cannot spend unsolicited transfers.
        let available = available_accounted_cash(
            accounts.supply_pool.accounted_assets_raw,
            accounts.cash_vault.amount,
            total_debt,
        )?;
        require!(
            amount_raw <= available,
            LendingError::InsufficientBorrowLiquidity
        );
        (
            position
                .debt_raw
                .checked_add(amount_raw)
                .ok_or(LendingError::BorrowOverflow)?,
            total_debt
                .checked_add(amount_raw)
                .ok_or(LendingError::BorrowOverflow)?,
            None,
        )
    };
    let price = require_fresh_price(&accounts.mock_collateral_price, market, now)?;
    let maximum_debt = collateral_borrow_capacity(
        position.collateral_raw,
        accounts.collateral_mint.decimals,
        price,
    )?;
    require!(
        u128::from(new_debt) <= maximum_debt,
        LendingError::CollateralTooLow
    );

    // 由现有市场 PDA 签名，将指定借款代币发往签名借款人的账户。
    // Sign with the existing market PDA to pay the specified debt tokens to the signing borrower.
    let bump = [accounts.market.bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.cash_vault.to_account_info(),
                mint: accounts.debt_mint.to_account_info(),
                to: accounts.destination.to_account_info(),
                authority: accounts.market.to_account_info(),
            },
            &[seeds],
        ),
        amount_raw,
        accounts.debt_mint.decimals,
    )?;

    // SPL 转账和两处本金更新在同一笔交易中生效。
    // The SPL transfer and changes to both principal balances take effect in the same transaction.
    accounts.borrow_market.set_inner(BorrowMarket {
        market,
        total_debt_raw: new_total,
    });
    // 两处计息尾部与 SPL 转账同交易提交。首次计息借款保留旧字段并扩充仓位。
    // Commit both interest trailers with the SPL transfer. The first indexed loan extends the position without changing its old fields.
    if let Some((pool, position, assets)) = indexed {
        if prior_position.is_none() {
            interest::extend_position(
                &position_info,
                &accounts.borrower,
                &accounts.system_program,
            )?;
        }
        interest::store_projected_pool(&pool_info, pool, assets)?;
        interest::store_position(&position_info, position)?;
    }
    accounts.borrow_position.debt_raw = new_debt;
    emit!(LendingBorrowAction {
        market,
        borrower: accounts.borrower.key(),
        kind: 1,
        amount_raw,
        collateral_raw: accounts.borrow_position.collateral_raw,
        debt_raw: new_debt,
    });
    Ok(())
}

/// 转回签名钱包支付的借款代币，本金从个人仓位和市场总账等额扣减。
/// Return debt tokens paid by the signing wallet and decrease both principal balances by the same amount.
///
/// `context` 绑定签名钱包、已有仓位及资金池。`amount_raw` 必须为正且至多为未偿本金。
/// `context` binds the signer, existing position, and pool. `amount_raw` is positive and cannot exceed principal.
pub(crate) fn repay(context: Context<Repay>, amount_raw: u64) -> Result<()> {
    require!(amount_raw > 0, LendingError::InvalidBorrowAmount);
    let accounts = context.accounts;

    // 任何价格状态都允许还款。启用计息后，以同一市场账面债务的实际变化作为扣款。
    // Repayment works regardless of price. Indexed repayment debits the actual reduction in aggregate debt.
    let market = accounts.market.key();
    let position_info = accounts.borrow_position.to_account_info();
    let indexed_position = interest::read_position(&position_info)?;
    let (paid, new_debt, new_total, indexed) = if let Some(mut position) = indexed_position {
        let [pool_info] = context.remaining_accounts else {
            return err!(LendingError::InterestAccountsRequired);
        };
        let (expected, _) =
            Pubkey::find_program_address(&[SUPPLY_POOL_SEED, market.as_ref()], &crate::ID);
        require_keys_eq!(
            *pool_info.key,
            expected,
            LendingError::InvalidInterestAccounting
        );
        require!(
            pool_info.is_writable,
            LendingError::InterestAccountsRequired
        );
        let now = Clock::get()?.unix_timestamp;
        let mut pool =
            interest::read_pool(pool_info)?.ok_or(LendingError::InvalidInterestAccounting)?;
        require!(
            pool.cash <= accounts.cash_vault.amount,
            LendingError::InvalidBorrowAccounting
        );
        let before = pool.project(now)?;
        let payment = interest::debt_payment(pool, position, before, amount_raw)?;
        require_gt!(payment.amount, 0, LendingError::ZeroIndexedRepayment);
        pool.shares -= payment.shares;
        position.shares -= payment.shares;
        pool.cash = pool
            .cash
            .checked_add(payment.amount)
            .ok_or(LendingError::BorrowOverflow)?;
        let after = pool.project(now)?;
        (
            payment.amount,
            interest::debt_due(position.shares, after.index)?,
            after.debt,
            Some((pool_info, pool, position, after.assets)),
        )
    } else {
        let debt = accounts.borrow_position.debt_raw;
        let total_debt = accounts.borrow_market.total_debt_raw;
        require!(debt <= total_debt, LendingError::InvalidBorrowAccounting);
        (
            amount_raw,
            debt.checked_sub(amount_raw)
                .ok_or(LendingError::RepaymentExceedsDebt)?,
            total_debt
                .checked_sub(amount_raw)
                .ok_or(LendingError::InvalidBorrowAccounting)?,
            None,
        )
    };
    require!(
        accounts.source.amount >= paid,
        LendingError::InsufficientBorrowTokenBalance
    );

    token::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.source.to_account_info(),
                mint: accounts.debt_mint.to_account_info(),
                to: accounts.cash_vault.to_account_info(),
                authority: accounts.borrower.to_account_info(),
            },
        ),
        paid,
        accounts.debt_mint.decimals,
    )?;

    // 以实际付清的整数账面债务增加登记现金，份额数量保持不变。
    // Replace exactly the settled book debt with registered cash while preserving lender share counts.
    if let Some((pool_info, pool, position, assets)) = indexed {
        interest::store_projected_pool(pool_info, pool, assets)?;
        interest::store_position(&position_info, position)?;
    }
    accounts.borrow_market.total_debt_raw = new_total;
    accounts.borrow_position.debt_raw = new_debt;
    emit!(LendingBorrowAction {
        market: accounts.market.key(),
        borrower: accounts.borrower.key(),
        kind: 2,
        amount_raw: paid,
        collateral_raw: accounts.borrow_position.collateral_raw,
        debt_raw: new_debt,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::available_accounted_cash;

    /// 核对未偿本金、直接转入代币和缺少托管支撑时的可付现金。
    /// Check available cash with outstanding principal, direct transfers, and missing custody backing.
    #[test]
    fn pays_only_backed_recorded_cash() {
        assert_eq!(available_accounted_cash(120, 40, 80).unwrap(), 40);
        assert_eq!(available_accounted_cash(120, 70, 80).unwrap(), 40);
        assert_eq!(available_accounted_cash(120, 0, 120).unwrap(), 0);
        assert!(available_accounted_cash(120, 39, 80).is_err());
        assert!(available_accounted_cash(120, 1, 121).is_err());
    }
}

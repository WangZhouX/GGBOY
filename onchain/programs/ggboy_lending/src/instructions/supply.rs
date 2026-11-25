//! 借贷池出借的账户约束、报价和原子记账。
//! Account constraints, quoting, and atomic accounting for lending pool supply.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use super::interest;
use crate::{
    state::{CASH_VAULT_SEED, MARKET_SEED, SUPPLY_POOL_SEED, SUPPLY_POSITION_SEED},
    LendingError, LendingMarket, SupplyPool, SupplyPosition,
};

/// 支付 mockUSDC 并为签名钱包登记出借份额所需的账户。
/// Accounts required to pay mockUSDC and credit supply shares to the signing wallet.
#[derive(Accounts)]
pub struct Supply<'info> {
    /// 出借资金的签名人，首次创建池记账或个人仓位时支付免租金余额。
    /// Funds the supply and pays the rent-exempt balance when pool accounting or the wallet position is created.
    #[account(mut)]
    pub supplier: Signer<'info>,

    /// 原始 169 字节市场状态，约束本次出借使用的 Mint 和托管地址。
    /// Original 169-byte market state that binds the mint and cash custody for this supply.
    #[account(seeds = [MARKET_SEED], bump = market.bump, has_one = debt_mint, has_one = cash_vault)]
    pub market: Account<'info, LendingMarket>,

    /// 市场登记的六位小数借款资产 Mint，用于 TransferChecked 校验。
    /// Registered six-decimal debt mint, used for TransferChecked validation.
    pub debt_mint: Account<'info, Mint>,

    /// 资金转入市场绑定的规范托管账户，代币权限属于市场 PDA。
    /// Deposit funds into the market's canonical custody under its PDA authority.
    #[account(
        mut,
        seeds = [CASH_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = debt_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub cash_vault: Account<'info, TokenAccount>,

    /// 出借人实际持有的借款资产账户。地址必须和托管账户不同。
    /// Debt token account owned by the supplier. It must differ from cash custody.
    #[account(
        mut,
        constraint = source.key() != cash_vault.key() @ LendingError::InvalidSupplySource,
        token::mint = debt_mint,
        token::authority = supplier,
        token::token_program = token_program,
    )]
    pub source: Account<'info, TokenAccount>,

    /// 每个市场独立的出借记账。不存在时由首笔成功的出借创建。
    /// Supply accounting for this market, created by its first successful supply when absent.
    #[account(
        init_if_needed,
        payer = supplier,
        space = interest::supply_pool_space(supply_pool.data_len()),
        seeds = [SUPPLY_POOL_SEED, market.key().as_ref()],
        bump,
    )]
    pub supply_pool: Account<'info, SupplyPool>,

    /// 记录该签名钱包在当前市场的份额，不与其他钱包共用。
    /// Records the signing wallet's shares in this market independently from other wallets.
    #[account(
        init_if_needed,
        payer = supplier,
        space = SupplyPosition::DISCRIMINATOR.len() + SupplyPosition::INIT_SPACE,
        seeds = [SUPPLY_POSITION_SEED, market.key().as_ref(), supplier.key().as_ref()],
        bump,
    )]
    pub supply_position: Account<'info, SupplyPosition>,

    /// 执行有精度校验的经典 SPL Token 转账。
    /// Classic SPL Token program for decimal-checked transfers.
    pub token_program: Program<'info, Token>,

    /// 首次出借时分配记账与个人仓位 PDA。
    /// Allocates the accounting and wallet position PDAs on first supply.
    pub system_program: Program<'info, System>,
}

/// 一笔已执行出借的资产与份额变化，供链上历史与后续索引读取。
/// Asset and share changes of an executed supply, for transaction history and future indexing.
#[event]
pub struct LendingSupply {
    /// 市场状态 PDA 公钥。
    /// Public key of the market state PDA.
    pub market: Pubkey,
    /// 出借人的签名公钥。
    /// Public key of the signing supplier.
    pub supplier: Pubkey,
    /// 资金池使用的借款资产 Mint 公钥。
    /// Public key of the debt asset mint used by the pool.
    pub debt_mint: Pubkey,
    /// 已转入资金池的六位精度借款资产最小单位数。
    /// Base units of the six-decimal debt asset transferred into custody.
    pub assets_in: u64,
    /// 记入出借仓位的六位精度份额最小单位数。
    /// Base units of six-decimal shares credited to the supply position.
    pub shares_out: u64,
}

/// 用存入前的池记账值计算新增份额，按最小单位向下舍入。
/// Quote new shares from pre-supply accounting, rounded down to a whole base unit.
///
/// `assets_in` 与 `accounted_assets` 是借款 Mint 最小单位，`total_shares` 是份额最小单位。
/// `assets_in` and `accounted_assets` are debt mint base units. `total_shares` is share base units.
/// 资产与份额都为零时一比一报价。仅一项为零、报价为零或输出溢出时失败。
/// Quote one-to-one when both balances are zero. Reject inconsistent zeros, zero output, and overflow.
fn calculate_shares(assets_in: u64, accounted_assets: u64, total_shares: u64) -> Result<u64> {
    if accounted_assets == 0 && total_shares == 0 {
        return Ok(assets_in);
    }
    require!(
        accounted_assets > 0 && total_shares > 0,
        LendingError::InvalidSupplyAccounting
    );

    // 两个 u64 先扩展至 u128 再相乘，正整数相除即向下取整。
    // Widen both u64 values before multiplication. Dividing positive integers rounds down.
    let shares = u128::from(assets_in) * u128::from(total_shares) / u128::from(accounted_assets);
    let shares = u64::try_from(shares).map_err(|_| error!(LendingError::SupplyOverflow))?;
    require!(shares > 0, LendingError::ZeroSupplyShares);
    Ok(shares)
}

/// 转入借款资产并更新该钱包和市场的出借份额。
/// Transfer debt assets and update the supplying wallet and market share balances.
///
/// `context` 提供确定的市场和签名出借账户。 `assets_in` 与 `min_shares_out` 都以六位精度最小单位计，且必须为正。
/// `context` binds the market and signing supplier. `assets_in` and `min_shares_out` are positive six-decimal base-unit quantities.
/// 任何账户条件、报价或 SPL 转账失败时，仓位、池记账和代币余额保持原样。
/// A failed account constraint, quote, or SPL transfer leaves positions, accounting, and token balances unmodified.
pub(crate) fn handle(context: Context<Supply>, assets_in: u64, min_shares_out: u64) -> Result<()> {
    require!(assets_in > 0, LendingError::InvalidSupplyAmount);
    require!(min_shares_out > 0, LendingError::InvalidMinimumSupplyShares);

    // 报价读取池的已记账资产。直接转入的额外现金余额不会增加可发行份额的定价基数。
    // Quote from recorded assets. Extra cash sent directly to custody does not change the share pricing base.
    let pool_info = context.accounts.supply_pool.to_account_info();
    let mut indexed = interest::read_pool(&pool_info)?;
    let accounted_assets = if let Some(pool) = indexed {
        require!(
            pool.cash <= context.accounts.cash_vault.amount,
            LendingError::InvalidSupplyAccounting
        );
        pool.project(Clock::get()?.unix_timestamp)?.assets
    } else {
        context.accounts.supply_pool.accounted_assets_raw
    };
    let total_shares = context.accounts.supply_pool.total_shares_raw;
    let position_shares = context.accounts.supply_position.shares_raw;
    // 记账资产仍包括未偿本金。资金池的现金流出由借款指令校验总账和流动性。
    // Recorded assets still include outstanding principal. The borrow instruction validates ledger balances and liquidity before custody releases cash.
    require!(
        position_shares <= total_shares,
        LendingError::InvalidSupplyAccounting
    );
    // 实际新增的份额最小单位数，不能低于出借者签名时写入的下限。
    // Actual shares in base units, which must meet the supplier's signed minimum.
    let shares_out = calculate_shares(assets_in, accounted_assets, total_shares)?;
    require!(
        shares_out >= min_shares_out,
        LendingError::MinimumSupplySharesNotMet
    );
    require!(
        context.accounts.source.amount >= assets_in,
        LendingError::InsufficientSupplyBalance
    );

    // 先计算三个记账结果，任何越界都应在转账前停止。
    // Compute all three balances before any transfer so range overflow rejects the operation first.
    let new_accounted_assets = accounted_assets
        .checked_add(assets_in)
        .ok_or(LendingError::SupplyOverflow)?;
    // 新供应只增加已登记现金，不改变归一化债务。
    // Supply adds recorded cash without changing normalized debt.
    if let Some(pool) = indexed.as_mut() {
        pool.cash = pool
            .cash
            .checked_add(assets_in)
            .ok_or(LendingError::SupplyOverflow)?;
    }
    let new_total_shares = total_shares
        .checked_add(shares_out)
        .ok_or(LendingError::SupplyOverflow)?;
    let new_position_shares = position_shares
        .checked_add(shares_out)
        .ok_or(LendingError::SupplyOverflow)?;

    // 只有真实的 SPL 转账成功后才把新份额记入账户。
    // Post new balances only after the SPL transfer succeeds.
    token::transfer_checked(
        CpiContext::new(
            context.accounts.token_program.key(),
            TransferChecked {
                from: context.accounts.source.to_account_info(),
                mint: context.accounts.debt_mint.to_account_info(),
                to: context.accounts.cash_vault.to_account_info(),
                authority: context.accounts.supplier.to_account_info(),
            },
        ),
        assets_in,
        context.accounts.debt_mint.decimals,
    )?;

    // 两个 PDA 的规范种子已强制绑定市场和钱包。重复出借使用原份额累加。
    // Canonical seeds already bind both PDAs to their market and wallet. Repeat supply adds to existing shares.
    let market = context.accounts.market.key();
    let supplier = context.accounts.supplier.key();
    if let Some(pool) = indexed {
        interest::store_pool(&pool_info, pool)?;
    }
    context.accounts.supply_pool.set_inner(SupplyPool {
        market,
        accounted_assets_raw: new_accounted_assets,
        total_shares_raw: new_total_shares,
    });
    context.accounts.supply_position.set_inner(SupplyPosition {
        market,
        supplier,
        shares_raw: new_position_shares,
    });

    emit!(LendingSupply {
        market,
        supplier,
        debt_mint: context.accounts.debt_mint.key(),
        assets_in,
        shares_out,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::calculate_shares;

    /// 在已经形成非一比一比率时，检查向下舍入和整数边界。
    /// Verify flooring and integer boundaries for an established non-parity share ratio.
    #[test]
    fn quotes_floor_fractional_shares_and_checks_limits() {
        // 两个资产最小单位按 3/5 定价，应记一份而不是把 1.2 向上舍入。
        // Two asset units at a 3/5 ratio produce one share. Do not round 1.2 up.
        assert_eq!(calculate_shares(2, 5, 3).unwrap(), 1);
        assert!(calculate_shares(1, 5, 3).is_err());
        assert!(calculate_shares(1, 0, 3).is_err());
        assert_eq!(
            calculate_shares(u64::MAX, u64::MAX, u64::MAX).unwrap(),
            u64::MAX
        );
        assert!(calculate_shares(u64::MAX, 1, u64::MAX).is_err());
    }
}

//! 出借份额提取的账户约束、报价与原子结算。
//! Account constraints, pricing, and atomic settlement for supply withdrawals.

use anchor_lang::{prelude::*, system_program};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use super::debt::available_accounted_cash;
use super::interest;
use crate::{
    state::{
        BORROW_MARKET_SEED, CASH_VAULT_SEED, MARKET_SEED, SUPPLY_POOL_SEED, SUPPLY_POSITION_SEED,
    },
    BorrowMarket, LendingError, LendingMarket, SupplyPool, SupplyPosition,
};

/// 销减签名人的出借份额并将借款代币退回其钱包所需的账户。
/// Accounts for debiting the signer's supply shares and returning debt tokens to their wallet.
#[derive(Accounts)]
pub struct WithdrawSupply<'info> {
    /// 持有出借份额、授权本次提取并接收代币的签名钱包。
    /// Signing wallet that owns the shares, authorizes withdrawal, and receives the tokens.
    pub supplier: Signer<'info>,

    /// 绑定借款 Mint 和现金托管，并在转账时为托管签名的规范市场 PDA。
    /// Canonical market PDA binding the debt mint and cash custody and signing the transfer.
    #[account(seeds = [MARKET_SEED], bump = market.bump, has_one = debt_mint, has_one = cash_vault)]
    pub market: Account<'info, LendingMarket>,

    /// 市场绑定的六位小数借款 Mint，提供转账精度。
    /// Market-bound six-decimal debt mint providing the transfer precision.
    pub debt_mint: Account<'info, Mint>,

    /// 本次支付的规范托管账户，钱包不能直接授权处分其现金。
    /// Canonical custody paying this withdrawal, controlled by the market rather than the wallet.
    #[account(
        mut,
        seeds = [CASH_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = debt_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub cash_vault: Account<'info, TokenAccount>,

    /// 签名人持有的同 Mint 收款账户，与资金池托管地址分离。
    /// Matching-mint token account owned by the signer and distinct from pool custody.
    #[account(
        mut,
        constraint = destination.key() != cash_vault.key() @ LendingError::InvalidSupplyWithdrawalDestination,
        token::mint = debt_mint,
        token::authority = supplier,
        token::token_program = token_program,
    )]
    pub destination: Account<'info, TokenAccount>,

    /// 记录本市场已记账资产和总出借份额的规范池账本。
    /// Canonical pool ledger of accounted assets and total supply shares for this market.
    #[account(
        mut,
        seeds = [SUPPLY_POOL_SEED, market.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidSupplyAccounting,
    )]
    pub supply_pool: Account<'info, SupplyPool>,

    /// 已有签名人仓位，核对种子与已存的市场及出借人身份。
    /// Existing supplier position verified against its seeds and stored market and supplier.
    #[account(
        mut,
        seeds = [SUPPLY_POSITION_SEED, market.key().as_ref(), supplier.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidSupplyAccounting,
        has_one = supplier @ LendingError::InvalidSupplyAccounting,
    )]
    pub supply_position: Account<'info, SupplyPosition>,

    /// CHECK: 必须传入规范借款总账 PDA。处理函数区分未初始化的空账户与已经建立的总账，并验证程序归属、布局和市场。
    /// Pass the canonical debt ledger PDA. The handler recognizes an uninitialized account and otherwise verifies program ownership, layout, and market.
    #[account(seeds = [BORROW_MARKET_SEED, market.key().as_ref()], bump)]
    pub borrow_market: UncheckedAccount<'info>,

    /// 核对 Mint 精度并执行托管出账的经典 SPL Token 程序。
    /// Classic SPL Token program for decimal-checked custody payouts.
    pub token_program: Program<'info, Token>,
}

/// 提取成功后发出的份额与现金变动，供交易回执和活动索引使用。
/// Successful share and cash changes used by transaction receipts and activity indexing.
#[event]
pub struct LendingSupplyWithdrawal {
    /// 本次提取所属的市场 PDA 公钥。
    /// Public key of the market PDA for this withdrawal.
    pub market: Pubkey,

    /// 签名出借者的公钥。
    /// Public key of the signing supplier.
    pub supplier: Pubkey,

    /// 实际支付的借款资产的 SPL Mint 公钥。
    /// SPL mint public key of the debt asset paid out.
    pub debt_mint: Pubkey,

    /// 本次扣减的六位小数出借份额最小单位数量。
    /// Six-decimal supply share base units debited by this withdrawal.
    pub shares_burned_raw: u64,

    /// 实际转回钱包的借款代币最小单位数量。
    /// Debt token base units actually sent back to the wallet.
    pub amount_out_raw: u64,

    /// 取回后该签名人仍持有的六位小数出借份额最小单位数量。
    /// Six-decimal supply share base units held by the signer after withdrawal.
    pub remaining_shares_raw: u64,
}

/// 从规范借款总账读取全池未偿本金，金额为借款 Mint 最小单位。
/// Read the market's outstanding principal in debt mint base units from its canonical debt ledger.
///
/// `account` 已由账户约束绑定到 `market` 的借款账本；首笔借款前其空白状态表示零本金。
/// The account constraint derives `account` from `market`. Before the first loan, an empty ledger means zero principal.
/// 其他程序持有的账户、错误布局或市场绑定都视为记账无效。
/// Reject foreign-owned accounts and mismatched layouts or markets as invalid accounting.
fn outstanding_principal(account: &UncheckedAccount, market: Pubkey) -> Result<u64> {
    if account.owner == &system_program::ID && account.data_is_empty() {
        return Ok(0);
    }

    require_keys_eq!(
        *account.owner,
        crate::ID,
        LendingError::InvalidBorrowAccounting
    );

    // 只有本程序拥有且能解码的规范账本才可以决定未偿本金。
    // Only a canonical ledger owned by this program and decodable can determine outstanding principal.
    let data = account.try_borrow_data()?;
    let ledger = BorrowMarket::try_deserialize(&mut &data[..])
        .map_err(|_| error!(LendingError::InvalidBorrowAccounting))?;
    require_keys_eq!(ledger.market, market, LendingError::InvalidBorrowAccounting);
    Ok(ledger.total_debt_raw)
}

/// 用操作前的份额与已记账资产计算提取的代币数量，余数留在池内。
/// Price the payout from pre-withdrawal shares and accounted assets, leaving any fractional remainder in the pool.
///
/// `shares_raw` 与 `total_shares` 使用出借份额最小单位，`accounted_assets` 使用借款 Mint 最小单位。
/// `shares_raw` and `total_shares` use share base units, while `accounted_assets` uses debt mint base units.
/// 空池、记账不一致或舍入后无到账代币时拒绝。
/// Reject an empty or inconsistent ledger and any payout that rounds down to zero.
fn calculate_payout(shares_raw: u64, total_shares: u64, accounted_assets: u64) -> Result<u64> {
    require!(
        accounted_assets > 0 && total_shares > 0 && shares_raw <= total_shares,
        LendingError::InvalidSupplyAccounting
    );

    // 两个 u64 先转为 u128 再相乘，最后按借款 Mint 最小单位向下取整。
    // Widen both u64 inputs before multiplication and floor the result in debt mint base units.
    let amount = u128::from(shares_raw) * u128::from(accounted_assets) / u128::from(total_shares);
    let amount = u64::try_from(amount).map_err(|_| error!(LendingError::SupplyOverflow))?;
    require!(amount > 0, LendingError::ZeroSupplyWithdrawalAssets);
    Ok(amount)
}

/// 确认份额、最低到账与可用现金，再由市场签名支付并扣减份额。
/// Verify shares, minimum payout, and available cash before signing the payout and debiting shares.
///
/// `context` 绑定市场、已存在的出借仓位和签名人的收款账户。两项输入必须为正。
/// `context` binds the market, existing position, and signer's destination. Both inputs must be positive.
/// `shares_raw` 使用份额最小单位，`min_amount_out_raw` 使用借款 Mint 最小单位。失败时不改变任何余额。
/// `shares_raw` uses share base units and `min_amount_out_raw` uses debt mint base units. Failure preserves all balances.
pub(crate) fn handle(
    context: Context<WithdrawSupply>,
    shares_raw: u64,
    min_amount_out_raw: u64,
) -> Result<()> {
    require!(shares_raw > 0, LendingError::InvalidSupplyWithdrawalShares);
    let accounts = context.accounts;
    let market = accounts.market.key();
    let pool = &mut accounts.supply_pool;
    let position = &mut accounts.supply_position;
    require!(
        position.shares_raw <= pool.total_shares_raw,
        LendingError::InvalidSupplyAccounting
    );

    // 按签名人实际份额扣减，不能动用其他出借人的份额。
    // Debit only the signing supplier's shares, leaving other suppliers' positions untouched.
    let remaining_shares_raw = position
        .shares_raw
        .checked_sub(shares_raw)
        .ok_or(LendingError::InsufficientSupplyShares)?;
    // 已计息债务参与份额定价，但真正可付金额受登记现金和托管限制。
    // Indexed debt contributes to share value, while payouts remain limited by recorded and physical cash.
    let pool_info = pool.to_account_info();
    let mut indexed = interest::read_pool(&pool_info)?;
    let (assets_before, available) = if let Some(state) = indexed {
        require!(
            state.cash <= accounts.cash_vault.amount,
            LendingError::InvalidSupplyAccounting
        );
        (
            state.project(Clock::get()?.unix_timestamp)?.assets,
            state.cash,
        )
    } else {
        let principal = outstanding_principal(&accounts.borrow_market, market)?;
        (
            pool.accounted_assets_raw,
            available_accounted_cash(
                pool.accounted_assets_raw,
                accounts.cash_vault.amount,
                principal,
            )?,
        )
    };
    // 全部放弃已无现金价值的仓位无需支付。正值仓位始终要求正的签名下限。
    // Abandoning an entire worthless position moves no cash. Positive-valued positions still require a positive signed minimum.
    if min_amount_out_raw == 0 {
        require!(
            remaining_shares_raw == 0
                && u128::from(shares_raw) * u128::from(assets_before)
                    < u128::from(pool.total_shares_raw),
            LendingError::InvalidMinimumSupplyWithdrawal
        );
        pool.accounted_assets_raw = assets_before;
        pool.total_shares_raw -= shares_raw;
        position.shares_raw = 0;
        return Ok(());
    }
    let amount_out_raw = calculate_payout(shares_raw, pool.total_shares_raw, assets_before)?;
    require!(
        amount_out_raw >= min_amount_out_raw,
        LendingError::MinimumSupplyWithdrawalNotMet
    );
    require!(
        amount_out_raw <= available,
        LendingError::InsufficientSupplyWithdrawalLiquidity
    );

    // 资产与总份额的扣减均已受上面的账户余额和报价约束。
    // The checked share balances and payout limits bound both pool debits.
    let assets_after = assets_before - amount_out_raw;
    let total_shares_after = pool.total_shares_raw - shares_raw;
    if let Some(state) = indexed.as_mut() {
        state.cash -= amount_out_raw;
    }

    // 使用原市场种子和 bump 为托管授权，SPL 转账失败时整笔交易回滚。
    // Use the existing market seeds and bump to authorize custody. An SPL transfer failure rolls back the full transaction.
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
        amount_out_raw,
        accounts.debt_mint.decimals,
    )?;

    // 转账成功后写回三处记账值，空仓保留原 PDA 以便该钱包再次出借。
    // Record all three balances after transfer success, keeping the existing PDA for the wallet to supply again.
    if let Some(state) = indexed {
        interest::store_pool(&pool_info, state)?;
    }
    pool.accounted_assets_raw = assets_after;
    pool.total_shares_raw = total_shares_after;
    position.shares_raw = remaining_shares_raw;

    emit!(LendingSupplyWithdrawal {
        market,
        supplier: accounts.supplier.key(),
        debt_mint: accounts.debt_mint.key(),
        shares_burned_raw: shares_raw,
        amount_out_raw,
        remaining_shares_raw,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::calculate_payout;

    /// 验证非一比一份额的向下取整、全部出金、不足一个代币单位和 u64 边界。
    /// Verify non-parity flooring, full payout, dust rejection, and u64 boundaries.
    #[test]
    fn prices_withdrawal_by_exact_pre_operation_share_ratio() {
        assert_eq!(calculate_payout(1, 3, 5).unwrap(), 1);
        assert_eq!(calculate_payout(3, 3, 5).unwrap(), 5);
        assert!(calculate_payout(1, 2, 1).is_err());
        assert!(calculate_payout(1, 0, 5).is_err());
        assert!(calculate_payout(4, 3, 5).is_err());
        assert_eq!(
            calculate_payout(u64::MAX, u64::MAX, u64::MAX).unwrap(),
            u64::MAX
        );
    }
}

//! 可选固定点计息，兼容已有零息市场布局。
//! Optional fixed-point interest with compatibility for existing principal-only markets.

use anchor_lang::{prelude::*, system_program};
use anchor_spl::token::TokenAccount;

use crate::{
    state::{BORROW_MARKET_SEED, MARKET_SEED, SUPPLY_POOL_SEED},
    BorrowMarket, BorrowPosition, LendingError, LendingMarket, SupplyPool,
};

/// 原供给池长度与新增计息尾部长度（字节）。
/// Original supply pool length and length including its interest trailer, in bytes.
const POOL_LEGACY_LEN: usize = 8 + SupplyPool::INIT_SPACE;
const POOL_INTEREST_LEN: usize = POOL_LEGACY_LEN + 8 + 8 + 16;
/// 原借款仓位长度与新增计息尾部长度（字节）。
/// Original borrow position length and length including its interest trailer, in bytes.
const POSITION_LEGACY_LEN: usize = 8 + BorrowPosition::INIT_SPACE;
const POSITION_INTEREST_LEN: usize = POSITION_LEGACY_LEN + 8 + 16;

/// 利率倍率精度，10% 年名义利率按每分钟更新。每年按 365 天计算。
/// Fixed-point rate scale. A 10% nominal APR compounds by whole minute, using a 365-day year.
const INDEX_SCALE: u128 = 1_000_000_000_000;
const MINUTE_FACTOR: u128 = INDEX_SCALE + INDEX_SCALE / (10 * 365 * 24 * 60);
const DEBT_DENOMINATOR: u128 = INDEX_SCALE * 1_000_000;

/// 保存在供给池尾部的激活时间、已登记现金及所有借款人归一化余额。
/// Pool trailer with activation timestamp, recorded cash and aggregate normalized debt.
#[derive(Clone, Copy)]
pub(crate) struct PoolInterest {
    /// 启用时的链上 Unix 秒。 On-chain Unix seconds at activation.
    pub(crate) start: i64,
    /// 资金池登记的已付款现金最小单位。 Recorded cash in debt mint base units.
    pub(crate) cash: u64,
    /// 全池归一化债务份额。 Aggregate normalized debt shares.
    pub(crate) shares: u128,
}

/// 保存在每个借款仓位尾部的激活时间和归一化债务余额。
/// Activation timestamp and normalized debt shares in a borrow position trailer.
#[derive(Clone, Copy)]
pub(crate) struct PositionInterest {
    /// 与目前市场激活时间相同的 Unix 秒。 Unix seconds matching market activation.
    pub(crate) start: i64,
    /// 该借款人归一化债务份额。 The borrower's normalized debt shares.
    pub(crate) shares: u128,
}

/// 按同一时刻算出的全池账面债务、出借资产和借款指数。
/// Same-time aggregate debt, supply assets, and debt index.
#[derive(Clone, Copy)]
pub(crate) struct Projection {
    /// 当前归一化债务的固定点倍率。 Current fixed-point multiplier for normalized debt.
    pub(crate) index: u128,
    /// 池内计息债务最小单位数。 Indexed aggregate debt in debt mint base units.
    pub(crate) debt: u64,
    /// 登记现金与全部计息债务之和。 Sum of registered cash and all indexed debt.
    pub(crate) assets: u64,
}

/// 原管理员启用零旧债务市场的固定利率。已出借份额沿用原余额。
/// The original market administrator enables fixed interest when legacy debt is zero. Existing supply shares stay unchanged.
#[derive(Accounts)]
pub struct EnableInterest<'info> {
    /// 签名管理员为池账本增加免租余额。 The signing administrator funds the larger ledger's rent exemption.
    #[account(mut)]
    pub administrator: Signer<'info>,
    /// 绑定已登记管理员和现金托管的规范市场。 Canonical market binding its administrator and cash custody.
    #[account(seeds = [MARKET_SEED], bump = market.bump, has_one = administrator, has_one = cash_vault)]
    pub market: Account<'info, LendingMarket>,
    /// 已初始化的池账本保留原有余额和份额，扩充数据用于计息。
    /// The initialized supply pool keeps its assets and shares and expands to store interest accounting.
    #[account(
        mut, seeds = [SUPPLY_POOL_SEED, market.key().as_ref()], bump, has_one = market,
        realloc = POOL_INTEREST_LEN, realloc::payer = administrator, realloc::zero = true
    )]
    pub supply_pool: Account<'info, SupplyPool>,
    /// CHECK: 规范借款账本 PDA，无借款时可以为空。处理函数验证已初始化账本布局并要求未偿余额为零。
    /// Canonical debt ledger PDA. It can be absent before a loan. The handler validates any initialized ledger and requires zero outstanding debt.
    #[account(seeds = [BORROW_MARKET_SEED, market.key().as_ref()], bump)]
    pub borrow_market: UncheckedAccount<'info>,
    /// 已绑定市场和借款 Mint 的现金托管账户。 Canonical cash custody for the market and its debt mint.
    #[account(constraint = cash_vault.owner == market.key(), constraint = cash_vault.mint == market.debt_mint)]
    pub cash_vault: Account<'info, TokenAccount>,
    /// 调整账本数据大小时支付用于免租差额。 Used to fund the rent difference for the larger ledger.
    pub system_program: Program<'info, System>,
}

/// 只有在旧账本债务归零时开始计息，避免转换借款人债务的精度。
/// Start interest only after legacy debt is fully repaid, avoiding loss of precision when converting old positions.
pub(crate) fn enable(context: Context<EnableInterest>) -> Result<()> {
    let accounts = context.accounts;
    let pool = accounts.supply_pool.to_account_info();
    let ledger = accounts.borrow_market.to_account_info();
    // 多次启用会重置归一化余额，必须拒绝。 A second activation could reset normalized debt and must fail.
    {
        let data = pool.try_borrow_data()?;
        require!(
            data[POOL_LEGACY_LEN..].iter().all(|byte| *byte == 0),
            LendingError::InterestAlreadyEnabled
        );
    }
    if !(ledger.owner == &system_program::ID && ledger.data_is_empty()) {
        require_keys_eq!(
            *ledger.owner,
            crate::ID,
            LendingError::InvalidInterestAccounting
        );
        let data = ledger.try_borrow_data()?;
        let debt = BorrowMarket::try_deserialize(&mut &data[..])?;
        require_keys_eq!(
            debt.market,
            accounts.market.key(),
            LendingError::InvalidInterestAccounting
        );
        require_eq!(debt.total_debt_raw, 0, LendingError::LegacyDebtOutstanding);
    }
    let cash = accounts.supply_pool.accounted_assets_raw;
    let start = Clock::get()?.unix_timestamp;
    require!(
        start > 0 && cash <= accounts.cash_vault.amount,
        LendingError::InvalidInterestAccounting
    );
    store_pool(
        &pool,
        PoolInterest {
            start,
            cash,
            shares: 0,
        },
    )
}

/// 保持已有活跃池的长度，未创建的池仍采用原布局。
/// Accept the existing interest trailer without changing the allocation for an uninitialized pool.
pub(crate) fn supply_pool_space(existing_len: usize) -> usize {
    if existing_len == POOL_INTEREST_LEN {
        POOL_INTEREST_LEN
    } else {
        POOL_LEGACY_LEN
    }
}

/// 已启用的借款人仓位保留计息尾部，未创建的仓位使用原长度。
/// Preserve the interest trailer of an active borrower. Use the original size for a new borrower.
pub(crate) fn borrow_position_space(existing_len: usize) -> usize {
    if existing_len == POSITION_INTEREST_LEN {
        POSITION_INTEREST_LEN
    } else {
        POSITION_LEGACY_LEN
    }
}

/// 读取借贷程序持有的规范池布局，原布局表示仍未启用。
/// Decode the canonical program-owned pool. Its original size indicates principal-only accounting.
pub(crate) fn read_pool(info: &AccountInfo) -> Result<Option<PoolInterest>> {
    require_keys_eq!(
        *info.owner,
        crate::ID,
        LendingError::InvalidInterestAccounting
    );
    let data = info.try_borrow_data()?;
    if data.len() == POOL_LEGACY_LEN {
        return Ok(None);
    }
    require_eq!(
        data.len(),
        POOL_INTEREST_LEN,
        LendingError::InvalidInterestAccounting
    );
    let suffix = &data[POOL_LEGACY_LEN..];
    let start = i64::from_le_bytes(suffix[..8].try_into().unwrap());
    require!(start > 0, LendingError::InvalidInterestAccounting);
    Ok(Some(PoolInterest {
        start,
        cash: u64::from_le_bytes(suffix[8..16].try_into().unwrap()),
        shares: u128::from_le_bytes(suffix[16..].try_into().unwrap()),
    }))
}

/// 读取借款人当前的归一化余额；未扩展的仓位没有计息份额。
/// Decode borrower normalized debt shares. Unextended positions have no indexed debt.
pub(crate) fn read_position(info: &AccountInfo) -> Result<Option<PositionInterest>> {
    require_keys_eq!(
        *info.owner,
        crate::ID,
        LendingError::InvalidInterestAccounting
    );
    let data = info.try_borrow_data()?;
    if data.len() == POSITION_LEGACY_LEN {
        return Ok(None);
    }
    require_eq!(
        data.len(),
        POSITION_INTEREST_LEN,
        LendingError::InvalidInterestAccounting
    );
    let suffix = &data[POSITION_LEGACY_LEN..];
    let start = i64::from_le_bytes(suffix[..8].try_into().unwrap());
    require!(start > 0, LendingError::InvalidInterestAccounting);
    Ok(Some(PositionInterest {
        start,
        shares: u128::from_le_bytes(suffix[8..].try_into().unwrap()),
    }))
}

/// 首次计息借款由借款人补足免租余额，原字段与 PDA 都不改变。
/// Fund rent on the first indexed borrow without changing existing fields or the PDA.
pub(crate) fn extend_position<'info>(
    position: &AccountInfo<'info>,
    payer: &Signer<'info>,
    system: &Program<'info, System>,
) -> Result<()> {
    require_eq!(
        position.data_len(),
        POSITION_LEGACY_LEN,
        LendingError::InvalidInterestAccounting
    );
    let due = Rent::get()?
        .minimum_balance(POSITION_INTEREST_LEN)
        .saturating_sub(position.lamports());
    if due > 0 {
        system_program::transfer(
            CpiContext::new(
                system.key(),
                system_program::Transfer {
                    from: payer.to_account_info(),
                    to: position.clone(),
                },
            ),
            due,
        )?;
    }
    position.resize(POSITION_INTEREST_LEN)?;
    Ok(())
}

/// 仅改写池的计息尾部，Anchor 账户退出独立写回旧字段。
/// Write only the pool's trailer. Anchor independently serializes original fields on exit.
pub(crate) fn store_pool(info: &AccountInfo, pool: PoolInterest) -> Result<()> {
    require!(info.is_writable, LendingError::InterestAccountsRequired);
    let mut bytes = info.try_borrow_mut_data()?;
    require_eq!(
        bytes.len(),
        POOL_INTEREST_LEN,
        LendingError::InvalidInterestAccounting
    );
    let suffix = &mut bytes[POOL_LEGACY_LEN..];
    suffix[..8].copy_from_slice(&pool.start.to_le_bytes());
    suffix[8..16].copy_from_slice(&pool.cash.to_le_bytes());
    suffix[16..].copy_from_slice(&pool.shares.to_le_bytes());
    Ok(())
}

/// 单独写入未通过 Anchor 可写状态退出的出借池，同时刷新旧版账面资产字段。
/// Update a pool outside Anchor's writable exit and refresh its legacy book-asset field.
pub(crate) fn store_projected_pool(
    info: &AccountInfo,
    pool: PoolInterest,
    assets: u64,
) -> Result<()> {
    store_pool(info, pool)?;
    // 八字节 discriminator 后是三十二字节市场公钥。
    // The eight-byte discriminator is followed by the 32-byte market key.
    let mut bytes = info.try_borrow_mut_data()?;
    bytes[40..48].copy_from_slice(&assets.to_le_bytes());
    Ok(())
}

/// 保存借款人尾部余额，允许原 Anchor 状态与事件独立记录整数快照。
/// Persist the borrower's trailer, leaving the original Anchor state and event free to record rounded snapshots.
pub(crate) fn store_position(info: &AccountInfo, position: PositionInterest) -> Result<()> {
    require!(info.is_writable, LendingError::InterestAccountsRequired);
    let mut bytes = info.try_borrow_mut_data()?;
    require_eq!(
        bytes.len(),
        POSITION_INTEREST_LEN,
        LendingError::InvalidInterestAccounting
    );
    let suffix = &mut bytes[POSITION_LEGACY_LEN..];
    suffix[..8].copy_from_slice(&position.start.to_le_bytes());
    suffix[8..].copy_from_slice(&position.shares.to_le_bytes());
    Ok(())
}

/// 使用整数平方乘法计算固定点指数，经过的不足整分钟的时间暂不计息。
/// Compute the fixed-point index by integer exponentiation by squaring. A partial minute has no accrued interest.
fn current_index(start: i64, now: i64) -> Result<u128> {
    require!(start > 0, LendingError::InvalidInterestAccounting);
    let mut elapsed_minutes = u64::try_from(now.saturating_sub(start).max(0) / 60)
        .map_err(|_| error!(LendingError::BorrowOverflow))?;
    let mut factor = MINUTE_FACTOR;
    let mut index = INDEX_SCALE;
    while elapsed_minutes != 0 {
        if elapsed_minutes & 1 != 0 {
            index = index
                .checked_mul(factor)
                .ok_or(LendingError::BorrowOverflow)?
                / INDEX_SCALE;
        }
        elapsed_minutes >>= 1;
        if elapsed_minutes != 0 {
            factor = factor
                .checked_mul(factor)
                .ok_or(LendingError::BorrowOverflow)?
                / INDEX_SCALE;
        }
    }
    Ok(index)
}

/// 计算向上取整的债务最小单位，保持全额还款可兑换为精确现金。
/// Round debt up into base units so a full repayment can settle into exact cash.
pub(crate) fn debt_due(shares: u128, index: u128) -> Result<u64> {
    // 先除整份再乘，降低大额账户中间乘积溢出的风险。
    // Split whole units first to reduce intermediate overflow for large accounts.
    let whole = (shares / DEBT_DENOMINATOR)
        .checked_mul(index)
        .ok_or(LendingError::BorrowOverflow)?;
    let remainder = (shares % DEBT_DENOMINATOR)
        .checked_mul(index)
        .ok_or(LendingError::BorrowOverflow)?;
    let amount = whole
        .checked_add(remainder.div_ceil(DEBT_DENOMINATOR))
        .ok_or(LendingError::BorrowOverflow)?;
    u64::try_from(amount).map_err(|_| error!(LendingError::BorrowOverflow))
}

/// 读取借款人当前可执行债务，未启用计息时使用原账面本金。
/// Read the borrower's currently executable debt, using the original principal before interest is enabled.
pub fn project_position_debt(info: &AccountInfo, principal: u64, now: i64) -> Result<u64> {
    match read_position(info)? {
        Some(position) => debt_due(position.shares, current_index(position.start, now)?),
        None => Ok(principal),
    }
}

/// 按结算时间投射池内贷款价值，出借份额定价使用与借款相同的指数。
/// Project lending book value at settlement using the same index as borrowing.
impl PoolInterest {
    /// 给定链上 Unix 秒返回同刻债务、资产与指数。 Project debt, assets and index at the given on-chain Unix second.
    pub(crate) fn project(self, now: i64) -> Result<Projection> {
        let index = current_index(self.start, now)?;
        let debt = debt_due(self.shares, index)?;
        let assets = self
            .cash
            .checked_add(debt)
            .ok_or(LendingError::SupplyOverflow)?;
        Ok(Projection {
            index,
            debt,
            assets,
        })
    }
}

/// 供金库估值或其他 CPI 调用者读取池当前净资产，不要求等待下次借还款。
/// Project live pool assets for vault valuation and other CPI consumers without waiting for the next borrow or repayment.
pub fn project_pool_assets(info: &AccountInfo, legacy_assets: u64, now: i64) -> Result<u64> {
    match read_pool(info)? {
        Some(pool) => Ok(pool.project(now)?.assets),
        None => Ok(legacy_assets),
    }
}

/// 返回启用计息后的登记现金；旧池继续从原账面资产与本金推导。
/// Return recorded cash for an indexed pool. Legacy pools continue deriving it from assets minus principal.
pub fn project_pool_cash(info: &AccountInfo) -> Result<Option<u64>> {
    Ok(read_pool(info)?.map(|pool| pool.cash))
}

/// 新借款的归一化余额向上舍入，防止池资产少记实际出账。
/// Round new normalized debt up so accounting never understates a cash disbursement.
pub(crate) fn normalize_borrow(amount: u64, index: u128) -> u128 {
    (u128::from(amount) * DEBT_DENOMINATOR).div_ceil(index)
}

/// 已计息还款的实际现金额和所清偿归一化份额，由同一市场整数债务差决定。
/// Actual cash payment and normalized shares settled, determined by the same aggregate integer debt reduction.
#[derive(Clone, Copy)]
pub(crate) struct DebtPayment {
    /// 应从签名钱包实际扣除的借款代币最小单位。 Debt token base units to debit from the signer.
    pub(crate) amount: u64,
    /// 全池与借款人份额同时减少的归一化值。 Normalized shares to remove from both market and borrower.
    pub(crate) shares: u128,
}

/// 取不超过授权资金的最大可清偿份额，现金额严格等于全池债务减少量。
/// Settle the greatest normalized share count within the signed maximum. Actual cash equals the decrease in market debt.
pub(crate) fn debt_payment(
    pool: PoolInterest,
    position: PositionInterest,
    projection: Projection,
    maximum: u64,
) -> Result<DebtPayment> {
    require!(
        position.start == pool.start && position.shares <= pool.shares,
        LendingError::InvalidInterestAccounting
    );
    if maximum == 0 || position.shares == 0 {
        return Ok(DebtPayment {
            amount: 0,
            shares: 0,
        });
    }
    let target = projection.debt.saturating_sub(maximum);
    // ceil(remaining * index / D) >= target 对应最少剩余 (target - 1) * D / index + 1。
    // ceil(remaining * index / D) >= target implies a minimum remainder of (target - 1) * D / index + 1.
    let required = if target == 0 {
        0
    } else {
        u128::from(target - 1) * DEBT_DENOMINATOR / projection.index + 1
    };
    let shares = pool.shares.saturating_sub(required).min(position.shares);
    let amount = projection.debt - debt_due(pool.shares - shares, projection.index)?;
    // 单笔极小尾债的向上取整为一最小单位，即使它消失不引起聚合余额舍入变化。
    // A tiny position can round up to one base unit individually while its removal leaves aggregate rounding unchanged.
    if amount == 0 && shares == position.shares {
        return Ok(DebtPayment { amount: 1, shares });
    }
    Ok(DebtPayment { amount, shares })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一时刻精确计价，跨分钟后应增加债务和出借资产，保留现金不变。
    /// Same-time debt settles at parity, subsequent minutes accrue debt and assets without changing cash.
    #[test]
    fn interest_raises_assets_without_adding_cash() {
        let start = 1_700_000_000;
        let mut pool = PoolInterest {
            start,
            cash: 90_000_000,
            shares: 0,
        };
        pool.shares = normalize_borrow(10_000_000, INDEX_SCALE);
        assert_eq!(pool.project(start).unwrap().assets, 100_000_000);
        let after = pool.project(start + 365 * 24 * 60 * 60).unwrap();
        assert!(after.debt > 11_000_000 && after.debt < 11_060_000);
        assert_eq!(after.assets - after.debt, pool.cash);
    }

    /// 几个借款人一起舍入时，实际还款不超授权，偿清后市场和钱包资产守恒。
    /// Combined rounding never exceeds the authorized payment. Full settlement preserves the pool's assets.
    #[test]
    fn payment_replaces_exact_projected_market_debt_with_cash() {
        let start = 1_700_000_000;
        let mut pool = PoolInterest {
            start,
            cash: 1,
            shares: 0,
        };
        let position = PositionInterest {
            start,
            shares: normalize_borrow(100_000, INDEX_SCALE),
        };
        pool.shares = position.shares + normalize_borrow(33_333, INDEX_SCALE);
        let now = start + 3_600;
        let before = pool.project(now).unwrap();
        let partial = debt_payment(pool, position, before, 3).unwrap();
        assert_eq!(partial.amount, 3);
        assert!(partial.shares < position.shares);
        let full = debt_payment(
            pool,
            position,
            before,
            debt_due(position.shares, before.index).unwrap(),
        )
        .unwrap();
        assert_eq!(full.shares, position.shares);
        pool.cash += full.amount;
        pool.shares -= full.shares;
        assert_eq!(pool.project(now).unwrap().assets, before.assets);
    }

    /// 完整清理仅按个人舍入出现的尾债，并尊重零授权。
    /// Fully settle debt dust that appears only in individual rounding, respecting zero authorization.
    #[test]
    fn tiny_tail_is_clearable() {
        let start = 1_700_000_000;
        let pool = PoolInterest {
            start,
            cash: 0,
            shares: 10,
        };
        let position = PositionInterest { start, shares: 2 };
        let before = pool.project(start).unwrap();
        assert_eq!(before.debt, 1);
        assert_eq!(debt_payment(pool, position, before, 0).unwrap().shares, 0);
        let payment = debt_payment(pool, position, before, 1).unwrap();
        assert_eq!((payment.amount, payment.shares), (1, 2));
    }
}

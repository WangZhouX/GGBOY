//! 第三方清算的账户约束、最小单位报价、结算与坏账处理。
//! Third-party liquidation account constraints, base-unit quotes, settlement, and write-offs.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use super::debt::available_accounted_cash;
use super::interest::{self, PoolInterest, PositionInterest};
use super::oracle::require_fresh_price;
use crate::{
    state::{
        BORROW_MARKET_SEED, BORROW_POSITION_SEED, CASH_VAULT_SEED, COLLATERAL_VAULT_SEED,
        MARKET_SEED, MOCK_COLLATERAL_PRICE_SEED, SUPPLY_POOL_SEED,
    },
    BorrowMarket, BorrowPosition, LendingError, LendingMarket, MockCollateralPrice, SupplyPool,
};

/// 原版 SPL 关联账户程序公钥，用于校验付款和到账地址。
/// Canonical associated token program used to verify payment and payout addresses.
const ASSOCIATED_TOKEN_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// 第三方偿债和领取抵押品需要的市场、仓位、托管及钱包账户。
/// Market, position, custody, and wallet accounts for third-party repayment and seizure.
#[derive(Accounts)]
pub struct Liquidate<'info> {
    /// 承担代偿并接收抵押品的签名人，须与仓位借款人不同。
    /// Signer funding the repayment and receiving collateral, distinct from the borrower.
    pub liquidator: Signer<'info>,

    /// 规范市场及其绑定的两种 Mint 和两个托管账户。
    /// Canonical market binding both mints and both custody accounts.
    #[account(
        seeds = [MARKET_SEED],
        bump = market.bump,
        has_one = debt_mint,
        has_one = collateral_mint,
        has_one = cash_vault,
        has_one = collateral_vault,
    )]
    pub market: Account<'info, LendingMarket>,

    /// 用于代偿的借款 Mint，转账核对其小数精度。
    /// Debt mint used for repayment, with decimals checked during transfer.
    pub debt_mint: Account<'info, Mint>,

    /// 用于领取的抵押 Mint，其小数精度也用于清算报价。
    /// Collateral mint paid out, with decimals also used for the liquidation quote.
    pub collateral_mint: Account<'info, Mint>,

    /// 市场 PDA 控制的独立借款现金托管。
    /// Separate debt-token cash custody under market PDA authority.
    #[account(
        mut,
        seeds = [CASH_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = debt_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub cash_vault: Box<Account<'info, TokenAccount>>,

    /// 市场 PDA 控制的独立抵押托管。
    /// Separate collateral custody under market PDA authority.
    #[account(
        mut,
        seeds = [COLLATERAL_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,

    /// 签名人持有的借款 Mint 关联账户，支付实际代偿额。
    /// Signer's debt mint ATA paying the actual repayment.
    #[account(
        mut,
        constraint = is_associated_token_account(
            liquidator_debt.key(), liquidator.key(), debt_mint.key(), token_program.key(),
        ) @ LendingError::InvalidLiquidatorTokenAccount,
        token::mint = debt_mint,
        token::authority = liquidator,
        token::token_program = token_program,
    )]
    pub liquidator_debt: Box<Account<'info, TokenAccount>>,

    /// 签名人持有的抵押 Mint 关联账户，接收实际扣划的数量。
    /// Signer's collateral mint ATA receiving the actual seized amount.
    #[account(
        mut,
        constraint = is_associated_token_account(
            liquidator_collateral.key(), liquidator.key(), collateral_mint.key(), token_program.key(),
        ) @ LendingError::InvalidLiquidatorTokenAccount,
        token::mint = collateral_mint,
        token::authority = liquidator,
        token::token_program = token_program,
    )]
    pub liquidator_collateral: Box<Account<'info, TokenAccount>>,

    /// 规范出借池，坏账冲减其记账资产，不修改已登记的份额。
    /// Canonical supply pool whose recorded assets absorb bad debt without changing shares.
    #[account(
        mut,
        seeds = [SUPPLY_POOL_SEED, market.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidSupplyAccounting,
    )]
    pub supply_pool: Account<'info, SupplyPool>,

    /// 规范市场借款总账，代偿与坏账共同减少未偿债务。
    /// Canonical debt ledger reduced by repayment and write-off.
    #[account(
        mut,
        seeds = [BORROW_MARKET_SEED, market.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidBorrowAccounting,
    )]
    pub borrow_market: Account<'info, BorrowMarket>,

    /// 使用仓位内已验证的借款人和所属市场检查规范 PDA，无需借款人签名。
    /// Canonical PDA derived from its stored borrower and verified market, without a borrower signature.
    #[account(
        mut,
        seeds = [BORROW_POSITION_SEED, market.key().as_ref(), borrow_position.borrower.as_ref()],
        bump,
        has_one = market @ LendingError::InvalidBorrowPosition,
        constraint = borrow_position.borrower != liquidator.key() @ LendingError::SelfLiquidation,
    )]
    pub borrow_position: Account<'info, BorrowPosition>,

    /// 市场自己的规范测试价格，处理函数还校验发布时间。
    /// Canonical test price for the same market, with publication time checked by the handler.
    #[account(
        seeds = [MOCK_COLLATERAL_PRICE_SEED, market.key().as_ref()],
        bump,
        has_one = market @ LendingError::InvalidMockPrice,
    )]
    pub mock_collateral_price: Account<'info, MockCollateralPrice>,

    /// 执行两条代币转账的原版 SPL Token 程序。
    /// Classic SPL Token program executing both token transfers.
    pub token_program: Program<'info, Token>,
}

/// 清算或坏账结算成功后产生的实际变动，供索引和回执读取。
/// Settled liquidation or write-off amounts for indexing and receipts.
#[event]
pub struct LendingLiquidation {
    /// 结算所在借贷市场公钥。 Lending market public key.
    pub market: Pubkey,
    /// 被清算的借款人公钥。 Borrower whose position was liquidated.
    pub borrower: Pubkey,
    /// 发起清算的签名钱包公钥。 Signing liquidator's public key.
    pub liquidator: Pubkey,
    /// 代偿资产 Mint 公钥。 Repayment asset mint.
    pub debt_mint: Pubkey,
    /// 扣划资产 Mint 公钥。 Seized collateral mint.
    pub collateral_mint: Pubkey,
    /// 清算人实际代偿额，按借款 Mint 最小单位计。 Actual repayment in debt mint base units.
    pub repaid_raw: u64,
    /// 清算人实际收取量，按抵押 Mint 最小单位计。 Actual seizure in collateral mint base units.
    pub seized_collateral_raw: u64,
    /// 已冲减出借池的坏账，按借款 Mint 最小单位计。 Written-off debt in debt mint base units.
    pub bad_debt_raw: u64,
}

/// 报价已计算两条转账和冲销金额，分别使用对应 SPL Mint 的最小单位。
/// The quote contains both token movements and the write-off in their respective mint base units.
struct Quote {
    /// 实际代偿和坏账，均以借款 Mint 最小单位计。 Repayment and write-off in debt mint base units.
    repaid_raw: u64,
    bad_debt_raw: u64,
    /// 实际扣划抵押，按抵押 Mint 最小单位计。 Seized collateral in collateral mint base units.
    seized_collateral_raw: u64,
}

/// 按钱包、Mint 与已约束的 SPL Token 程序验证关联代币账户地址。
/// Check the ATA address for the wallet, mint, and constrained SPL Token program.
fn is_associated_token_account(
    account: Pubkey,
    wallet: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
) -> bool {
    let (expected, _) = Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    );
    account == expected
}

/// 计算 4/5 或 20/21 比例的整数下限，先拆分商与余数以避免放大 u128 分子。
/// Floor a 4/5 or 20/21 ratio by splitting quotient and remainder before scaling a u128 numerator.
///
/// `weighted_collateral` 是抵押最小单位数量乘整单位价格；最终按抵押精度缩放到借款最小单位。
/// `weighted_collateral` is collateral base units times the whole-token price, then scaled to debt base units.
fn floor_weighted_ratio(
    weighted_collateral: u128,
    numerator: u128,
    denominator: u128,
    scale: u128,
) -> u128 {
    (weighted_collateral / denominator * numerator
        + weighted_collateral % denominator * numerator / denominator)
        / scale
}

/// 根据当前债务和抵押估出可结算金额。所有资产量均为各自 Mint 最小单位。
/// Quote a settlement for current debt and collateral, in each mint's base units.
///
/// 价格为整单位抵押品价值，债务须严格超过 80% 阈值。50% 单笔上限向上取整，5% 奖励对应抵押量向下取整。
/// Price is for one whole collateral token. Debt must strictly exceed the 80% threshold.
/// The 50% close cap rounds up; collateral paid at a 5% bonus rounds down.
fn quote(
    debt_raw: u64,
    collateral_raw: u64,
    price_raw: u64,
    collateral_decimals: u8,
    repay_raw: u64,
    min_collateral_raw: u64,
) -> Result<Quote> {
    require!(price_raw > 0, LendingError::InvalidMockPrice);
    // 使用实际抵押 Mint 精度。超出整数表示范围的 Mint 无法按此定价。
    // Use the actual collateral precision. Reject a mint scale outside the integer pricing range.
    let scale = 10u128
        .checked_pow(u32::from(collateral_decimals))
        .ok_or(LendingError::BorrowOverflow)?;
    let weighted_collateral = u128::from(collateral_raw) * u128::from(price_raw);
    let debt = u128::from(debt_raw);
    require!(
        debt > floor_weighted_ratio(weighted_collateral, 4, 5, scale),
        LendingError::PositionNotLiquidatable
    );

    // 先限制可由抵押品覆盖的代偿，再套用单笔上限。两者独立向下与向上取整。
    // Cap repayments by their collateral backing before applying the separately rounded close factor.
    let backed_repayment = floor_weighted_ratio(weighted_collateral, 20, 21, scale);
    let close_cap = u128::from(debt_raw / 2 + debt_raw % 2);
    if backed_repayment == 0 {
        // 剩余抵押品连一最小单位代偿都无法覆盖，(0, 0) 仅冲销坏账，不扣划抵押零头。
        // Collateral cannot cover one debt unit with its bonus. (0, 0) writes off the debt without taking dust.
        require!(
            repay_raw == 0 && min_collateral_raw == 0,
            LendingError::InvalidLiquidationAmount
        );
        return Ok(Quote {
            repaid_raw: 0,
            seized_collateral_raw: 0,
            bad_debt_raw: debt_raw,
        });
    }
    require!(
        repay_raw > 0
            && min_collateral_raw > 0
            && u128::from(repay_raw) <= close_cap.min(backed_repayment),
        LendingError::InvalidLiquidationAmount
    );

    // 通过抵押覆盖校验后，代偿乘以 scale 一定在 u128 范围内。拆分再乘 21，最终下舍入实际扣划。
    // The backing check bounds repay × scale by u128. Split before multiplying by 21 and floor the actual seizure.
    let scaled_repayment = u128::from(repay_raw)
        .checked_mul(scale)
        .ok_or(LendingError::BorrowOverflow)?;
    let price_denominator = 20 * u128::from(price_raw);
    let seized = scaled_repayment / price_denominator * 21
        + scaled_repayment % price_denominator * 21 / price_denominator;
    let seized_collateral_raw = u64::try_from(seized).map_err(|_| LendingError::BorrowOverflow)?;
    require!(
        seized_collateral_raw > 0,
        LendingError::ZeroLiquidationCollateral
    );
    require!(
        seized_collateral_raw >= min_collateral_raw,
        LendingError::MinimumLiquidationCollateralNotMet
    );

    // 借款人保留小于一个可代偿单位的余量，未偿债务同期冲减出借人的账面权益。
    // Leave any remainder below a repayable unit in the borrower's position and charge unpaid debt to suppliers.
    let collateral_after = collateral_raw
        .checked_sub(seized_collateral_raw)
        .ok_or(LendingError::InvalidBorrowAccounting)?;
    let remaining_backed = floor_weighted_ratio(
        u128::from(collateral_after) * u128::from(price_raw),
        20,
        21,
        scale,
    );
    let bad_debt_raw = if remaining_backed == 0 {
        debt_raw - repay_raw
    } else {
        0
    };
    Ok(Quote {
        repaid_raw: repay_raw,
        seized_collateral_raw,
        bad_debt_raw,
    })
}

/// 签名清算请求及其执行期实时价格，数量按各自资产最小单位计。
/// Signed liquidation terms and execution-time price, in the relevant base units.
#[derive(Clone, Copy)]
struct Terms {
    /// 仓位抵押量、整单位价格与抵押 Mint 小数位数。 Position collateral, whole-token price, and mint decimals.
    collateral_raw: u64,
    price_raw: u64,
    collateral_decimals: u8,
    /// 钱包授权的最大代偿和最低抵押到账。 Wallet-authorized maximum repayment and minimum collateral output.
    repay_raw: u64,
    min_collateral_raw: u64,
}

impl Terms {
    /// 用当前整数债务验证签名金额并计算预期到账。 Validate the signed amount using current debt and quote the collateral output.
    fn quote(self, debt: u64) -> Result<Quote> {
        quote(
            debt,
            self.collateral_raw,
            self.price_raw,
            self.collateral_decimals,
            self.repay_raw,
            self.min_collateral_raw,
        )
    }
}

/// 转账后待写入的聚合债务与池资产，并保留可选的计息尾部。
/// Resulting position and aggregate debt, pool assets, and optional indexed trailers.
struct Settlement {
    /// 本笔交易的实际转账与坏账，按各自资产最小单位计。 Actual transfers and write-off, in each mint's base units.
    amounts: Quote,
    /// 借款仓位、市场剩余债务和剩余账面出借资产，均按借款最小单位计。
    /// Remaining position debt, market debt, and recorded lending assets, all in debt base units.
    position_debt: u64,
    market_debt: u64,
    pool_assets: u64,
    /// 仅已启用计息的市场需要持久化两份归一化账本。 Only indexed markets persist both normalized ledgers.
    interest_after: Option<(PoolInterest, PositionInterest)>,
}

/// 在同一个时间点清偿归一化债务，以全池债务减少量作为实际代偿。
/// Settle normalized debt at a single instant. Pay the actual aggregate debt reduction.
///
/// `now` 是读取有效价格时的链上 Unix 秒。尾部与旧账户前缀在后续事务内一并持久化。
/// `now` is the chain Unix time used to check price freshness. The trailers and legacy field prefixes are persisted together later.
fn indexed_settlement(
    terms: Terms,
    mut pool: PoolInterest,
    mut position: PositionInterest,
    now: i64,
) -> Result<Settlement> {
    require!(
        position.start == pool.start && position.shares <= pool.shares,
        LendingError::InvalidInterestAccounting
    );
    let projection = pool.project(now)?;
    let position_debt = interest::debt_due(position.shares, projection.index)?;
    let requested = terms.quote(position_debt)?;

    // 签名代偿额是上限。归一化份额舍入使实际现金更少时，抵押奖励按实付重算。
    // The signed payment is a ceiling. If normalized-share rounding lowers actual cash, reprice the collateral using that cash.
    let mut amounts = if terms.repay_raw == 0 {
        requested
    } else {
        let payment = interest::debt_payment(pool, position, projection, terms.repay_raw)?;
        require!(payment.amount > 0, LendingError::InvalidLiquidationAmount);
        pool.shares = pool
            .shares
            .checked_sub(payment.shares)
            .ok_or(LendingError::InvalidInterestAccounting)?;
        position.shares = position
            .shares
            .checked_sub(payment.shares)
            .ok_or(LendingError::InvalidInterestAccounting)?;
        pool.cash = pool
            .cash
            .checked_add(payment.amount)
            .ok_or(LendingError::SupplyOverflow)?;
        if payment.amount == terms.repay_raw {
            requested
        } else {
            Terms {
                repay_raw: payment.amount,
                ..terms
            }
            .quote(position_debt)?
        }
    };

    // 账面冲销使用全池债务差，避免按单仓舍入额多冲减出借资产。
    // Write off only the aggregate debt delta, avoiding excess loss due to per-position rounding.
    let paid_debt = interest::debt_due(pool.shares, projection.index)?;
    let debt_paid = projection
        .debt
        .checked_sub(paid_debt)
        .ok_or(LendingError::InvalidInterestAccounting)?;
    // 极小仓位全额结清时，池可实际多收到一个最小单位，计入出借人的余额。
    // A tiny full repayment may add one cash base unit to supplier assets beyond the rounded book reduction.
    let rounding_gain = amounts
        .repaid_raw
        .checked_sub(debt_paid)
        .ok_or(LendingError::InvalidInterestAccounting)?;
    require!(rounding_gain <= 1, LendingError::InvalidInterestAccounting);
    if amounts.bad_debt_raw > 0 {
        pool.shares = pool
            .shares
            .checked_sub(position.shares)
            .ok_or(LendingError::InvalidInterestAccounting)?;
        position.shares = 0;
    }
    let market_debt = interest::debt_due(pool.shares, projection.index)?;
    amounts.bad_debt_raw = paid_debt
        .checked_sub(market_debt)
        .ok_or(LendingError::InvalidInterestAccounting)?;
    let pool_assets = pool
        .cash
        .checked_add(market_debt)
        .ok_or(LendingError::SupplyOverflow)?;
    require!(
        projection
            .assets
            .checked_sub(amounts.bad_debt_raw)
            .and_then(|remaining| remaining.checked_add(rounding_gain))
            == Some(pool_assets),
        LendingError::InvalidInterestAccounting
    );
    Ok(Settlement {
        amounts,
        position_debt: interest::debt_due(position.shares, projection.index)?,
        market_debt,
        pool_assets,
        interest_after: Some((pool, position)),
    })
}

/// 校验实际托管支持的旧本金账本，计算结算后的余额。
/// Verify legacy principal against physical custody and calculate post-settlement balances.
///
/// `accounts` 已完成规范 PDA 和 Mint 绑定。未启用计息的市场使用原有账本。
/// `accounts` already binds the canonical PDAs and mints. Markets without interest use their original balances.
fn legacy_settlement(accounts: &Liquidate, terms: Terms) -> Result<Settlement> {
    require!(
        interest::read_position(&accounts.borrow_position.to_account_info())?.is_none(),
        LendingError::InvalidInterestAccounting
    );
    let pool = &accounts.supply_pool;
    let ledger = &accounts.borrow_market;
    let position = &accounts.borrow_position;
    let accounted_cash = available_accounted_cash(
        pool.accounted_assets_raw,
        accounts.cash_vault.amount,
        ledger.total_debt_raw,
    )?;
    require!(
        position.debt_raw <= ledger.total_debt_raw,
        LendingError::InvalidBorrowAccounting
    );
    let amounts = terms.quote(position.debt_raw)?;
    let debt_reduction = amounts
        .repaid_raw
        .checked_add(amounts.bad_debt_raw)
        .ok_or(LendingError::BorrowOverflow)?;
    let market_debt = ledger
        .total_debt_raw
        .checked_sub(debt_reduction)
        .ok_or(LendingError::InvalidBorrowAccounting)?;
    let pool_assets = pool
        .accounted_assets_raw
        .checked_sub(amounts.bad_debt_raw)
        .ok_or(LendingError::InvalidBorrowAccounting)?;
    let backed_cash_after = accounted_cash
        .checked_add(amounts.repaid_raw)
        .ok_or(LendingError::BorrowOverflow)?;
    require!(
        pool_assets.checked_sub(market_debt) == Some(backed_cash_after),
        LendingError::InvalidBorrowAccounting
    );
    Ok(Settlement {
        amounts,
        position_debt: position.debt_raw - debt_reduction,
        market_debt,
        pool_assets,
        interest_after: None,
    })
}

/// 用链上时钟核对价格，原子转账、更新仓位和出借账本，并记录实际结算事件。
/// Validate oracle freshness against the chain clock, atomically settle transfers and accounting, and emit actual results.
///
/// `repay_raw` 和 `min_collateral_raw` 为各自资产最小单位，均为正；双零只允许无法代偿的坏账冲销。
/// Normal `repay_raw` and `min_collateral_raw` are positive base units. Both may be zero only for unrecoverable debt.
pub(crate) fn handle(
    context: Context<Liquidate>,
    repay_raw: u64,
    min_collateral_raw: u64,
) -> Result<()> {
    let accounts = context.accounts;
    let market = accounts.market.key();
    let now = Clock::get()?.unix_timestamp;
    let position_info = accounts.borrow_position.to_account_info();
    let pool_info = accounts.supply_pool.to_account_info();

    // 只允许使用实际托管能够支持的仓位和清算签名人能支付的金额。
    // Settle only positions backed by physical custody and amounts the signer can pay.
    require!(
        accounts.supply_pool.total_shares_raw > 0
            && accounts.borrow_position.collateral_raw <= accounts.collateral_vault.amount,
        LendingError::InvalidBorrowAccounting
    );
    require!(
        accounts.liquidator_debt.amount >= repay_raw,
        LendingError::InsufficientBorrowTokenBalance
    );
    let terms = Terms {
        collateral_raw: accounts.borrow_position.collateral_raw,
        price_raw: require_fresh_price(&accounts.mock_collateral_price, market, now)?,
        collateral_decimals: accounts.collateral_mint.decimals,
        repay_raw,
        min_collateral_raw,
    };

    // 根据规范池数据识别计息状态；已启用市场绝不能回退到旧本金值。
    // Detect interest from the canonical pool, never falling back to a cached principal on an indexed market.
    let settlement = if let Some(pool) = interest::read_pool(&pool_info)? {
        require!(
            pool.cash <= accounts.cash_vault.amount,
            LendingError::InvalidInterestAccounting
        );
        let position = interest::read_position(&position_info)?
            .ok_or(LendingError::PositionNotLiquidatable)?;
        indexed_settlement(terms, pool, position, now)?
    } else {
        legacy_settlement(accounts, terms)?
    };
    let amounts = settlement.amounts;

    if amounts.repaid_raw > 0 {
        // 清算人直接向现金托管付款。市场 PDA 使用原市场种子为抵押出账签名，两次转账一同回滚。
        // The liquidator pays cash custody directly. The market PDA signs the collateral payout using its original seed.
        // Both transfers revert together on failure.
        token::transfer_checked(
            CpiContext::new(
                accounts.token_program.key(),
                TransferChecked {
                    from: accounts.liquidator_debt.to_account_info(),
                    mint: accounts.debt_mint.to_account_info(),
                    to: accounts.cash_vault.to_account_info(),
                    authority: accounts.liquidator.to_account_info(),
                },
            ),
            amounts.repaid_raw,
            accounts.debt_mint.decimals,
        )?;

        let market_bump = [accounts.market.bump];
        let signer_seeds: &[&[u8]] = &[MARKET_SEED, &market_bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                TransferChecked {
                    from: accounts.collateral_vault.to_account_info(),
                    mint: accounts.collateral_mint.to_account_info(),
                    to: accounts.liquidator_collateral.to_account_info(),
                    authority: accounts.market.to_account_info(),
                },
                &[signer_seeds],
            ),
            amounts.seized_collateral_raw,
            accounts.collateral_mint.decimals,
        )?;
    }

    // 先验证所有更新所需条件并成功转账，才提交仓位、市场和出借池的变动。
    // Commit position, market, and pool updates only after preconditions and token transfers succeed.
    if let Some((pool, position)) = settlement.interest_after {
        interest::store_pool(&pool_info, pool)?;
        interest::store_position(&position_info, position)?;
    }
    accounts.borrow_position.collateral_raw -= amounts.seized_collateral_raw;
    accounts.borrow_position.debt_raw = settlement.position_debt;
    accounts.borrow_market.total_debt_raw = settlement.market_debt;
    accounts.supply_pool.accounted_assets_raw = settlement.pool_assets;
    // 极小计息份额的冲销可能不改变全池整数债务。没有现金、抵押或账面变动时不生成财务事件。
    // A tiny indexed write-off may leave rounded aggregate debt unchanged. Emit a financial event only when assets or book value move.
    if amounts.repaid_raw != 0 || amounts.bad_debt_raw != 0 {
        emit!(LendingLiquidation {
            market,
            borrower: accounts.borrow_position.borrower,
            liquidator: accounts.liquidator.key(),
            debt_mint: accounts.debt_mint.key(),
            collateral_mint: accounts.collateral_mint.key(),
            repaid_raw: amounts.repaid_raw,
            seized_collateral_raw: amounts.seized_collateral_raw,
            bad_debt_raw: amounts.bad_debt_raw,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 阈值等于 80%、超单笔上限和低于最低到账均不能清算；正常代偿按奖励比例支付。
    /// Reject equality at the 80% threshold, payments above the close cap, and quotes below minimum output.
    #[test]
    fn enforces_health_close_cap_and_minimum_output() {
        assert!(quote(80, 1000, 100, 3, 10, 1).is_err());
        assert!(quote(100, 1000, 100, 3, 51, 1).is_err());
        assert!(quote(100, 1000, 100, 3, 50, 526).is_err());
        let result = quote(100, 1000, 100, 3, 50, 525).unwrap();
        assert_eq!(
            (
                result.repaid_raw,
                result.seized_collateral_raw,
                result.bad_debt_raw
            ),
            (50, 525, 0)
        );
        assert_eq!(
            quote(81, 1000, 100, 3, 41, 1)
                .unwrap()
                .seized_collateral_raw,
            430
        );
    }

    /// 深度低抵押仓位按可覆盖金额偿还，残留抵押品不作为额外奖励。
    /// Cap deeply underwater settlement by collateral backing, with no excess reward for residual dust.
    #[test]
    fn assigns_unrecoverable_debt_without_taking_dust() {
        assert!(quote(100, 1000, 10, 3, 10, 1).is_err());
        let result = quote(100, 1000, 10, 3, 9, 945).unwrap();
        assert_eq!(
            (
                result.repaid_raw,
                result.seized_collateral_raw,
                result.bad_debt_raw
            ),
            (9, 945, 91)
        );
        let dust = quote(5, 3, 1000, 4, 0, 0).unwrap();
        assert_eq!(
            (
                dust.repaid_raw,
                dust.seized_collateral_raw,
                dust.bad_debt_raw
            ),
            (0, 0, 5)
        );
        assert!(quote(5, 3, 1000, 4, 0, 1).is_err());
        assert!(quote(5, 1000, 100, 3, 0, 0).is_err());
    }

    /// 实际计息债务用于判断健康度，冲销旧债只扣除其全池账面影响。
    /// Health uses accrued debt, and write-offs remove only the debt's aggregate book impact.
    #[test]
    fn settles_accrued_debt_and_preserves_another_borrower() {
        let start = 1_700_000_000;
        let now = start + 3_600;
        let empty = PoolInterest {
            start,
            cash: 100_000_000,
            shares: 0,
        };
        let index = empty.project(start).unwrap().index;
        let position = PositionInterest {
            start,
            shares: interest::normalize_borrow(70_000_000, index),
        };
        let other_shares = interest::normalize_borrow(33_333, index);
        let pool = PoolInterest {
            shares: position.shares + other_shares,
            ..empty
        };
        let before = pool.project(now).unwrap();
        let terms = Terms {
            collateral_raw: 1_000_000_000,
            price_raw: 87_500_000,
            collateral_decimals: 9,
            repay_raw: 20_000_000,
            min_collateral_raw: 1,
        };
        assert!(terms.quote(70_000_000).is_err());
        let partial = indexed_settlement(terms, pool, position, now).unwrap();
        assert!(partial.amounts.repaid_raw <= 20_000_000);
        assert_eq!(partial.amounts.bad_debt_raw, 0);
        assert_eq!(partial.pool_assets, before.assets);
        let dust = Terms {
            collateral_raw: 1,
            price_raw: 1,
            repay_raw: 0,
            min_collateral_raw: 0,
            ..terms
        };
        let write_off = indexed_settlement(dust, pool, position, now).unwrap();
        assert_eq!(write_off.position_debt, 0);
        assert_eq!(
            write_off.market_debt,
            interest::debt_due(other_shares, before.index).unwrap()
        );
        assert_eq!(write_off.pool_assets - write_off.market_debt, empty.cash);
        assert_eq!(
            write_off.amounts.bad_debt_raw,
            before.assets - write_off.pool_assets
        );
    }

    /// 使用 u128 边界并确保只结算大于零的实际扣划数量。
    /// Exercise the u128 boundary and reject settlements with a zero collateral payout.
    #[test]
    fn prices_wide_inputs_and_rejects_zero_payout() {
        assert_eq!(floor_weighted_ratio(u128::MAX, 4, 5, 1), u128::MAX / 5 * 4);
        assert!(quote(81, 1, 100, 0, 41, 1).is_err());
        assert!(quote(100, 1000, 0, 3, 10, 1).is_err());
        assert!(quote(u64::MAX, u64::MAX, u64::MAX, 255, 10, 1).is_err());
    }
}

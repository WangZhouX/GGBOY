//! 金库闲置现金的出借和收回。通过借贷程序 CPI 记账和转移代币。
//! Allocation and recall of idle vault cash. Accounting and transfers run through lending CPIs.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use ggboy_lending::{cpi, program::GgboyLending, LendingMarket, SupplyPool, SupplyPosition};

use super::strategy::{
    bps_ceil, bps_floor, VaultStrategyAction, BORROW_MARKET_SEED, LENDING_CASH_SEED, POOL_SEED,
    POSITION_SEED,
};
use crate::{
    state::{STRATEGY_CUSTODY_SEED, STRATEGY_SEED, VAULT_SEED},
    strategy_valuation::{inspect_pool, read_price, spot_value},
    Vault, VaultError, VaultStrategy,
};

/// 管理者以金库 PDA 为出借者，首次仓位的租金由管理者签名支付。
/// Manager supplies as the vault PDA and signs as the rent payer for its first position.
#[derive(Accounts)]
pub struct StrategyLend<'info> {
    /// 配置中的管理者，首次出借时支付租金。 Configured manager and first-supply rent payer.
    #[account(mut)]
    pub manager: Signer<'info>,
    /// 结算资产和出借份额所归属的金库。 Vault owning settlement assets and credited supply shares.
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump, has_one = cash_vault, has_one = asset_mint)]
    pub vault: Account<'info, Vault>,
    /// 金库已启用的配置及出借上限。 Enabled vault configuration and lending limits.
    #[account(seeds = [STRATEGY_SEED, vault.key().as_ref()], bump = strategy.bump,
        has_one = vault, has_one = manager, has_one = market)]
    pub strategy: Box<Account<'info, VaultStrategy>>,
    /// 出借资金只从金库现金扣除。 Supplies exclusively from vault cash.
    #[account(mut, token::mint = asset_mint, token::authority = vault)]
    pub cash_vault: Box<Account<'info, TokenAccount>>,
    /// 初始化时登记的结算 Mint。 Settlement mint bound at initialization.
    pub asset_mint: Box<Account<'info, Mint>>,
    /// 通过规范 PDA 和代币归属约束读出实际的策略资产持仓。 Actual vault spot balance verified by PDA and token binding.
    #[account(seeds = [STRATEGY_CUSTODY_SEED, strategy.key().as_ref()], bump,
        token::authority = vault, constraint = strategy_custody.mint == strategy.strategy_mint @ VaultError::InvalidStrategyAccounts)]
    pub strategy_custody: Box<Account<'info, TokenAccount>>,
    /// 与金库配置绑定的真实借贷市场。 Actual lending market bound to the vault configuration.
    #[account(constraint = market.debt_mint == asset_mint.key() @ VaultError::InvalidStrategyAccounts)]
    pub market: Box<Account<'info, LendingMarket>>,
    /// CHECK: 非零策略持仓时读取规范市场报价，校验地址、程序归属和时效。
    /// CHECK: With nonzero spot holdings, validates and reads the canonical market oracle.
    pub price: UncheckedAccount<'info>,
    /// 借贷市场规范现金托管。 Market's canonical settlement cash custody.
    #[account(mut, seeds = [LENDING_CASH_SEED, market.key().as_ref()], bump,
        seeds::program = ggboy_lending::ID, address = market.cash_vault,
        token::mint = asset_mint, token::authority = market)]
    pub lending_cash: Box<Account<'info, TokenAccount>>,
    /// CHECK: 核对规范池记账地址和布局，首次出借由借贷程序初始化。
    /// CHECK: Canonical pool accounting and its layout are validated. The lending program initializes it on first supply.
    #[account(mut)]
    pub supply_pool: UncheckedAccount<'info>,
    /// CHECK: 核对金库的规范出借仓位或由借贷程序初始化。
    /// CHECK: The vault's canonical supply position is verified or initialized by the lending program.
    #[account(mut)]
    pub supply_position: UncheckedAccount<'info>,
    /// Anchor 检查内层 CPI 目标是编译期指定的借贷程序。 Anchor pins the inner CPI to the compiled lending program.
    pub lending_program: Program<'info, GgboyLending>,
    /// 借贷程序执行现金转账的 SPL 代币程序。 SPL Token program responsible for lending transfers.
    pub token_program: Program<'info, Token>,
    /// 首次建仓时分配池记账和金库仓位。 Allocates pool accounting and the vault position on first supply.
    pub system_program: Program<'info, System>,
}

/// 按金库份额和借贷流动性约束收回金库结算资产。
/// Recall vault settlement assets subject to vault shares and lending liquidity.
#[derive(Accounts)]
pub struct StrategyRecall<'info> {
    /// 策略配置中签名管理者。 Authorized strategy manager signer.
    pub manager: Signer<'info>,
    /// 出借份额归属和现金结算的金库。 Vault owning the supply position and receiving settlement cash.
    #[account(seeds = [VAULT_SEED], bump = vault.bump, has_one = cash_vault, has_one = asset_mint)]
    pub vault: Account<'info, Vault>,
    /// 规范配置同时绑定签名人和市场。 Canonical configuration binding the signer and market.
    #[account(seeds = [STRATEGY_SEED, vault.key().as_ref()], bump = strategy.bump,
        has_one = vault, has_one = manager, has_one = market)]
    pub strategy: Box<Account<'info, VaultStrategy>>,
    /// 收回的资金仅回到金库现金账户。 Recalled cash returns exclusively to vault custody.
    #[account(mut, token::mint = asset_mint, token::authority = vault)]
    pub cash_vault: Box<Account<'info, TokenAccount>>,
    /// 金库的结算资产 Mint。 Vault settlement asset mint.
    pub asset_mint: Box<Account<'info, Mint>>,
    /// 配置绑定的借贷市场。 Configured lending market.
    #[account(constraint = market.debt_mint == asset_mint.key() @ VaultError::InvalidStrategyAccounts)]
    pub market: Box<Account<'info, LendingMarket>>,
    /// 借贷市场的规范现金托管。 Canonical market cash custody.
    #[account(mut, seeds = [LENDING_CASH_SEED, market.key().as_ref()], bump,
        seeds::program = ggboy_lending::ID, address = market.cash_vault,
        token::mint = asset_mint, token::authority = market)]
    pub lending_cash: Box<Account<'info, TokenAccount>>,
    /// 借贷程序校验该市场的规范池记账。 Pool accounting validated by the lending program.
    #[account(mut, seeds = [POOL_SEED, market.key().as_ref()], bump, seeds::program = ggboy_lending::ID)]
    pub supply_pool: Box<Account<'info, SupplyPool>>,
    /// 只允许销毁金库自己的出借份额。 Burns only supply shares owned by this vault.
    #[account(mut, seeds = [POSITION_SEED, market.key().as_ref(), vault.key().as_ref()], bump,
        seeds::program = ggboy_lending::ID)]
    pub supply_position: Box<Account<'info, SupplyPosition>>,
    /// CHECK: 已绑定规范借款总账地址，借贷程序核对程序归属及记账。
    /// CHECK: Bound to the canonical debt ledger. The lending program validates its ownership and accounting.
    #[account(seeds = [BORROW_MARKET_SEED, market.key().as_ref()], bump, seeds::program = ggboy_lending::ID)]
    pub borrow_market: UncheckedAccount<'info>,
    /// 固定的借贷 CPI 程序。 Pinned lending CPI program.
    pub lending_program: Program<'info, GgboyLending>,
    /// 执行现金转账的经典 SPL Token 程序。 Classic SPL Token program that pays the recalled cash.
    pub token_program: Program<'info, Token>,
}

/// 按交易前净值校验现金留存和出借价值上限，再以金库 PDA 出借。
/// Enforce cash retention and the lending cap at pre-transaction NAV, then supply as the vault PDA.
///
/// `assets_in` 是结算代币最小单位，`min_shares_out` 是池份额最小单位。
/// `assets_in` is in settlement base units, and `min_shares_out` is in pool share base units.
pub(crate) fn lend(
    context: Context<StrategyLend>,
    assets_in: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(
        assets_in > 0 && min_shares_out > 0,
        VaultError::InvalidStrategyAmount
    );

    // 读取用于留存与上限的真实托管现金、现货与出借价值。
    // Read actual custody cash, spot value, and lending exposure for both limits.
    let accounts = context.accounts;
    let vault = accounts.vault.key();
    let market = accounts.market.key();
    let cash = accounts.cash_vault.amount;
    let spot = accounts.strategy_custody.amount;
    let position_value = inspect_pool(
        market,
        vault,
        &accounts.supply_pool.to_account_info(),
        &accounts.supply_position.to_account_info(),
    )?
    .value()?;
    let spot_value = if spot == 0 {
        0
    } else {
        spot_value(spot, read_price(market, &accounts.price.to_account_info())?)?
    };
    let nav = cash
        .checked_add(spot_value)
        .and_then(|cash_and_spot| cash_and_spot.checked_add(position_value))
        .ok_or(VaultError::StrategyValuationOverflow)?;

    // 留存向上、出借上限向下取整，任何一项已不满足时不允许继续分配。
    // Round the reserve up and the cap down, and prevent further allocation if either limit is already exceeded.
    let reserve = bps_ceil(nav, accounts.strategy.reserve_bps);
    let lending_limit = bps_floor(nav, accounts.strategy.lending_cap_bps);
    let max_amount = cash
        .saturating_sub(reserve)
        .min(lending_limit.saturating_sub(position_value));
    require!(assets_in <= max_amount, VaultError::StrategyLimitExceeded);

    // 金库 PDA 是出资人。首次创建仓位时让管理者承担租金，金库无需存放 SOL。
    // The vault PDA is the supplier. The manager pays first-time account rent, so the vault needs no excess SOL.
    let vault_bump = [accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, &vault_bump];
    let lending_program = accounts.lending_program.key();
    if accounts.supply_pool.data_is_empty() || accounts.supply_position.data_is_empty() {
        cpi::prepare_supply(CpiContext::new_with_signer(
            lending_program,
            cpi::accounts::PrepareSupply {
                payer: accounts.manager.to_account_info(),
                supplier: accounts.vault.to_account_info(),
                market: accounts.market.to_account_info(),
                supply_pool: accounts.supply_pool.to_account_info(),
                supply_position: accounts.supply_position.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
            },
            &[vault_seeds],
        ))?;
    }
    cpi::supply(
        CpiContext::new_with_signer(
            lending_program,
            cpi::accounts::Supply {
                supplier: accounts.vault.to_account_info(),
                market: accounts.market.to_account_info(),
                debt_mint: accounts.asset_mint.to_account_info(),
                cash_vault: accounts.lending_cash.to_account_info(),
                source: accounts.cash_vault.to_account_info(),
                supply_pool: accounts.supply_pool.to_account_info(),
                supply_position: accounts.supply_position.to_account_info(),
                token_program: accounts.token_program.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
            },
            &[vault_seeds],
        ),
        assets_in,
        min_shares_out,
    )?;

    // 借贷程序以精确的输入数量结算，失败时不会产生金库活动事件。
    // The lending program settles the exact cash input. A failed invocation emits no vault activity.
    emit_cash_action(
        vault,
        accounts.manager.key(),
        accounts.asset_mint.key(),
        1,
        assets_in,
    );
    Ok(())
}

/// 以金库 PDA 减少出借份额，借贷 CPI 检查现金和最低到账。
/// Redeem supply shares as the vault PDA. The lending CPI verifies liquidity and minimum output.
///
/// `shares_in` 是池份额最小单位，`min_assets_out` 是最低结算代币最小单位。
/// `shares_in` is in pool share base units and `min_assets_out` in settlement base units.
pub(crate) fn recall(
    context: Context<StrategyRecall>,
    shares_in: u64,
    min_assets_out: u64,
) -> Result<()> {
    require!(
        shares_in > 0 && min_assets_out > 0,
        VaultError::InvalidStrategyAmount
    );

    // 收回受出借账本和池现金限制，允许在策略价格暂不可用时恢复现金。
    // Recall depends on the lending ledger and cash only and remains usable when spot pricing is unavailable.
    let accounts = context.accounts;
    let cash_before = accounts.cash_vault.amount;
    withdraw_cash(
        cpi::accounts::WithdrawSupply {
            supplier: accounts.vault.to_account_info(),
            market: accounts.market.to_account_info(),
            debt_mint: accounts.asset_mint.to_account_info(),
            cash_vault: accounts.lending_cash.to_account_info(),
            destination: accounts.cash_vault.to_account_info(),
            supply_pool: accounts.supply_pool.to_account_info(),
            supply_position: accounts.supply_position.to_account_info(),
            borrow_market: accounts.borrow_market.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
        },
        accounts.vault.bump,
        shares_in,
        min_assets_out,
    )?;

    // CPI 后重读结算账户，回执记录金库真正收到的现金。
    // Reload the custody after CPI so the receipt reports actual incoming cash.
    accounts.cash_vault.reload()?;
    let amount = accounts
        .cash_vault
        .amount
        .checked_sub(cash_before)
        .ok_or(VaultError::InvalidStrategyAccounts)?;
    require!(
        amount >= min_assets_out,
        VaultError::MinimumStrategyOutputNotMet
    );
    emit_cash_action(
        accounts.vault.key(),
        accounts.manager.key(),
        accounts.asset_mint.key(),
        2,
        amount,
    );
    Ok(())
}

/// 使用金库 PDA 签名调用固定借贷程序，将现金提取到金库。
/// Sign as the vault PDA to withdraw cash into custody through the pinned lending program.
///
/// `accounts` 绑定规范市场与金库，借贷程序负责验证份额归属、已记账和实际现金。
/// `accounts` binds the canonical market and vault. Lending validates share ownership, accounted cash and actual cash.
/// 金额参数与借贷程序相同，分别以池份额和结算资产的最小单位计。
/// Amounts follow the lending program and use pool share and settlement base units respectively.
pub(super) fn withdraw_cash(
    accounts: cpi::accounts::WithdrawSupply<'_>,
    vault_bump: u8,
    shares_in: u64,
    min_assets_out: u64,
) -> Result<()> {
    let bump = [vault_bump];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, &bump];
    cpi::withdraw_supply(
        CpiContext::new_with_signer(ggboy_lending::ID, accounts, &[vault_seeds]),
        shares_in,
        min_assets_out,
    )
}

/// 为成功执行的出借或收回记录单一现金腿，金额单位为结算资产最小单位。
/// Record the single settlement cash leg of an executed allocation or recall in base units.
fn emit_cash_action(vault: Pubkey, manager: Pubkey, mint: Pubkey, kind: u8, amount: u64) {
    emit!(VaultStrategyAction {
        vault,
        manager,
        kind,
        input_mint: mint,
        output_mint: mint,
        input_raw: amount,
        output_raw: amount,
    });
}

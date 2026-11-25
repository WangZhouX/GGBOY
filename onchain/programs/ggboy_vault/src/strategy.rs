//! 策略配置与测试兑换。使用独立测试储备结算真实的 SPL 转账。
//! Strategy configuration and test swaps. Separate test reserves settle real SPL transfers.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use ggboy_lending::LendingMarket;

use crate::{
    state::VAULT_SEED,
    strategy_valuation::{inspect_pool, read_price, spot_value, STRATEGY_SCALE},
    Vault, VaultError,
};

/// 策略配置及测试兑换相关 PDA 种子。
/// Seeds for strategy configuration and test exchange PDAs.
pub(crate) const STRATEGY_SEED: &[u8] = b"strategy";
pub(crate) const STRATEGY_CUSTODY_SEED: &[u8] = b"strategy_custody";
const SWAP_CASH_SEED: &[u8] = b"swap_cash";
const SWAP_STRATEGY_SEED: &[u8] = b"swap_strategy";

/// 规范借贷 PDA 的种子，与借贷程序指令约束一致。
/// Canonical lending PDA seeds matching lending program constraints.
pub(crate) const MARKET_SEED: &[u8] = b"lending_market";
pub(crate) const PRICE_SEED: &[u8] = b"mock_collateral_price";
pub(crate) const POOL_SEED: &[u8] = b"supply_pool";
pub(crate) const POSITION_SEED: &[u8] = b"supply_position";
pub(crate) const BORROW_MARKET_SEED: &[u8] = b"borrow_market";
pub(crate) const LENDING_CASH_SEED: &[u8] = b"cash_vault";

/// 策略启用后保留原始布局并追加一字节，旧账户以原始长度继续运行。
/// Strategy activation appends one byte without shifting the old layout. Old-length accounts keep running.
pub(crate) const STRATEGY_VAULT_LEN: usize = Vault::DISCRIMINATOR.len() + Vault::INIT_SPACE + 1;

/// 策略金库末尾功能字节最低位表示允许投资者自动收回。
/// The low bit of the strategy vault's trailing capability byte enables investor auto recall.
const AUTO_RECALL_FLAG: u8 = 1;

/// 比例以基点表示。九位小数的测试策略 Mint 用固定最小单位计价。
/// Rates use basis points. The nine-decimal test strategy mint has a fixed base-unit scale.
pub(crate) const BPS_DENOMINATOR: u128 = 10_000;
const STRATEGY_DECIMALS: u8 = 9;

/// 管理者及单个策略资产/市场的链上配置。金额限制按交易前净值计算。
/// On-chain manager and single-asset/market configuration. Limits use pre-transaction NAV.
#[account]
#[derive(InitSpace)]
pub struct VaultStrategy {
    /// 账户所属的金库 PDA。 Vault PDA owning this configuration.
    pub vault: Pubkey,
    /// 拥有资金操作授权的钱包。 Wallet authorized to perform strategy operations.
    pub manager: Pubkey,
    /// 九位小数的策略资产 Mint。 Nine-decimal strategy asset mint.
    pub strategy_mint: Pubkey,
    /// 使用相同一对资产的借贷市场 PDA。 Lending market PDA using the same asset pair.
    pub market: Pubkey,
    /// 出借后须保留的最低金库现金，单位为净值基点。 Minimum post-lending cash in NAV basis points.
    pub reserve_bps: u16,
    /// 允许的最高出借估值，单位为净值基点。 Maximum lending valuation in NAV basis points.
    pub lending_cap_bps: u16,
    /// 最大单笔兑换估值，单位为净值基点。 Maximum per-swap value in NAV basis points.
    pub max_trade_bps: u16,
    /// 配置 PDA 的规范 bump。 Canonical configuration PDA bump.
    pub bump: u8,
}

/// 由原管理员一次性为既有金库配置策略及独立测试储备。
/// One-time setup of strategy and separate test reserves by the existing vault administrator.
#[derive(Accounts)]
pub struct InitializeVaultStrategy<'info> {
    /// 支付配置及托管账户租金的金库管理员签名。 Signing vault administrator and rent payer.
    #[account(mut)]
    pub administrator: Signer<'info>,
    /// 原金库状态，延长一个字节并保留所有原字段。 Existing vault extended by one byte with all fields preserved.
    #[account(
        mut, seeds = [VAULT_SEED], bump = vault.bump, has_one = administrator, has_one = asset_mint,
        realloc = STRATEGY_VAULT_LEN, realloc::payer = administrator, realloc::zero = true,
    )]
    pub vault: Account<'info, Vault>,
    /// 从金库公钥派生的策略配置。 Strategy configuration derived from the vault key.
    #[account(init, payer = administrator, space = VaultStrategy::DISCRIMINATOR.len() + VaultStrategy::INIT_SPACE,
        seeds = [STRATEGY_SEED, vault.key().as_ref()], bump)]
    pub strategy: Box<Account<'info, VaultStrategy>>,
    /// 金库原始结算 Mint。 Original vault settlement mint.
    pub asset_mint: Box<Account<'info, Mint>>,
    /// 市场抵押品 Mint，精度固定为九位。 Nine-decimal market collateral mint.
    #[account(constraint = strategy_mint.decimals == STRATEGY_DECIMALS @ VaultError::InvalidStrategyAccounts,
        constraint = strategy_mint.key() != asset_mint.key() @ VaultError::InvalidStrategyAccounts)]
    pub strategy_mint: Box<Account<'info, Mint>>,
    /// 借贷程序的唯一市场，与金库结算及持仓 Mint 同对。 Lending singleton bound to the vault's mint pair.
    #[account(seeds = [MARKET_SEED], bump = market.bump, seeds::program = ggboy_lending::ID,
        constraint = market.debt_mint == asset_mint.key() @ VaultError::InvalidStrategyAccounts,
        constraint = market.collateral_mint == strategy_mint.key() @ VaultError::InvalidStrategyAccounts)]
    pub market: Box<Account<'info, LendingMarket>>,
    /// 金库 PDA 控制的策略持仓托管账户。 Spot custody controlled by the vault PDA.
    #[account(init, payer = administrator, seeds = [STRATEGY_CUSTODY_SEED, strategy.key().as_ref()], bump,
        token::mint = strategy_mint, token::authority = vault, token::token_program = token_program)]
    pub strategy_custody: Box<Account<'info, TokenAccount>>,
    /// 独立于金库的测试兑换结算资产储备。 Test exchange cash reserve, separate from the vault.
    #[account(init, payer = administrator, seeds = [SWAP_CASH_SEED, strategy.key().as_ref()], bump,
        token::mint = asset_mint, token::authority = strategy, token::token_program = token_program)]
    pub swap_cash: Box<Account<'info, TokenAccount>>,
    /// 独立于金库的测试兑换策略资产储备。 Test exchange spot reserve, separate from the vault.
    #[account(init, payer = administrator, seeds = [SWAP_STRATEGY_SEED, strategy.key().as_ref()], bump,
        token::mint = strategy_mint, token::authority = strategy, token::token_program = token_program)]
    pub swap_strategy: Box<Account<'info, TokenAccount>>,
    /// 经典 SPL Token 程序。 Classic SPL Token program.
    pub token_program: Program<'info, Token>,
    /// 分配策略和托管账户的系统程序。 System program allocating the strategy and custody accounts.
    pub system_program: Program<'info, System>,
}

/// 有效策略金库的管理员可为已部署的金库启用自动收回。
/// The administrator of an active strategy vault can opt the deployed vault into auto recall.
#[derive(Accounts)]
pub struct EnableAutoRecall<'info> {
    /// 初始化金库时绑定的管理员签名。 Signing administrator bound by vault initialization.
    pub administrator: Signer<'info>,
    /// 保存功能位的规范金库。 Canonical vault holding the capability byte.
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump, has_one = administrator)]
    pub vault: Account<'info, Vault>,
    /// 已存在且属于该金库的规范策略配置。 Existing canonical strategy configuration belonging to this vault.
    #[account(seeds = [STRATEGY_SEED, vault.key().as_ref()], bump = strategy.bump, has_one = vault)]
    pub strategy: Account<'info, VaultStrategy>,
}

/// 双向测试兑换到账账户、储备账户和链上报价输入。
/// Settlement accounts, reserves, and on-chain quote inputs for a two-way test swap.
#[derive(Accounts)]
pub struct StrategySwap<'info> {
    /// 策略配置中指定的签名钱包。 Signing wallet specified by the strategy configuration.
    pub manager: Signer<'info>,
    /// 定价及资金流转所属的金库。 Vault whose assets are priced and moved.
    #[account(seeds = [VAULT_SEED], bump = vault.bump, has_one = cash_vault, has_one = asset_mint)]
    pub vault: Account<'info, Vault>,
    /// 规范配置，校验管理者、金库、策略资产和市场。 Canonical config binding authority, vault, spot mint, and market.
    #[account(seeds = [STRATEGY_SEED, vault.key().as_ref()], bump = strategy.bump,
        has_one = vault, has_one = manager, has_one = strategy_mint, has_one = market)]
    pub strategy: Box<Account<'info, VaultStrategy>>,
    /// 金库真实结算资产托管。 Actual vault cash custody.
    #[account(mut, token::mint = asset_mint, token::authority = vault)]
    pub cash_vault: Box<Account<'info, TokenAccount>>,
    /// 金库原始结算 Mint。 Original vault settlement mint.
    pub asset_mint: Box<Account<'info, Mint>>,
    /// 金库的策略资产托管，余额包含于金库净值。 Vault spot custody counted in vault NAV.
    #[account(mut, seeds = [STRATEGY_CUSTODY_SEED, strategy.key().as_ref()], bump,
        token::mint = strategy_mint, token::authority = vault)]
    pub strategy_custody: Box<Account<'info, TokenAccount>>,
    /// 已绑定的九位小数策略 Mint。 Bound nine-decimal spot mint.
    pub strategy_mint: Box<Account<'info, Mint>>,
    /// 测试兑换所用的结算资产储备。 Test exchange settlement reserve.
    #[account(mut, seeds = [SWAP_CASH_SEED, strategy.key().as_ref()], bump,
        token::mint = asset_mint, token::authority = strategy)]
    pub swap_cash: Box<Account<'info, TokenAccount>>,
    /// 测试兑换所用的策略资产储备。 Test exchange spot reserve.
    #[account(mut, seeds = [SWAP_STRATEGY_SEED, strategy.key().as_ref()], bump,
        token::mint = strategy_mint, token::authority = strategy)]
    pub swap_strategy: Box<Account<'info, TokenAccount>>,
    /// 绑定的市场，锚定价格及出借价值。 Bound market anchoring oracle and lending valuation.
    pub market: Box<Account<'info, LendingMarket>>,
    /// CHECK: 处理函数核对规范 PDA、归属、市场、布局与发布时间。
    /// CHECK: Handler verifies canonical PDA, owner, market, layout, and publication.
    pub price: UncheckedAccount<'info>,
    /// CHECK: 处理函数核对已初始化的规范池记账或规范空账户。
    /// CHECK: Handler verifies initialized canonical pool accounting or its canonical empty account.
    pub supply_pool: UncheckedAccount<'info>,
    /// CHECK: 处理函数核对金库的规范出借仓位或规范空账户。
    /// CHECK: Handler verifies the vault's canonical supply position or its canonical empty account.
    pub supply_position: UncheckedAccount<'info>,
    /// 同一交易执行交换两条转账的经典 SPL Token 程序。 Classic SPL Token program executing both swap legs.
    pub token_program: Program<'info, Token>,
}

/// 成功执行的策略资金操作。金额和相应 Mint 同序写入 Anchor 日志。
/// Executed strategy operation. Amounts and corresponding mints share their order in Anchor logs.
#[event]
pub struct VaultStrategyAction {
    /// 金库 PDA。 Vault PDA.
    pub vault: Pubkey,
    /// 策略管理者签名钱包。 Strategy manager signer.
    pub manager: Pubkey,
    /// 0 兑换，1 出借，2 收回。 0 swap, 1 lend, 2 recall.
    pub kind: u8,
    /// 换出 Mint，出借和收回时是结算 Mint。 Input mint, or the settlement mint for lending and recall.
    pub input_mint: Pubkey,
    /// 换入 Mint，出借和收回时是结算 Mint。 Output mint, or the settlement mint for lending and recall.
    pub output_mint: Pubkey,
    /// 输入 Mint 的实际最小单位数。 Actual input mint base units.
    pub input_raw: u64,
    /// 输出 Mint 的实际最小单位数。 Actual output mint base units.
    pub output_raw: u64,
}

/// 保存一次性策略配置。比例为 0 至 10,000 基点，交易上限必须为正。
/// Save one-time configuration. Ratios span 0 to 10,000 basis points, with a positive trade limit.
pub(super) fn initialize(
    context: Context<InitializeVaultStrategy>,
    manager: Pubkey,
    reserve_bps: u16,
    lending_cap_bps: u16,
    max_trade_bps: u16,
) -> Result<()> {
    // 不允许空管理者身份，也不接受大于 100% 的配置。
    // Reject an empty manager identity or any percentage over 100%.
    require!(
        manager != Pubkey::default()
            && u128::from(reserve_bps) <= BPS_DENOMINATOR
            && u128::from(lending_cap_bps) <= BPS_DENOMINATOR
            && (1..=BPS_DENOMINATOR).contains(&u128::from(max_trade_bps)),
        VaultError::InvalidStrategyParameters
    );

    context.accounts.strategy.set_inner(VaultStrategy {
        vault: context.accounts.vault.key(),
        manager,
        strategy_mint: context.accounts.strategy_mint.key(),
        market: context.accounts.market.key(),
        reserve_bps,
        lending_cap_bps,
        max_trade_bps,
        bump: context.bumps.strategy,
    });
    set_auto_recall_bit(&context.accounts.vault)
}

/// 管理员确认现有策略金库可以使用扩展赎回账户，重复调用没有额外影响。
/// Enable extended redemption accounts for an existing strategy vault. Repeated calls are idempotent.
pub(super) fn enable_auto_recall(context: Context<EnableAutoRecall>) -> Result<()> {
    set_auto_recall_bit(&context.accounts.vault)
}

/// 在不改变原有金库字段和账户大小的前提下设置末尾功能位。
/// Set the trailing capability without changing existing vault fields or account size.
fn set_auto_recall_bit(vault: &Account<Vault>) -> Result<()> {
    let info = vault.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    require_eq!(
        data.len(),
        STRATEGY_VAULT_LEN,
        VaultError::InvalidStrategyAccounts
    );
    // 只设置自动收回位，保留其他位。
    // Set only the auto-recall bit, preserving other capabilities.
    data[STRATEGY_VAULT_LEN - 1] |= AUTO_RECALL_FLAG;
    Ok(())
}

/// 从已验证的金库读取自动收回功能位。旧纯现金布局没有功能位。
/// Read the auto-recall bit on a validated vault. The old cash-only layout has no capability byte.
pub(super) fn auto_recall_enabled(vault: &Account<Vault>) -> Result<bool> {
    let info = vault.to_account_info();
    let data = info.try_borrow_data()?;
    Ok(data.len() == STRATEGY_VAULT_LEN && data[STRATEGY_VAULT_LEN - 1] & AUTO_RECALL_FLAG != 0)
}

/// 计算给定交易前净值的基点上限，整数下限保留在原资金账户。
/// Compute a basis-point limit against pre-trade NAV, rounding down.
pub(super) fn bps_floor(nav: u64, bps: u16) -> u64 {
    (u128::from(nav) * u128::from(bps) / BPS_DENOMINATOR) as u64
}

/// 计算必要现金留存，向上取整避免实际余额低于配置的占比。
/// Compute mandatory cash retention, rounding up so actual cash meets the configured ratio.
pub(super) fn bps_ceil(nav: u64, bps: u16) -> u64 {
    (u128::from(nav) * u128::from(bps)).div_ceil(BPS_DENOMINATOR) as u64
}

/// 计算实时测试兑换金额，使用正的链上价格，以输出最小单位向下取整。
/// Quote the fixed test rate from a positive on-chain price, flooring in output base units.
fn swap_output(buy: bool, amount_in: u64, price: u64) -> Result<u64> {
    if buy {
        let quote = u128::from(amount_in) * STRATEGY_SCALE / u128::from(price);
        u64::try_from(quote).map_err(|_| error!(VaultError::StrategyValuationOverflow))
    } else {
        spot_value(amount_in, price)
    }
}

/// 以链上预言机的固定测试报价执行双向资产交换，签名的到账下限或账户不足即回滚。
/// Settle a two-way swap at the live test rate. A signed output floor or insufficient balances revert both transfers.
///
/// `amount_in` / `min_out` 按输入与输出各自 Mint 的最小单位计。
/// `amount_in` and `min_out` use the input and output mint's respective base units.
pub(super) fn swap(
    context: Context<StrategySwap>,
    buy: bool,
    amount_in: u64,
    min_out: u64,
) -> Result<()> {
    require!(
        amount_in > 0 && min_out > 0,
        VaultError::InvalidStrategyAmount
    );

    // 只读真实托管及借贷仓位计算额度。独立测试储备不计入净值。
    // Use actual vault custody and lending position for the limit. Exclude independent test reserves from NAV.
    let accounts = context.accounts;
    let vault = accounts.vault.key();
    let market = accounts.market.key();
    let price = read_price(market, &accounts.price.to_account_info())?;
    let pool = inspect_pool(
        market,
        vault,
        &accounts.supply_pool.to_account_info(),
        &accounts.supply_position.to_account_info(),
    )?;
    let position_value = pool.value()?;
    let nav = accounts
        .cash_vault
        .amount
        .checked_add(spot_value(accounts.strategy_custody.amount, price)?)
        .and_then(|cash_and_spot| cash_and_spot.checked_add(position_value))
        .ok_or(VaultError::StrategyValuationOverflow)?;

    // 卖出使用预计结算价值比较限额。买入使用实际支付的结算金额。
    // Compare the gross input cash on buys and expected cash proceeds on sells to the trade cap.
    let output = swap_output(buy, amount_in, price)?;
    require!(
        output > 0 && output >= min_out,
        VaultError::MinimumStrategyOutputNotMet
    );
    let value = if buy { amount_in } else { output };
    // 当正净值的比例上限不足一个最小单位时，依然允许卖出一个最小单位以逐步恢复现金。
    // A positive NAV with a sub-unit limit can still sell one cash base unit to restore liquidity.
    let proportional_limit = bps_floor(nav, accounts.strategy.max_trade_bps);
    let limit = if !buy && nav > 0 {
        proportional_limit.max(1)
    } else {
        proportional_limit
    };
    require!(value <= limit, VaultError::StrategyLimitExceeded);

    // 按方向交换来源与到账托管。两条腿都只能使用绑定给该策略的储备和金库账户。
    // Select each leg by direction. Both legs use only reserves and vault accounts bound to this strategy.
    let (asset_in, asset_out, reserve_in, reserve_out, input_mint, output_mint) = if buy {
        (
            &accounts.cash_vault,
            &accounts.strategy_custody,
            &accounts.swap_cash,
            &accounts.swap_strategy,
            &accounts.asset_mint,
            &accounts.strategy_mint,
        )
    } else {
        (
            &accounts.strategy_custody,
            &accounts.cash_vault,
            &accounts.swap_strategy,
            &accounts.swap_cash,
            &accounts.strategy_mint,
            &accounts.asset_mint,
        )
    };
    require!(
        asset_in.amount >= amount_in && reserve_out.amount >= output,
        VaultError::InsufficientStrategyLiquidity
    );

    // 金库签第一条腿，策略配置 PDA 签第二条腿。任一失败都会回滚此前的转账。
    // The vault signs the input leg and the strategy config PDA signs output. Either failure reverts earlier transfers.
    let vault_bump = [accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, &vault_bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                from: asset_in.to_account_info(),
                mint: input_mint.to_account_info(),
                to: reserve_in.to_account_info(),
                authority: accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        amount_in,
        input_mint.decimals,
    )?;

    let strategy_bump = [accounts.strategy.bump];
    let strategy_seeds: &[&[u8]] = &[STRATEGY_SEED, vault.as_ref(), &strategy_bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                from: reserve_out.to_account_info(),
                mint: output_mint.to_account_info(),
                to: asset_out.to_account_info(),
                authority: accounts.strategy.to_account_info(),
            },
            &[strategy_seeds],
        ),
        output,
        output_mint.decimals,
    )?;

    // 事件使用实际成交，而非前端或 manager 提交的报价。
    // Report executed amounts instead of any price submitted by the client or manager.
    emit!(VaultStrategyAction {
        vault,
        manager: accounts.manager.key(),
        kind: 0,
        input_mint: input_mint.key(),
        output_mint: output_mint.key(),
        input_raw: amount_in,
        output_raw: output,
    });
    Ok(())
}

/// 零估值现货清理凭证。没有结算资产到账，记录实际转入测试储备的数额。
/// Receipt for clearing zero-valued spot. Records the transfer into test reserves without any cash payout.
#[event]
pub struct VaultStrategyDustCleared {
    /// 受影响的金库 PDA。 Affected vault PDA.
    pub vault: Pubkey,
    /// 签名的策略管理者。 Signing strategy manager.
    pub manager: Pubkey,
    /// 转出的策略资产 Mint。 Mint of the spot asset transferred.
    pub strategy_mint: Pubkey,
    /// 转出的策略资产最小单位数。 Number of spot asset base units transferred.
    pub amount_raw: u64,
}

/// 将按有效预言机报价不足一个结算最小单位的整笔现货移回绑定的测试储备。
/// Return the entire spot balance to the bound test reserve only when a valid quote floors to zero cash.
///
/// 沿用兑换的账户约束，且不会从现金储备付款。没有尾仓、尾仓有价值或价格失效时拒绝。
/// Reuse swap account bindings without paying out of cash reserves. Reject no spot, positive value, or an invalid price.
pub(super) fn clear_dust(context: Context<StrategySwap>) -> Result<()> {
    // 金额只能是金库当前策略余额，不能由用户选择一笔本可变现仓位中的零头。
    // The amount is the full current spot balance, never a caller-selected fragment of valuable holdings.
    let accounts = context.accounts;
    let spot_amount = accounts.strategy_custody.amount;
    let price = read_price(accounts.market.key(), &accounts.price.to_account_info())?;
    require!(spot_amount > 0, VaultError::InvalidStrategyAmount);
    require!(
        spot_value(spot_amount, price)? == 0,
        VaultError::StrategyDustHasValue
    );

    // 金库 PDA 将余额转入规范测试储备。管理者无法传入自己的收款地址。
    // The vault PDA transfers to the canonical test reserve. The manager cannot choose a personal destination.
    let vault_bump = [accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, &vault_bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.strategy_custody.to_account_info(),
                mint: accounts.strategy_mint.to_account_info(),
                to: accounts.swap_strategy.to_account_info(),
                authority: accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        spot_amount,
        accounts.strategy_mint.decimals,
    )?;

    emit!(VaultStrategyDustCleared {
        vault: accounts.vault.key(),
        manager: accounts.manager.key(),
        strategy_mint: accounts.strategy_mint.key(),
        amount_raw: spot_amount,
    });
    Ok(())
}

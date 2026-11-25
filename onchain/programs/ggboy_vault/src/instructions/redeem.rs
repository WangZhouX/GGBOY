//! 金库的赎回账户约束、报价和现金结算。
//! Account constraints, pricing, and cash settlement for vault redemptions.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, TransferChecked};

use ggboy_lending::cpi;

use super::{strategy::auto_recall_enabled, strategy_lending::withdraw_cash};
use crate::{state::VAULT_SEED, strategy_valuation::vault_valuation, Vault, VaultError};

/// 已启用策略的金库使用六个估值账户，支持自动收回的赎回追加三个账户。
/// Strategy vaults use six valuation accounts. Redemption with automatic recall appends three accounts.
const VALUATION_ACCOUNT_COUNT: usize = 6;
const RECALL_ACCOUNT_COUNT: usize = VALUATION_ACCOUNT_COUNT + 3;

/// 赎回所需的账户，托管、份额和投资者余额均使用经典 SPL Token。
/// Accounts for redemption. Custody, shares, and investor balances use classic SPL Token.
#[derive(Accounts)]
pub struct Redeem<'info> {
    /// 授权销毁自己的份额并拥有结算资产收款账户的投资者签名人。
    /// Investor signer authorizing the burn and owning the settlement destination.
    pub investor: Signer<'info>,

    /// 已初始化的金库 PDA，限制两种 Mint 和托管账户为初始化时绑定的地址。
    /// Initialized vault PDA restricting both mints and custody to the bound addresses.
    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
        has_one = asset_mint,
        has_one = cash_vault,
        has_one = share_mint,
    )]
    pub vault: Account<'info, Vault>,

    /// 金库配置的 mockUSDC Mint，支付时按其链上精度检查转账。
    /// Configured mockUSDC mint whose on-chain decimals are checked during payment.
    pub asset_mint: Account<'info, Mint>,

    /// 金库 PDA 控制的现金账户，赎回前余额计入净值，也是收回和支付的结算账户。
    /// Vault-controlled cash whose prior balance contributes to NAV and settles recall and payout.
    #[account(mut, token::mint = asset_mint, token::authority = vault)]
    pub cash_vault: Account<'info, TokenAccount>,

    /// 金库 PDA 具有铸造权限的 GG-V Mint，读取原总量并扣除被销毁的份额。
    /// GG-V mint under vault mint authority, read before burning and debited by the burn.
    #[account(mut, mint::authority = vault)]
    pub share_mint: Account<'info, Mint>,

    /// 已存在并由投资者拥有的 mockUSDC 收款账户。
    /// Existing investor-owned mockUSDC payout account.
    #[account(mut, token::mint = asset_mint, token::authority = investor)]
    pub investor_asset: Account<'info, TokenAccount>,

    /// 已存在并由投资者拥有的 GG-V 份额来源账户。
    /// Existing investor-owned GG-V source account for the burn.
    #[account(mut, token::mint = share_mint, token::authority = investor)]
    pub investor_shares: Account<'info, TokenAccount>,

    /// 执行份额销毁和结算资产转账的经典 SPL Token 程序。
    /// Classic SPL Token program executing the share burn and settlement transfer.
    pub token_program: Program<'info, Token>,
}

/// 成功赎回的实际销毁和到账数据，供交易索引器读取。
/// Executed burn and payout details for the transaction indexer.
#[event]
pub struct VaultRedeem {
    /// 处理赎回的金库 PDA 公钥。
    /// Public key of the vault PDA processing the redemption.
    pub vault: Pubkey,
    /// 签名、销毁份额并收款的投资者公钥。
    /// Public key of the investor who signed, burned shares, and received payment.
    pub investor: Pubkey,
    /// 实际付出的 mockUSDC Mint 公钥。
    /// Public key of the mockUSDC mint paid out.
    pub asset_mint: Pubkey,
    /// 实际被销毁的 GG-V Mint 公钥。
    /// Public key of the GG-V mint whose shares were burned.
    pub share_mint: Pubkey,
    /// 已销毁的 GG-V 最小单位数。
    /// Number of GG-V base units burned.
    pub shares_in: u64,
    /// 到账的 mockUSDC 最小单位数。
    /// Number of mockUSDC base units paid out.
    pub assets_out: u64,
}

/// 先校验赎回报价，再原子地销毁份额和付款。
/// Validate the quote, then atomically burn shares and pay the redemption.
///
/// `context` 提供已校验的账户，`shares_in` 是 GG-V 最小单位数，
/// `min_assets_out` 是投资者接受的最低 mockUSDC 最小单位数。
/// `context` supplies validated accounts, `shares_in` is in GG-V base units,
/// and `min_assets_out` is the minimum acceptable payout in mockUSDC base units.
pub(crate) fn handle<'info>(
    context: Context<'info, Redeem<'info>>,
    shares_in: u64,
    min_assets_out: u64,
) -> Result<()> {
    // 要求明确的赎回数量和正数到账下限。
    // Require explicit positive values for the share input and minimum payout.
    require_gt!(shares_in, 0, VaultError::InvalidRedeemAmount);
    require_gt!(min_assets_out, 0, VaultError::InvalidMinimumAssetsOut);

    // 在销毁份额前读取链上余额和 Mint 供给，单位均为各自代币的最小单位。
    // Read on-chain cash and mint supply in their respective base units before burning.
    let accounts = context.accounts;
    let cash_before = accounts.cash_vault.amount;
    let supply_before = accounts.share_mint.supply;
    require_gt!(supply_before, 0, VaultError::InvalidRedemptionPricingState);
    require_gte!(
        accounts.investor_shares.amount,
        shares_in,
        VaultError::InsufficientRedeemShares
    );
    require_gte!(
        supply_before,
        shares_in,
        VaultError::InvalidRedemptionPricingState
    );
    // 旧客户端仍可传现金赎回的六个策略估值账户。新版的附加账户只用于收回。
    // Existing clients can still pass the six strategy valuation accounts for cash redemption. Only recall uses the extra accounts.
    let remaining = context.remaining_accounts;
    let has_recall_accounts =
        remaining.len() == RECALL_ACCOUNT_COUNT && auto_recall_enabled(&accounts.vault)?;
    let valuation_accounts = if has_recall_accounts {
        &remaining[..VALUATION_ACCOUNT_COUNT]
    } else {
        remaining
    };
    let valuation = vault_valuation(&accounts.vault, cash_before, valuation_accounts)?;
    let final_exit = shares_in == supply_before;

    // 最后一笔必须清空现货，并在有出借份额时准备同笔完整收回。
    // A final exit needs zero spot inventory and must allow a complete same-transaction recall if lending shares remain.
    require!(
        !final_exit
            || (valuation.spot_raw == 0 && (valuation.pool.shares == 0 || has_recall_accounts)),
        VaultError::StrategyPositionsRemain
    );

    // 总份额约束保证报价不超过 u64 净值。后续收回仅提供现金，不会重新定价投资者应得金额。
    // The share bound caps the quote at u64 NAV. Recall provides cash without repricing the investor's proceeds.
    let assets_out =
        (u128::from(shares_in) * u128::from(valuation.nav) / u128::from(supply_before)) as u64;
    require_gt!(assets_out, 0, VaultError::ZeroAssetsOut);
    require_gte!(
        assets_out,
        min_assets_out,
        VaultError::MinimumAssetsOutNotMet
    );

    // 不足部分按最小池份额补足。最后一笔销毁则提取金库全部池份额。
    // Cover the shortfall with the smallest pool share amount. A final exit withdraws the entire lending position.
    let shortfall = assets_out.saturating_sub(cash_before);
    let pool_shares = if final_exit {
        valuation.pool.shares
    } else if shortfall > 0 {
        valuation.pool.shares_for_cash(shortfall)?
    } else {
        0
    };
    if pool_shares > 0 {
        require!(has_recall_accounts, VaultError::InsufficientVaultCash);
        // 最终退出时，借贷程序也允许完整注销零价值仓位。没有代币转账或现金回执。
        // On final exit, lending also permits retiring an entire zero-value position without a token transfer or a cash receipt.
        recall_for_redemption(accounts, remaining, pool_shares, shortfall)?;
    }
    require_gte!(
        accounts.cash_vault.amount,
        assets_out,
        VaultError::InsufficientVaultCash
    );

    // 只有份额来源账户的投资者签名能授权本次销毁。
    // The investor signing for the share source authorizes the burn.
    token::burn(
        CpiContext::new(
            accounts.token_program.key(),
            Burn {
                mint: accounts.share_mint.to_account_info(),
                from: accounts.investor_shares.to_account_info(),
                authority: accounts.investor.to_account_info(),
            },
        ),
        shares_in,
    )?;

    // 用初始化时保存的 bump 派生金库签名种子。支付失败会连同上面的销毁一起回滚。
    // Derive vault signer seeds with the stored bump. A failed payment also rolls back the burn.
    let vault_bump = [accounts.vault.bump];
    let vault_signer_seeds: &[&[u8]] = &[VAULT_SEED, &vault_bump];
    token::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.cash_vault.to_account_info(),
                mint: accounts.asset_mint.to_account_info(),
                to: accounts.investor_asset.to_account_info(),
                authority: accounts.vault.to_account_info(),
            },
        )
        .with_signer(&[vault_signer_seeds]),
        assets_out,
        accounts.asset_mint.decimals,
    )?;

    // 只在销毁和支付都成功后记录成交数据。
    // Emit executed amounts only after both burn and payment succeed.
    emit!(VaultRedeem {
        vault: accounts.vault.key(),
        investor: accounts.investor.key(),
        asset_mint: accounts.asset_mint.key(),
        share_mint: accounts.share_mint.key(),
        shares_in,
        assets_out,
    });
    Ok(())
}

/// 赎回时以金库 PDA 为出借者取回现金，不转移任何资产到投资者的任意收款账户。
/// Recall cash with the vault PDA as supplier, crediting only its canonical cash account.
///
/// `remaining` 的六个估值账户已经过校验，新增账户由借贷 CPI 验证。调用后重读实际余额。
/// The first six remaining accounts have passed valuation checks. Lending validates the additional accounts, and cash is reloaded.
/// `pool_shares` 和 `shortfall` 分别为池份额和结算资产的最小单位。
/// `pool_shares` and `shortfall` are pool share and settlement base units respectively.
fn recall_for_redemption<'info>(
    accounts: &mut Redeem<'info>,
    remaining: &[AccountInfo<'info>],
    pool_shares: u64,
    shortfall: u64,
) -> Result<()> {
    let [_, _, market, _, supply_pool, supply_position, lending_cash, borrow_market, lending_program] =
        remaining
    else {
        return err!(VaultError::InvalidStrategyAccounts);
    };
    require_keys_eq!(
        *lending_program.key,
        ggboy_lending::ID,
        VaultError::InvalidStrategyAccounts
    );
    require!(
        lending_program.executable
            && supply_pool.is_writable
            && supply_position.is_writable
            && lending_cash.is_writable,
        VaultError::InvalidStrategyAccounts
    );

    // 借贷程序在同笔 CPI 中校验实际现金和扣除未偿债务后的账面现金。失败时尚未销毁投资者份额。
    // Lending checks actual custody and accounted cash net of debt inside the CPI. The investor's shares are still intact if it fails.
    withdraw_cash(
        cpi::accounts::WithdrawSupply {
            supplier: accounts.vault.to_account_info(),
            market: market.clone(),
            debt_mint: accounts.asset_mint.to_account_info(),
            cash_vault: lending_cash.clone(),
            destination: accounts.cash_vault.to_account_info(),
            supply_pool: supply_pool.clone(),
            supply_position: supply_position.clone(),
            borrow_market: borrow_market.clone(),
            token_program: accounts.token_program.to_account_info(),
        },
        accounts.vault.bump,
        pool_shares,
        shortfall,
    )?;
    accounts.cash_vault.reload()
}

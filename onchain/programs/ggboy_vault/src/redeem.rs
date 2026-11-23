//! 纯现金金库的赎回账户约束、报价和代币结算。
//! Account constraints, pricing, and token settlement for cash-only vault redemptions.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, TransferChecked};

use crate::{state::VAULT_SEED, Vault, VaultError};

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

    /// 金库 PDA 控制的现金账户，赎回前的余额是定价和支付上限的依据。
    /// Vault-controlled cash account whose prior balance prices and caps the payout.
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
pub(super) fn handle(context: Context<Redeem>, shares_in: u64, min_assets_out: u64) -> Result<()> {
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
    require_gt!(cash_before, 0, VaultError::InsufficientVaultCash);

    // 净值等于托管现金。两个 u64 的乘积可放进 u128，整数除法向下取整。
    // NAV equals custody cash. The product of two u64 amounts fits u128, and division rounds down.
    let quoted_assets = u128::from(shares_in) * u128::from(cash_before) / u128::from(supply_before);
    // 以现金余额为上限，确认报价既能付款也能安全转换成 SPL 代币的 u64 数量。
    // Cap the quote at available cash, ensuring it is payable and safely fits the SPL u64 amount.
    require_gte!(
        u128::from(cash_before),
        quoted_assets,
        VaultError::InsufficientVaultCash
    );
    let assets_out = quoted_assets as u64;
    require_gt!(assets_out, 0, VaultError::ZeroAssetsOut);
    require_gte!(
        assets_out,
        min_assets_out,
        VaultError::MinimumAssetsOutNotMet
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

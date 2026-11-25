//! 金库的存入账户约束、份额计算和代币结算。
//! Account constraints, share pricing, and token settlement for vault deposits.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked};

use crate::{state::VAULT_SEED, strategy_valuation::vault_valuation, Vault, VaultError};

/// 存入所需的金库账户和投资者账户，全部代币账户使用经典 SPL Token。
/// Vault and investor accounts for a deposit. All token accounts use classic SPL Token.
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// 授权扣款且持有接收份额账户的投资者签名人。
    /// Investor signer authorizing the debit and owning the share destination.
    pub investor: Signer<'info>,

    /// 已初始化的金库 PDA，绑定本笔交易可使用的资产、托管账户和份额 Mint。
    /// Initialized vault PDA binding the asset, custody account, and share mint used in this deposit.
    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
        has_one = asset_mint,
        has_one = cash_vault,
        has_one = share_mint,
    )]
    pub vault: Account<'info, Vault>,

    /// 配置中的 mockUSDC Mint，为转账提供绑定地址及小数位数。
    /// Configured mockUSDC mint supplying the bound address and decimals for the transfer.
    pub asset_mint: Account<'info, Mint>,

    /// 金库控制的结算资产账户，存入前余额计入净值，存入后接收资金。
    /// Vault-controlled settlement account whose pre-deposit balance contributes to NAV and receives the funds.
    #[account(mut, token::mint = asset_mint, token::authority = vault)]
    pub cash_vault: Account<'info, TokenAccount>,

    /// 金库拥有铸造权的 GG-V Mint，读取操作前总供给并增加实际铸造量。
    /// GG-V mint authorized by the vault, supplying the prior total supply and recording newly minted shares.
    #[account(mut, mint::authority = vault)]
    pub share_mint: Account<'info, Mint>,

    /// 已存在并由投资者拥有的 mockUSDC 扣款账户。
    /// Existing investor-owned mockUSDC source account.
    #[account(mut, token::mint = asset_mint, token::authority = investor)]
    pub investor_asset: Account<'info, TokenAccount>,

    /// 已存在并由投资者拥有的 GG-V 到账账户。
    /// Existing investor-owned GG-V destination account.
    #[account(mut, token::mint = share_mint, token::authority = investor)]
    pub investor_shares: Account<'info, TokenAccount>,

    /// 执行实际转账与铸造的经典 SPL Token 程序。
    /// Classic SPL Token program executing the transfer and mint.
    pub token_program: Program<'info, Token>,
}

/// 成功存入后供交易索引器读取的实际成交数据。
/// Executed deposit details for the transaction indexer.
#[event]
pub struct VaultDeposit {
    /// 处理存入的金库 PDA 公钥。
    /// Public key of the vault PDA processing the deposit.
    pub vault: Pubkey,
    /// 签名并收取份额的投资者公钥。
    /// Public key of the investor who signed and received shares.
    pub investor: Pubkey,
    /// 实际转入的结算资产 Mint 公钥。
    /// Public key of the settlement mint transferred into the vault.
    pub asset_mint: Pubkey,
    /// 实际铸造的 GG-V 份额 Mint 公钥。
    /// Public key of the GG-V share mint issued by the deposit.
    pub share_mint: Pubkey,
    /// 实际转入金库的 mockUSDC 最小单位数。
    /// Number of mockUSDC base units transferred into custody.
    pub assets_in: u64,
    /// 实际到账的 GG-V 最小单位数。
    /// Number of GG-V base units minted to the investor.
    pub shares_out: u64,
}

/// 校验报价和余额，原子地结算存入并发出事件。
/// Validate pricing and balances, settle the deposit atomically, and emit an event.
///
/// `context` 是已校验的账户，`assets_in` 为存入的 mockUSDC 最小单位数，
/// `min_shares_out` 为投资者接受的最低 GG-V 最小单位数。
/// `context` supplies validated accounts, `assets_in` is in mockUSDC base units,
/// and `min_shares_out` is the investor's minimum in GG-V base units.
pub(super) fn handle(context: Context<Deposit>, assets_in: u64, min_shares_out: u64) -> Result<()> {
    // 零金额和零到账下限都不构成有效存入请求。
    // A zero deposit amount or a zero minimum does not constitute a valid request.
    require_gt!(assets_in, 0, VaultError::InvalidDepositAmount);
    require_gt!(min_shares_out, 0, VaultError::InvalidMinimumSharesOut);

    // 读取已通过 Anchor 约束的账户，在任何代币 CPI 前取得链上报价输入。
    // Use the validated accounts to read live pricing inputs before any token CPI.
    let accounts = context.accounts;
    require_gte!(
        accounts.investor_asset.amount,
        assets_in,
        VaultError::InsufficientDepositBalance
    );
    // 存入前的净值与 Mint 供给量决定实际 GG-V 报价。策略配置已激活时需要完整报价账户。
    // Pre-deposit NAV and mint supply determine the GG-V quote. An active strategy requires every valuation account.
    let valuation = vault_valuation(
        &accounts.vault,
        accounts.cash_vault.amount,
        context.remaining_accounts,
    )?;
    let shares_out = calculate_shares(assets_in, valuation.nav, accounts.share_mint.supply)?;
    require_gt!(shares_out, 0, VaultError::ZeroSharesOut);
    require_gte!(
        shares_out,
        min_shares_out,
        VaultError::MinimumSharesOutNotMet
    );

    // 用投资者签名扣款，并让 SPL Token 复核结算 Mint 和精度。
    // Debit under the investor's signature and let SPL Token check the settlement mint and decimals.
    token::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.investor_asset.to_account_info(),
                mint: accounts.asset_mint.to_account_info(),
                to: accounts.cash_vault.to_account_info(),
                authority: accounts.investor.to_account_info(),
            },
        ),
        assets_in,
        accounts.asset_mint.decimals,
    )?;

    // 复用初始化时保存的 bump，为铸造 CPI 提供金库 PDA 的签名种子。
    // Reuse the bump saved at initialization to sign the mint CPI as the vault PDA.
    let vault_bump = [accounts.vault.bump];
    let vault_signer_seeds: &[&[u8]] = &[VAULT_SEED, &vault_bump];
    token::mint_to(
        CpiContext::new(
            accounts.token_program.key(),
            MintTo {
                mint: accounts.share_mint.to_account_info(),
                to: accounts.investor_shares.to_account_info(),
                authority: accounts.vault.to_account_info(),
            },
        )
        .with_signer(&[vault_signer_seeds]),
        shares_out,
    )?;

    // 仅在转账和铸造均成功后记录成交数量。
    // Record executed amounts only after the transfer and mint both succeed.
    emit!(VaultDeposit {
        vault: accounts.vault.key(),
        investor: accounts.investor.key(),
        asset_mint: accounts.asset_mint.key(),
        share_mint: accounts.share_mint.key(),
        assets_in,
        shares_out,
    });
    Ok(())
}

/// 以金库存入前的净值计算待铸造份额，输出向下取整。
/// Calculate shares from the vault's pre-deposit NAV, rounding down.
///
/// `assets_in` 和 `nav_before` 为 mockUSDC 最小单位数，`supply_before` 和结果为 GG-V 最小单位数。
/// `assets_in` and `nav_before` use mockUSDC base units. `supply_before` and the result use GG-V base units.
/// 单边为零或结果超出 SPL Token 数量范围时返回业务错误。
/// Return a business error when only one balance is zero or the result exceeds the SPL Token amount range.
fn calculate_shares(assets_in: u64, nav_before: u64, supply_before: u64) -> Result<u64> {
    match (nav_before, supply_before) {
        // 两种代币均为六位小数，空金库可直接按最小单位 1:1 铸造。
        // Both tokens have six decimals, so an empty vault issues shares 1:1 in base units.
        (0, 0) => Ok(assets_in),
        // 有资产却没有份额，或有份额却没有资产时，无法按占比定价。
        // An assets-only or shares-only state has no valid proportional price.
        (0, _) | (_, 0) => err!(VaultError::InvalidVaultPricingState),
        _ => {
            // 两个 u64 的乘积可完整放入 u128。整数除法保留向下取整。
            // The product of two u64 values fits in u128. Integer division rounds down.
            let numerator = u128::from(assets_in) * u128::from(supply_before);
            u64::try_from(numerator / u128::from(nav_before))
                .map_err(|_| error!(VaultError::DepositSharesOverflow))
        }
    }
}

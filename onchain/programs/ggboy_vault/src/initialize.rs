//! 金库初始化的账户约束及状态写入。
//! Account constraints and state persistence for vault initialization.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{program::GgboyVault, state::VAULT_SEED, Vault, VaultError};

/// 现金托管账户的种子前缀，后接金库地址。
/// Cash custody account seed prefix, followed by the vault address.
const CASH_VAULT_SEED: &[u8] = b"cash_vault";

/// 份额 Mint 的种子前缀，后接金库地址。
/// Share mint seed prefix, followed by the vault address.
const SHARE_MINT_SEED: &[u8] = b"share_mint";

/// 首版结算资产与份额的精度，单位为小数位数。
/// Decimal precision of both the settlement asset and shares in the first version.
const TOKEN_DECIMALS: u8 = 6;

/// 创建金库所需的签名人、程序和代币账户。
/// Signer, program, and token accounts required to create a vault.
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// 管理员签名并支付三个新账户的免租金余额，单位为 lamports。
    /// Administrator signs and funds the rent-exempt balance of all three new accounts, in lamports.
    #[account(mut)]
    pub administrator: Signer<'info>,

    /// 当前部署的金库程序，Anchor 校验其地址和可执行状态。
    /// The deployed vault program, with its address and executable status checked by Anchor.
    pub vault_program: Program<'info, GgboyVault>,

    /// 从当前程序的 ProgramData 读取升级权限，防止借用其他程序的权限。
    /// Read upgrade authority from this program's ProgramData to bind initialization to this deployment.
    #[account(
        constraint = vault_program.programdata_address()? == Some(program_data.key())
            @ VaultError::InvalidProgramData,
        constraint = program_data.upgrade_authority_address == Some(administrator.key())
            @ VaultError::UnauthorizedAdministrator,
    )]
    pub program_data: Account<'info, ProgramData>,

    /// 管理员选定的经典 SPL 结算 Mint。Anchor 校验归属及初始化状态。
    /// Classic SPL settlement mint selected by the administrator. Anchor checks its owner and initialized state.
    #[account(constraint = asset_mint.decimals == TOKEN_DECIMALS @ VaultError::InvalidAssetDecimals)]
    pub asset_mint: Account<'info, Mint>,

    /// 金库状态和代币操作的授权地址。单次创建防止覆盖已有配置。
    /// Vault state and token authority. One-time creation protects the existing configuration.
    #[account(
        init,
        payer = administrator,
        space = Vault::DISCRIMINATOR.len() + Vault::INIT_SPACE,
        seeds = [VAULT_SEED],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    /// 新建的空现金账户，绑定结算 Mint 并由金库 PDA 授权。
    /// New empty cash account bound to the settlement mint and controlled by the vault PDA.
    #[account(
        init,
        payer = administrator,
        seeds = [CASH_VAULT_SEED, vault.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub cash_vault: Account<'info, TokenAccount>,

    /// 新建的六位小数份额 Mint。初始供给为零，无冻结权限。
    /// New six-decimal share mint with zero initial supply and no freeze authority.
    #[account(
        init,
        payer = administrator,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = vault,
        mint::token_program = token_program,
    )]
    pub share_mint: Account<'info, Mint>,

    /// 执行托管账户及份额 Mint 初始化的经典 SPL Token 程序。
    /// Classic SPL Token program that initializes the custody account and share mint.
    pub token_program: Program<'info, Token>,

    /// 为三个新账户分配链上空间及免租金余额的系统程序。
    /// System program that allocates space and rent-exempt balances for the new accounts.
    pub system_program: Program<'info, System>,
}

/// 将已校验的账户绑定和规范 PDA bump 保存到新金库。
/// Persist the validated account bindings and canonical PDA bump in the new vault.
///
/// `context` 由 Anchor 校验并初始化，成功后 Anchor 将配置写入链上。
/// Anchor validates and initializes `context`, then writes the configuration on success.
pub(super) fn handle(context: Context<InitializeVault>) -> Result<()> {
    // 现金余额和已发行份额保存在 SPL 账户中，金库状态只保存绑定关系。
    // SPL accounts hold cash and supply. The vault state stores account bindings.
    context.accounts.vault.set_inner(Vault {
        administrator: context.accounts.administrator.key(),
        asset_mint: context.accounts.asset_mint.key(),
        cash_vault: context.accounts.cash_vault.key(),
        share_mint: context.accounts.share_mint.key(),
        bump: context.bumps.vault,
    });

    Ok(())
}

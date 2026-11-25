//! 市场配置、资产托管地址及其 PDA 种子。
//! Market configuration, asset custody addresses, and their PDA seeds.

use anchor_lang::prelude::*;

/// 市场状态种子，首版每个程序部署只有一个市场。
/// Market state seed. The first version has one market per deployment.
pub(crate) const MARKET_SEED: &[u8] = b"lending_market";

/// 借款资金池 PDA 的种子前缀，后接市场状态公钥。
/// Cash custody PDA seed prefix, followed by the market state public key.
pub(crate) const CASH_VAULT_SEED: &[u8] = b"cash_vault";

/// 抵押品托管 PDA 的种子前缀，后接市场状态公钥。
/// Collateral custody PDA seed prefix, followed by the market state public key.
pub(crate) const COLLATERAL_VAULT_SEED: &[u8] = b"collateral_vault";

/// 保存市场管理员、代币 Mint 绑定和两个托管账户的公钥。
/// Stores the market administrator, token mint bindings, and both custody account addresses.
#[account]
#[derive(InitSpace)]
pub struct LendingMarket {
    /// 初始化时持有程序升级权限的管理员公钥。
    /// Public key of the administrator holding program upgrade authority at initialization.
    pub administrator: Pubkey,

    /// 借款资金池使用的六位小数 mockUSDC Mint 公钥。
    /// Public key of the six-decimal mockUSDC mint used by the cash pool.
    pub debt_mint: Pubkey,

    /// 抵押资产的 Mint 公钥，金额按该 Mint 自身的精度解析。
    /// Collateral mint public key. Collateral amounts use this mint's decimal precision.
    pub collateral_mint: Pubkey,

    /// 与借款 Mint 绑定、由市场 PDA 授权的 SPL 资金池公钥。
    /// SPL cash custody public key bound to the debt mint and controlled by the market PDA.
    pub cash_vault: Pubkey,

    /// 与抵押 Mint 绑定、由市场 PDA 授权的 SPL 抵押托管公钥。
    /// SPL collateral custody public key bound to the collateral mint and controlled by the market PDA.
    pub collateral_vault: Pubkey,

    /// Anchor 派生的规范 bump，供后续市场 PDA 签名使用。
    /// Canonical bump derived by Anchor for future market PDA signing.
    pub bump: u8,
}

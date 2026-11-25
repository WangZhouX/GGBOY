//! 策略金库持久化状态。
//! Persistent strategy vault state.

use anchor_lang::prelude::*;

/// 固定种子，保证每个部署只有一个金库状态地址。
/// Fixed seed that gives each deployment one vault state address.
pub(crate) const VAULT_SEED: &[u8] = b"vault";

/// 策略启用后保留原始布局并追加一字节，旧账户以原始长度继续运行。
/// Strategy activation appends one byte without shifting the old layout. Old-length accounts keep running.
pub(crate) const STRATEGY_VAULT_LEN: usize = Vault::DISCRIMINATOR.len() + Vault::INIT_SPACE + 1;

/// 记录单个金库的管理员、资产账户绑定和授权 PDA 参数。
/// Stores the singleton vault administrator, asset account bindings, and authority PDA parameter.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// 初始化时签名的管理员钱包公钥。
    /// Public key of the administrator who signed initialization.
    pub administrator: Pubkey,

    /// 初始化时绑定的六位小数结算资产 Mint 公钥。
    /// Public key of the six-decimal settlement mint bound during initialization.
    pub asset_mint: Pubkey,

    /// 金库 PDA 控制的现金托管账户公钥。
    /// Public key of the cash custody account controlled by the vault PDA.
    pub cash_vault: Pubkey,

    /// 金库 PDA 独占铸造权的 GG-V 份额 Mint 公钥。
    /// Public key of the GG-V mint whose mint authority is the vault PDA.
    pub share_mint: Pubkey,

    /// Anchor 派生的规范 bump，后续用于授权金库 PDA 的代币操作。
    /// Canonical bump derived by Anchor for future vault PDA token operations.
    pub bump: u8,
}

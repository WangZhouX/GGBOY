//! 出借池总账、钱包出借仓位及其 PDA 种子。
//! Supply pool accounting, wallet supply positions, and their PDA seeds.

use anchor_lang::prelude::*;

/// 出借池记账 PDA 种子，后接所属市场地址。
/// Supply pool accounting PDA seed, followed by its market address.
pub(crate) const SUPPLY_POOL_SEED: &[u8] = b"supply_pool";

/// 出借仓位 PDA 种子，后接市场地址与出借人公钥。
/// Supply position PDA seed, followed by the market address and supplier public key.
pub(crate) const SUPPLY_POSITION_SEED: &[u8] = b"supply_position";

/// 单一市场出借的资产与总份额，独立记账以沿用初始化时的市场布局。
/// Supplied assets and total shares of one market, stored separately to preserve the initialized market layout.
#[account]
#[derive(InitSpace)]
pub struct SupplyPool {
    /// 所属借贷市场的 PDA 公钥。
    /// Public key of the lending market PDA.
    pub market: Pubkey,

    /// 通过出借指令确认的借款资产，以六位小数的借款 Mint 最小单位记账。
    /// Debt assets recognized by the supply instruction in base units of the six-decimal debt mint.
    pub accounted_assets_raw: u64,

    /// 全部钱包出借份额合计，以六位小数份额最小单位计。
    /// Total shares across all suppliers, in six-decimal share base units.
    pub total_shares_raw: u64,
}

/// 指定市场与出借人的非转让份额记录。
/// Nontransferable share record for a market and supplier pair.
#[account]
#[derive(InitSpace)]
pub struct SupplyPosition {
    /// 此仓位所属市场的 PDA 公钥。
    /// Public key of the market PDA for this position.
    pub market: Pubkey,

    /// 发起出借、拥有份额的签名钱包公钥。
    /// Public key of the signing wallet that supplies assets and owns the shares.
    pub supplier: Pubkey,

    /// 该签名钱包持有的六位小数出借份额最小单位数。
    /// Wallet shares in six-decimal base units.
    pub shares_raw: u64,
}

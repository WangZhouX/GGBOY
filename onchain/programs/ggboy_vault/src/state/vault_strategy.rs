//! 策略配置的持久化账户和账户种子。
//! Persistent strategy configuration and its account seeds.

use anchor_lang::prelude::*;

/// 策略配置及持仓托管账户的 PDA 种子。
/// PDA seeds for strategy configuration and spot custody.
pub(crate) const STRATEGY_SEED: &[u8] = b"strategy";
pub(crate) const STRATEGY_CUSTODY_SEED: &[u8] = b"strategy_custody";

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

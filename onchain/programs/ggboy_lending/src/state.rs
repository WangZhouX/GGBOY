//! 抵押借贷市场的持久化状态和 PDA 种子。
//! Persistent lending market state and PDA seeds.

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

/// 借款总账 PDA 种子，后接市场地址。
/// Borrowing ledger PDA seed, followed by the market address.
pub(crate) const BORROW_MARKET_SEED: &[u8] = b"borrow_market";

/// 个人抵押和债务 PDA 种子，后接市场地址与借款人公钥。
/// Collateral and debt position PDA seed, followed by the market and borrower public keys.
pub(crate) const BORROW_POSITION_SEED: &[u8] = b"borrow_position";

/// 市场测试预言机 PDA 种子，后接市场地址。
/// Market test oracle PDA seed, followed by the market address.
pub(crate) const MOCK_COLLATERAL_PRICE_SEED: &[u8] = b"mock_collateral_price";

/// 独立的市场借款总账，首次借款创建，沿用原市场和出借池的账户布局。
/// Separate market debt ledger created by the first borrow, preserving existing market and supply layouts.
#[account]
#[derive(InitSpace)]
pub struct BorrowMarket {
    /// 此借款总账所属的市场公钥。
    /// Public key of the market that owns this borrowing ledger.
    pub market: Pubkey,

    /// 全市场仍欠的本金，以六位小数借款 Mint 最小单位记录。
    /// Outstanding principal across the market, in base units of the six-decimal debt mint.
    pub total_debt_raw: u64,
}

/// 一个钱包在此借贷市场的抵押品余额和未偿本金。
/// Locked collateral and outstanding principal for one wallet in this market.
#[account]
#[derive(InitSpace)]
pub struct BorrowPosition {
    /// 此仓位所属的市场公钥。
    /// Public key of the market that owns this position.
    pub market: Pubkey,

    /// 可以操作仓位的签名钱包。
    /// Wallet authorized to sign operations against this position.
    pub borrower: Pubkey,

    /// 已锁定的抵押品，按抵押 Mint 最小单位记录。
    /// Locked collateral in collateral mint base units.
    pub collateral_raw: u64,

    /// 当前未偿还的本金，按六位小数借款 Mint 最小单位记录。
    /// Outstanding principal in base units of the six-decimal debt mint.
    pub debt_raw: u64,
}

/// 由市场管理员写入的测试价格，价格比较在链上执行。
/// Test price written by the market administrator and checked on-chain.
#[account]
#[derive(InitSpace)]
pub struct MockCollateralPrice {
    /// 此预言机所属的市场公钥。
    /// Public key of the market that owns this oracle.
    pub market: Pubkey,

    /// 1 整单位抵押品对应的六位小数借款 Mint 最小单位数。
    /// Debt mint base units per whole unit of collateral, using the six-decimal debt mint.
    pub price_raw: u64,

    /// 链上 Clock 给出的价格发布时间，以 Unix 秒记录。
    /// Publication time in Unix seconds from the on-chain Clock.
    pub published_at: i64,
}

/// 已生效的借款仓位操作与操作后的余额，供回执及历史读取。
/// Executed borrowing action and resulting balances for receipts and history.
#[event]
pub struct LendingBorrowAction {
    /// 本次操作的市场状态公钥。
    /// Market state public key for this action.
    pub market: Pubkey,
    /// 签名借款人公钥。
    /// Public key of the signing borrower.
    pub borrower: Pubkey,
    /// 0 追加抵押品，1 借款，2 还款，3 取回抵押品。
    /// 0 deposits collateral, 1 borrows, 2 repays, and 3 withdraws collateral.
    pub kind: u8,
    /// 实际转移的抵押或借款资产最小单位数，由 kind 决定使用的 Mint。
    /// Base units of assets actually transferred, with the mint determined by kind.
    pub amount_raw: u64,
    /// 操作后已锁定的抵押 Mint 最小单位数。
    /// Collateral mint base units locked after this action.
    pub collateral_raw: u64,
    /// 操作后剩余的借款 Mint 本金最小单位数。
    /// Outstanding principal in debt mint base units after this action.
    pub debt_raw: u64,
}

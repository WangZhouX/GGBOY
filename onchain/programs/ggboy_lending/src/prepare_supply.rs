//! 为出借池和签名人的仓位分配免租金账户。
//! Allocate rent-exempt accounts for the supply pool and the signer's position.

use anchor_lang::prelude::*;

use crate::{
    interest,
    state::{MARKET_SEED, SUPPLY_POOL_SEED, SUPPLY_POSITION_SEED},
    LendingError, LendingMarket, SupplyPool, SupplyPosition,
};

/// 由单独付款人为签名出借人创建规范的出借账户。
/// Canonical supply accounts for a signing supplier with a separate rent payer.
#[derive(Accounts)]
pub struct PrepareSupply<'info> {
    /// 为尚不存在的 PDA 支付免租金余额的签名账户。
    /// Signing account that funds the rent-exempt balance for missing PDAs.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// 拥有出借份额的签名账户，可以由调用程序为自己的 PDA 签名。
    /// Signing owner of supply shares, including a PDA signed for by the calling program.
    pub supplier: Signer<'info>,

    /// 本程序部署已初始化的规范市场 PDA。
    /// Initialized canonical market PDA of this program deployment.
    #[account(seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, LendingMarket>,

    /// 市场的份额总账；存在时沿用原资产值和总份额。
    /// Market-wide supply ledger. Preserve the asset value and total shares when it exists.
    #[account(
        init_if_needed,
        payer = payer,
        space = interest::supply_pool_space(supply_pool.data_len()),
        seeds = [SUPPLY_POOL_SEED, market.key().as_ref()],
        bump,
    )]
    pub supply_pool: Account<'info, SupplyPool>,

    /// 归属于签名出借人与市场的份额仓位；存在时沿用已有份额。
    /// Position owned by the signing supplier in this market. Preserve any existing shares.
    #[account(
        init_if_needed,
        payer = payer,
        space = SupplyPosition::DISCRIMINATOR.len() + SupplyPosition::INIT_SPACE,
        seeds = [SUPPLY_POSITION_SEED, market.key().as_ref(), supplier.key().as_ref()],
        bump,
    )]
    pub supply_position: Account<'info, SupplyPosition>,

    /// 为未建立的 PDA 分配账户空间并转入免租金余额。
    /// Allocates space and transfers rent-exempt balances to missing PDAs.
    pub system_program: Program<'info, System>,
}

/// 写入两个新 PDA 的归属字段，重复调用保留原有记账余额。
/// Bind the new PDAs to their owners while leaving existing accounting balances intact.
///
/// `context` 提供经过种子、签名和账户空间校验的市场与出借账户；绑定异常时整笔回滚。
/// `context` supplies market and supply accounts validated by seeds, signatures and space. Invalid bindings revert the instruction.
pub(super) fn handle(context: Context<PrepareSupply>) -> Result<()> {
    // PDA 的既定市场与签名出借人公钥。
    // The canonical market and signing supplier public keys.
    let market = context.accounts.market.key();
    let supplier = context.accounts.supplier.key();
    bind_accounts(
        &mut context.accounts.supply_pool,
        &mut context.accounts.supply_position,
        market,
        supplier,
    )
}

/// 只接受尚未绑定的零余额账户，或已属于同一市场和持有人的账户。
/// Accept only unbound zero-balance accounts or accounts already bound to the same market and owner.
///
/// `pool` 和 `position` 是规范 PDA 的内容，`market` 和 `supplier` 是本指令验证的公钥。
/// `pool` and `position` are the canonical PDA data, and `market` and `supplier` are validated keys.
fn bind_accounts(
    pool: &mut SupplyPool,
    position: &mut SupplyPosition,
    market: Pubkey,
    supplier: Pubkey,
) -> Result<()> {
    // Anchor 新分配账户的数据为零，空绑定还必须没有任何已有资产或份额。
    // Anchor allocates zeroed accounts. An unbound record must also have no assets or shares.
    let unbound_pool = pool.market == Pubkey::default()
        && pool.accounted_assets_raw == 0
        && pool.total_shares_raw == 0;
    let unbound_position = position.market == Pubkey::default()
        && position.supplier == Pubkey::default()
        && position.shares_raw == 0;

    // 一并核对两个账户后再写归属。已有余额始终沿用原值。
    // Validate both records before updating bindings. All existing balances are preserved.
    require!(
        (unbound_pool || pool.market == market)
            && (unbound_position || (position.market == market && position.supplier == supplier))
            && position.shares_raw <= pool.total_shares_raw,
        LendingError::InvalidSupplyAccounting
    );
    pool.market = market;
    position.market = market;
    position.supplier = supplier;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::bind_accounts;
    use crate::{SupplyPool, SupplyPosition};
    use anchor_lang::prelude::Pubkey;

    /// 空账户可以建立归属，重复准备不会重置已有资产或份额。
    /// Empty accounts can be bound, and repeated preparation leaves existing assets and shares intact.
    #[test]
    fn binds_empty_accounts_and_preserves_balances() {
        // 模拟 Anchor 零初始化的池和仓位，以及预期的市场与出借人公钥。
        // Simulates Anchor's zeroed pool and position, with expected market and supplier keys.
        let mut pool = SupplyPool {
            market: Pubkey::default(),
            accounted_assets_raw: 0,
            total_shares_raw: 0,
        };
        let mut position = SupplyPosition {
            market: Pubkey::default(),
            supplier: Pubkey::default(),
            shares_raw: 0,
        };
        let market = Pubkey::new_from_array([1; 32]);
        let supplier = Pubkey::new_from_array([2; 32]);

        bind_accounts(&mut pool, &mut position, market, supplier).unwrap();
        assert_eq!(pool.market, market);
        assert_eq!(position.market, market);
        assert_eq!(position.supplier, supplier);

        pool.accounted_assets_raw = 1_000_000;
        pool.total_shares_raw = 1_000_000;
        position.shares_raw = 250_000;
        bind_accounts(&mut pool, &mut position, market, supplier).unwrap();
        assert_eq!(pool.accounted_assets_raw, 1_000_000);
        assert_eq!(pool.total_shares_raw, 1_000_000);
        assert_eq!(position.shares_raw, 250_000);
    }

    /// 已初始化的仓位不能改绑到另一个出借人。
    /// An initialized position cannot be rebound to a different supplier.
    #[test]
    fn rejects_another_supplier_without_changing_the_position() {
        // 已完成出借的规范池和仓位，以及两个不同的出借人公钥。
        // An active pool and position, with two distinct supplier public keys.
        let market = Pubkey::new_from_array([1; 32]);
        let original_supplier = Pubkey::new_from_array([2; 32]);
        let another_supplier = Pubkey::new_from_array([3; 32]);
        let mut pool = SupplyPool {
            market,
            accounted_assets_raw: 1_000_000,
            total_shares_raw: 1_000_000,
        };
        let mut position = SupplyPosition {
            market,
            supplier: original_supplier,
            shares_raw: 250_000,
        };

        assert!(bind_accounts(&mut pool, &mut position, market, another_supplier).is_err());
        assert_eq!(position.supplier, original_supplier);
        assert_eq!(position.shares_raw, 250_000);
    }
}

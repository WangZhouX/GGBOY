//! 与策略存赎和资金操作共用的净值报价。
//! Marked NAV used by strategy operations and investor deposits and redemptions.

use anchor_lang::{prelude::*, system_program};
use anchor_spl::token::TokenAccount;
use ggboy_lending::{
    project_pool_assets, LendingMarket, MockCollateralPrice, SupplyPool, SupplyPosition,
};

use crate::{
    strategy::{
        VaultStrategy, MARKET_SEED, POOL_SEED, POSITION_SEED, PRICE_SEED, STRATEGY_CUSTODY_SEED,
        STRATEGY_SEED, STRATEGY_VAULT_LEN,
    },
    Vault, VaultError,
};

/// tSOL 最小单位到整枚的倍率，对应配置时强制的九位小数。
/// Number of base units in one tSOL, using the nine decimals enforced at configuration.
pub(super) const STRATEGY_SCALE: u128 = 1_000_000_000;

/// 测试预言机允许的最久年龄，单位为秒，与当前借贷市场一致。
/// Maximum test-oracle age in seconds, matching the current lending market.
const MAX_PRICE_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;

/// 一次同笔链上报价，所有字段均以各自资产最小单位计。
/// One on-chain valuation, with every field measured in its own asset's base units.
pub(super) struct VaultValuation {
    /// 结算 Mint 计价的现金、策略持仓与出借净值总和。
    /// Sum of cash, strategy inventory and lending value, denominated in the settlement mint.
    pub(super) nav: u64,
    /// 托管仍持有的策略代币最小单位，用于检测清仓前遗留资产。
    /// Strategy token base units still held in custody, used to detect residual assets.
    pub(super) spot_raw: u64,
    /// 金库出借估值的原始账本，用于计算赎回时须收回的池份额。
    /// Lending ledger inputs used to size the pool share recall during redemption.
    pub(super) pool: PoolValuation,
}

/// 用当前借贷记账报价所需的三个金额。
/// Three amounts needed to price the vault's lending position from current accounting.
#[derive(Default)]
pub(super) struct PoolValuation {
    /// 借贷池已记账的结算代币最小单位，包含当前尚未偿还的本金。
    /// Accounted settlement-token base units, including outstanding principal.
    pub(super) assets: u64,
    /// 借贷市场所有出借人的份额最小单位总量。
    /// Total supply share base units across all suppliers.
    pub(super) total_shares: u64,
    /// 由金库 PDA 持有的出借份额最小单位。
    /// Supply share base units owned by the vault PDA.
    pub(super) shares: u64,
}

impl PoolValuation {
    /// 使用占比计算金库出借价值，向下取整到结算代币最小单位。
    /// Value the vault's lending share proportion, floored to settlement base units.
    pub(super) fn value(&self) -> Result<u64> {
        if self.shares == 0 {
            return Ok(0);
        }
        require!(
            self.total_shares >= self.shares,
            VaultError::InvalidStrategyAccounts
        );
        // 两个 u64 的乘积完整放入 u128，再按总份额整数除法向下取整。
        // The two u64 factors fit in u128. Integer division by total shares rounds down.
        let value =
            u128::from(self.shares) * u128::from(self.assets) / u128::from(self.total_shares);
        u64::try_from(value).map_err(|_| error!(VaultError::StrategyValuationOverflow))
    }

    /// 求出向下取整后至少支付 `cash` 个结算最小单位所需的最小池份额。
    /// Return the smallest pool share amount whose floored payout covers `cash` settlement base units.
    ///
    /// `cash` 必须为正。资金池份额不足时返回金库流动性错误。
    /// `cash` must be positive. An inadequate vault share position is a liquidity error.
    pub(super) fn shares_for_cash(&self, cash: u64) -> Result<u64> {
        require!(
            cash > 0 && cash <= self.value()?,
            VaultError::InsufficientVaultCash
        );
        // 提取时向下取整。反推份额时向上取整，保证足额覆盖。
        // Withdrawals floor the payout. Round the inverse share calculation up to cover the shortfall.
        let shares =
            (u128::from(cash) * u128::from(self.total_shares)).div_ceil(u128::from(self.assets));
        u64::try_from(shares).map_err(|_| error!(VaultError::StrategyValuationOverflow))
    }
}

/// 校验账户恰好是指定程序及种子的规范 PDA，返回规范 bump。
/// Verify the exact canonical PDA for a program and seeds, returning its canonical bump.
///
/// `info` 是调用者提供的账户，`seeds` 按所属程序地址约定排列。
/// `info` is caller-supplied. `seeds` are ordered according to the owner's address convention.
fn canonical_bump(info: &AccountInfo, seeds: &[&[u8]], program: &Pubkey) -> Result<u8> {
    let (expected, bump) = Pubkey::find_program_address(seeds, program);
    require_keys_eq!(*info.key, expected, VaultError::InvalidStrategyAccounts);
    Ok(bump)
}

/// 校验链上所有程序归属并按账户类型验证布局与初始化状态。
/// Check on-chain program ownership and validate the account layout and initialization.
///
/// `info` 必须属于 `T::owner()` 并能按 `T` 完整反序列化。
/// `info` must belong to `T::owner()` and decode as an initialized `T`.
fn read_owned<T: AccountDeserialize + Owner>(info: &AccountInfo) -> Result<T> {
    require_keys_eq!(*info.owner, T::owner(), VaultError::InvalidStrategyAccounts);
    let data = info.try_borrow_data()?;
    T::try_deserialize(&mut &data[..]).map_err(|_| error!(VaultError::InvalidStrategyAccounts))
}

/// 识别尚未分配数据的规范系统账户。即使外部向该地址转入 SOL，仓位仍为空。
/// Recognize an unallocated system account. A SOL donation to that address does not create a position.
///
/// 调用前先校验账户的规范 PDA 地址。 Check its canonical PDA address before calling.
fn is_uninitialized(info: &AccountInfo) -> bool {
    info.owner == &system_program::ID && info.data_is_empty()
}

/// 从金库规范出借账户读取资金池总资产与份额。
/// Read pool asset and share totals through the vault's canonical lending accounts.
///
/// `market` 与 `vault` 是已经校验的链上账户地址。初次出借前允许规范 PDA 为空。
/// `market` and `vault` are already verified account addresses. Their canonical PDAs can be absent before first supply.
pub(super) fn inspect_pool(
    market: Pubkey,
    vault: Pubkey,
    pool: &AccountInfo,
    position: &AccountInfo,
) -> Result<PoolValuation> {
    canonical_bump(pool, &[POOL_SEED, market.as_ref()], &ggboy_lending::ID)?;
    canonical_bump(
        position,
        &[POSITION_SEED, market.as_ref(), vault.as_ref()],
        &ggboy_lending::ID,
    )?;

    // 只把规范且未初始化的地址当成空仓。其他账户必须属于借贷程序并匹配市场和出借人。
    // Only a canonical uninitialized account is empty. Every other account must belong to lending and match the market and supplier.
    let pool_exists = !is_uninitialized(pool);
    let (assets, total_shares) = if pool_exists {
        let ledger: SupplyPool = read_owned(pool)?;
        require_keys_eq!(ledger.market, market, VaultError::InvalidStrategyAccounts);
        // 用借贷程序的计息函数按同一时钟估值，使赎回报价与随后 CPI 的价格一致。
        // Use the lending program's interest projection at the same clock so the quote agrees with the later CPI.
        let assets = project_pool_assets(
            pool,
            ledger.accounted_assets_raw,
            Clock::get()?.unix_timestamp,
        )?;
        (assets, ledger.total_shares_raw)
    } else {
        (0, 0)
    };
    let shares = if is_uninitialized(position) {
        0
    } else {
        require!(pool_exists, VaultError::InvalidStrategyAccounts);
        let position: SupplyPosition = read_owned(position)?;
        require_keys_eq!(position.market, market, VaultError::InvalidStrategyAccounts);
        require_keys_eq!(
            position.supplier,
            vault,
            VaultError::InvalidStrategyAccounts
        );
        position.shares_raw
    };

    require!(
        (total_shares > 0 || assets == 0) && shares <= total_shares,
        VaultError::InvalidStrategyAccounts
    );
    Ok(PoolValuation {
        assets,
        total_shares,
        shares,
    })
}

/// 读取借贷市场规范测试价格，拒绝缺失、零值、未来发布及过期价格。
/// Read the lending market's canonical test price, rejecting missing, zero, future and stale observations.
///
/// `market` 是已校验的市场地址。返回值为每整枚 tSOL 对应的结算 Mint 最小单位数。
/// `market` is the verified market address. The result is settlement base units per whole tSOL.
pub(super) fn read_price(market: Pubkey, price: &AccountInfo) -> Result<u64> {
    canonical_bump(price, &[PRICE_SEED, market.as_ref()], &ggboy_lending::ID)?;
    let price: MockCollateralPrice =
        read_owned(price).map_err(|_| error!(VaultError::InvalidStrategyPrice))?;
    require!(
        price.market == market && price.price_raw > 0 && price.published_at > 0,
        VaultError::InvalidStrategyPrice
    );

    // 链上时钟决定有效期。时间差计算溢出时也拒绝报价。
    // The on-chain clock sets the freshness boundary. A timestamp subtraction overflow also rejects the quote.
    let age = Clock::get()?.unix_timestamp.checked_sub(price.published_at);
    require!(
        age.is_some_and(|seconds| (0..=MAX_PRICE_AGE_SECONDS).contains(&seconds)),
        VaultError::InvalidStrategyPrice
    );
    Ok(price.price_raw)
}

/// 将策略资产折成结算 Mint 最小单位，按整数向下取整。
/// Convert strategy inventory to settlement base units rounded down.
///
/// `amount` 为 9 位精度的 tSOL 最小单位数，`price` 为每整枚 tSOL 的结算 Mint 最小单位数。
/// `amount` is nine-decimal tSOL base units. `price` is settlement base units per whole tSOL.
pub(super) fn spot_value(amount: u64, price: u64) -> Result<u64> {
    let value = u128::from(amount) * u128::from(price) / STRATEGY_SCALE;
    u64::try_from(value).map_err(|_| error!(VaultError::StrategyValuationOverflow))
}

/// 为原金库存赎 ABI 读取现金或策略净值，禁用伪造或省略已激活余额账户。
/// Read cash or strategy NAV through the original investor ABI, preventing substituted or omitted active accounts.
///
/// `vault` 是已验证的金库状态，`cash` 是其当前现金最小单位余额。激活后 `remaining` 必须按
/// 策略、策略托管、借贷市场、测试价格、出借池、金库出借仓位顺序传入六个规范账户。
/// `vault` is validated and `cash` is its balance in settlement base units. After activation, `remaining` must
/// provide the six canonical accounts in this order: strategy, strategy custody, lending market, oracle, pool, vault position.
pub(super) fn vault_valuation(
    vault: &Account<Vault>,
    cash: u64,
    remaining: &[AccountInfo],
) -> Result<VaultValuation> {
    // 已初始化的策略把金库账户增加一个字节。签名人不能通过不传附加账户退回现金报价。
    // Strategy initialization extends the vault by one byte. Omitting the extra accounts cannot restore cash-only pricing.
    let legacy_len = Vault::DISCRIMINATOR.len() + Vault::INIT_SPACE;
    let data_len = vault.to_account_info().data_len();
    if data_len == legacy_len {
        return Ok(VaultValuation {
            nav: cash,
            spot_raw: 0,
            pool: PoolValuation::default(),
        });
    }
    require_eq!(
        data_len,
        STRATEGY_VAULT_LEN,
        VaultError::InvalidStrategyAccounts
    );
    let [strategy_info, custody_info, market_info, price, pool, position] = remaining else {
        return err!(VaultError::InvalidStrategyAccounts);
    };

    // 验证每个报价输入的地址、程序归属和账户内部绑定，防止价格与仓位替换。
    // Check address, owning program and internal bindings for every valuation input to prevent substitution.
    let vault_key = vault.key();
    let bump = canonical_bump(
        strategy_info,
        &[STRATEGY_SEED, vault_key.as_ref()],
        &crate::ID,
    )?;
    let strategy: VaultStrategy = read_owned(strategy_info)?;
    require!(
        strategy.vault == vault_key && strategy.bump == bump,
        VaultError::InvalidStrategyAccounts
    );
    canonical_bump(
        custody_info,
        &[STRATEGY_CUSTODY_SEED, strategy_info.key.as_ref()],
        &crate::ID,
    )?;
    let custody: TokenAccount = read_owned(custody_info)?;
    require!(
        custody.owner == vault_key && custody.mint == strategy.strategy_mint,
        VaultError::InvalidStrategyAccounts
    );
    let market_bump = canonical_bump(market_info, &[MARKET_SEED], &ggboy_lending::ID)?;
    let market: LendingMarket = read_owned(market_info)?;
    require!(
        *market_info.key == strategy.market
            && market.debt_mint == vault.asset_mint
            && market.collateral_mint == strategy.strategy_mint
            && market.bump == market_bump,
        VaultError::InvalidStrategyAccounts
    );

    let spot_raw = custody.amount;
    let spot = if spot_raw == 0 {
        // 市场价格不可用时，零持仓的结算仍可进行，但价格账户地址必须正确。
        // A zero spot position can still settle without a usable price, but the address must be canonical.
        canonical_bump(
            price,
            &[PRICE_SEED, strategy.market.as_ref()],
            &ggboy_lending::ID,
        )?;
        0
    } else {
        spot_value(spot_raw, read_price(strategy.market, price)?)?
    };
    let lending = inspect_pool(strategy.market, vault_key, pool, position)?;
    let lend_value = lending.value()?;
    let nav = cash
        .checked_add(spot)
        .and_then(|previous| previous.checked_add(lend_value))
        .ok_or(VaultError::StrategyValuationOverflow)?;
    Ok(VaultValuation {
        nav,
        spot_raw,
        pool: lending,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证 tSOL 精度、最小单位向下取整及巨大比价溢出的拒绝路径。
    /// Verify tSOL precision, base-unit flooring, and rejection of an overflowing valuation.
    #[test]
    fn values_strategy_tokens_in_settlement_units() {
        assert_eq!(spot_value(1_500_000_000, 100_000_000).unwrap(), 150_000_000);
        assert_eq!(spot_value(19, 100_000_000).unwrap(), 1);
        assert!(spot_value(u64::MAX, u64::MAX).is_err());
    }

    /// 覆盖份额反推的向上取整、整仓约束和最大 u64 乘积。
    /// Cover inverse share rounding, position limits, and the maximum u64 product.
    #[test]
    fn finds_minimal_shares_for_requested_cash() {
        let pool = PoolValuation {
            assets: 5,
            total_shares: 3,
            shares: 2,
        };
        assert_eq!(pool.shares_for_cash(2).unwrap(), 2);
        assert_eq!(pool.shares_for_cash(3).unwrap(), 2);
        assert!(pool.shares_for_cash(4).is_err());
        assert!(PoolValuation::default().shares_for_cash(1).is_err());
        let worthless = PoolValuation {
            assets: 0,
            total_shares: 2,
            shares: 1,
        };
        assert_eq!(worthless.value().unwrap(), 0);
        assert!(worthless.shares_for_cash(1).is_err());
        let full = PoolValuation {
            assets: u64::MAX,
            total_shares: u64::MAX,
            shares: u64::MAX,
        };
        assert_eq!(full.shares_for_cash(u64::MAX).unwrap(), u64::MAX);
    }

    /// 验证出借份额按当前资产估值，整除余数留在池内。
    /// Verify lending valuation based on current assets, leaving the fractional remainder in the pool.
    #[test]
    fn values_pool_shares_at_current_assets() {
        assert_eq!(
            PoolValuation {
                assets: 5,
                total_shares: 3,
                shares: 1
            }
            .value()
            .unwrap(),
            1
        );
        assert_eq!(
            PoolValuation {
                assets: 5,
                total_shares: 3,
                shares: 3
            }
            .value()
            .unwrap(),
            5
        );
        assert_eq!(
            PoolValuation {
                assets: 0,
                total_shares: 0,
                shares: 0
            }
            .value()
            .unwrap(),
            0
        );
        assert!(PoolValuation {
            assets: 5,
            total_shares: 3,
            shares: 4
        }
        .value()
        .is_err());
    }
}

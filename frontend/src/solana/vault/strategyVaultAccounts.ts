import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, type AccountInfo } from '@solana/web3.js';
import type { Buffer } from 'buffer';
import { lendingInterestLayouts, projectLendingInterest } from '../lending/lendingInterest';
import { getSupplyWithdrawalLimit, valueSupplyShares } from '../lending/supplyWithdrawalAmounts';

/** 链上金库以额外一个字节标记策略已启用。 The vault adds one byte to mark active strategy pricing. */
export const strategyVaultStateSize = 138;
/** 固定借贷 CPI 程序和时钟账户所有者。 Fixed lending CPI program and clock account owner. */
export const strategyLendingProgram = new PublicKey('8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H');
const sysvarProgram = new PublicKey('Sysvar1111111111111111111111111111111111111');
/** 策略 Mint 的链上精度和每整单位的最小单位数。 On-chain strategy mint decimals and base units per whole token. */
const strategyDecimals = 9;
export const strategyScale = 10n ** BigInt(strategyDecimals);
/** 基点分母和现有测试预言机的最长有效时间（秒）。 Basis-point denominator and test oracle maximum age in seconds. */
export const strategyBpsScale = 10_000n;
const maxRawAmount = (1n << 64n) - 1n;
const priceMaxAgeSeconds = 7n * 24n * 60n * 60n;
/** Anchor 固定账户标识，按账户类型对应。 Fixed Anchor discriminators per account type. */
const tags = {
  strategy: [116, 9, 73, 37, 73, 192, 63, 215],
  market: [246, 114, 50, 98, 72, 157, 28, 120],
  price: [21, 63, 245, 69, 219, 1, 9, 14],
  pool: [238, 91, 229, 152, 53, 213, 165, 153],
  position: [248, 221, 250, 222, 37, 167, 64, 209],
  borrow: [148, 133, 18, 242, 248, 66, 156, 99],
} as const;
/** 空账户和正常账户的 RPC 字节。 RPC bytes for missing and present accounts. */
type SlotAccount = AccountInfo<Buffer> | null;

/**
 * 派生金库、测试储备、借贷和时钟地址，交易和读链使用同一规则。
 * Derive vault, test reserve, lending, and clock addresses consistently for reads and transactions.
 *
 * @param programId 金库程序公钥。 Vault program public key.
 * @param vault 已登记且核验的金库 PDA。 Registered and verified vault PDA.
 */
export function vaultStrategyAddresses(programId: PublicKey, vault: PublicKey) {
  /** UTF-8 种子后编码依次排列的公钥。 Encode a UTF-8 seed followed by the ordered public keys. */
  const derive = (program: PublicKey, seed: string, ...keys: PublicKey[]) =>
    PublicKey.findProgramAddressSync([new TextEncoder().encode(seed), ...keys.map((key) => key.toBytes())], program);
  /** 策略与市场的固定 PDA 及规范 bump。 Canonical strategy and market PDAs and bumps. */
  const [strategy, strategyBump] = derive(programId, 'strategy', vault);
  const [market, marketBump] = derive(strategyLendingProgram, 'lending_market');
  return {
    strategy, strategyBump, market, marketBump,
    strategyCustody: derive(programId, 'strategy_custody', strategy)[0],
    swapCash: derive(programId, 'swap_cash', strategy)[0],
    swapStrategy: derive(programId, 'swap_strategy', strategy)[0],
    lendingCash: derive(strategyLendingProgram, 'cash_vault', market)[0],
    lendingCollateral: derive(strategyLendingProgram, 'collateral_vault', market)[0],
    price: derive(strategyLendingProgram, 'mock_collateral_price', market)[0],
    supplyPool: derive(strategyLendingProgram, 'supply_pool', market)[0],
    supplyPosition: derive(strategyLendingProgram, 'supply_position', market, vault)[0],
    borrowMarket: derive(strategyLendingProgram, 'borrow_market', market)[0],
    clock: SYSVAR_CLOCK_PUBKEY,
  };
}

/** 金库策略、借贷和储备的规范地址集合。 Canonical vault strategy, lending, and reserve addresses. */
type StrategyAddresses = ReturnType<typeof vaultStrategyAddresses>;

/** 返回与解码函数共用顺序的策略账户。 Return strategy accounts in the decoder's shared order. */
export function vaultStrategyObservationKeys(keys: StrategyAddresses) {
  return [
    keys.strategy, keys.strategyCustody, keys.swapCash, keys.swapStrategy, keys.market, keys.lendingCash,
    keys.price, keys.supplyPool, keys.supplyPosition, keys.borrowMarket, keys.clock,
  ];
}

/** 管理者与策略风控规则取自同一个金库配置 PDA。 Strategy authority and limits from the same configuration PDA. */
interface StrategyConfiguration {
  /** 金库策略配置 PDA。 Vault strategy configuration PDA. */
  address: PublicKey;
  /** 有权签名操作金库资产的钱包。 Wallet authorized to manage the vault assets. */
  manager: PublicKey;
  /** 九位小数测试策略代币 Mint。 Nine-decimal test strategy token mint. */
  strategyMint: PublicKey;
  /** 金库绑定的借贷市场。 Lending market bound to this vault. */
  market: PublicKey;
  /** 现金留存、出借占比和单笔兑换限额，单位均为基点。 Cash reserve, lending ratio, and per-swap cap, all in basis points. */
  reserveBps: number;
  lendingCapBps: number;
  maxTradeBps: number;
  /** 策略代币的小数精度。 Strategy token decimal precision. */
  strategyDecimals: number;
}

/** 同一槽的策略金额与风控配置，金额全部为各自资产或份额最小单位。 Same-slot configuration and amounts in the respective asset or share base units. */
export interface VaultStrategyHoldings {
  /** 未配置时为 null。 Null before strategy setup. */
  config: StrategyConfiguration | null;
  /** 由链上金库标志授权赎回时自动收回借贷资金。 On-chain vault flag enabling automatic recall during redemption. */
  autoRecallEnabled: boolean;
  /** tSOL 持仓、mockUSDC 估值、池份额和对应账面金额。 Spot holdings, quote value, pool shares, and their book value. */
  spotRaw: bigint;
  strategyValueRaw: bigint | null;
  lendingSharesRaw: bigint;
  lendingValueRaw: bigint;
  /** 当前金库净值和可新增资金上限，缺必需价格时为 null。 NAV and additional deployable cash, null when a required price is missing. */
  navRaw: bigint | null;
  maxLendRaw: bigint | null;
  /** 当前可收回的 mockUSDC 和对应份额上限。 Immediately recallable settlement assets and corresponding share ceiling. */
  maxRecallRaw: bigint;
  maxRecallSharesRaw: bigint;
  /** 每整单位 tSOL 的 mockUSDC 最小单位报价，过期或缺失为空。 Quote base units per whole strategy token, null if missing or expired. */
  priceRaw: bigint | null;
  /** 测试兑换的现金和策略代币储备。 Test exchange reserves of settlement and strategy tokens. */
  swapCashRaw: bigint;
  swapSpotRaw: bigint;
  /** 借贷池记账资产与份额总量，供出借和收回报价。 Lending pool book assets and total shares for supply and recall quotes. */
  poolAssetsRaw: bigint;
  poolSharesRaw: bigint;
  /** 启用策略后投资者存赎指令的六个估值账户，按链上 ABI 顺序。 Six valuation accounts appended to investor transactions when strategy is active, in ABI order. */
  pricingAccounts: readonly PublicKey[];
  /** 自动收回打开时还追加池现金、借款账和借贷程序。 Auto recall also includes pool cash, debt ledger and the lending program. */
  redemptionAccounts: readonly PublicKey[];
}

/** 判断某个规范 PDA 尚未建立，允许它仅收到意外 lamports。 Identify an unallocated PDA even when it received unsolicited lamports. */
function isUnallocated(info: SlotAccount) {
  return info === null || (!info.executable && info.owner.equals(SystemProgram.programId) && info.data.length === 0);
}

/** 验证 Anchor 归属、长度和类型，返回小端账户字节。 Validate Anchor owner, size, and type before returning the little-endian bytes. */
function checkedData(info: SlotAccount, owner: PublicKey, length: number, discriminator: readonly number[]) {
  if (!info || info.executable || !info.owner.equals(owner) || info.data.length !== length ||
      !discriminator.every((value, index) => info.data[index] === value)) {
    throw new Error('Invalid vault strategy account.');
  }
  return info.data;
}

/** 读取经归属和 Mint 校验的未冻结经典 SPL Token 余额。 Read classic SPL Token balance after validating mint, authority, and frozen state. */
function checkedBalance(address: PublicKey, info: SlotAccount, mint: PublicKey, authority: PublicKey) {
  if (!info || info.executable || info.data.length !== ACCOUNT_SIZE) throw new Error('Missing strategy custody.');
  /** SPL 实现同时验证真实代币程序。 The SPL decoder also checks program ownership. */
  const token = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  if (!token.isInitialized || token.isFrozen || token.isNative || !token.mint.equals(mint) || !token.owner.equals(authority)) {
    throw new Error('Invalid strategy custody bindings.');
  }
  return token.amount;
}

/** 从定长配置和借贷账户中读取 32 字节公钥。 Read a 32-byte public key from an Anchor account. */
function keyAt(bytes: Buffer, offset: number) {
  return new PublicKey(bytes.subarray(offset, offset + 32));
}

/** 为向上计算现金储备目标保留整数精度。 Round the cash reserve target up using integer arithmetic. */
export function strategyCashFloor(nav: bigint, reserveBps: number) {
  return (nav * BigInt(reserveBps) + strategyBpsScale - 1n) / strategyBpsScale;
}

/**
 * 校验并估值与金库现金同槽的策略和借贷账户。
 * Validate and value strategy and lending accounts from the same slot as vault cash.
 *
 * @param vault 基础金库和托管绑定。 Base vault and custody bindings.
 * @param activation 金库账户的策略状态和自动收回位标志。 Strategy status and automatic recall flag from the vault account.
 * @param cashRaw 现金托管结算代币最小单位余额。 Settlement balance in cash custody, in base units.
 * @param keys 与 RPC 顺序对应的 PDA。 PDAs mapped to the request order.
 * @param accounts 同槽读取的 RPC 账户。 RPC accounts read in the same slot.
 */
export function decodeVaultStrategy(
  vault: { programId: PublicKey; vaultAddress: PublicKey; assetMint: PublicKey; shareMint: PublicKey },
  activation: { active: boolean; autoRecallEnabled: boolean },
  cashRaw: bigint,
  keys: StrategyAddresses,
  accounts: readonly SlotAccount[],
): VaultStrategyHoldings {
  /** 账户向量解构必须与 vaultStrategyObservationKeys 保持一致。 Match the account order in vaultStrategyObservationKeys. */
  const [strategy, spot, swapCash, swapSpot, market, lendingCash, price, pool, position, borrow, clock] = accounts;
  if (!activation.active) {
    if (!isUnallocated(strategy)) throw new Error('Strategy configuration exists without the vault activation marker.');
    return {
      config: null, autoRecallEnabled: false, spotRaw: 0n, strategyValueRaw: 0n, lendingSharesRaw: 0n, lendingValueRaw: 0n,
      navRaw: cashRaw, maxLendRaw: null, maxRecallRaw: 0n, maxRecallSharesRaw: 0n, priceRaw: null,
      swapCashRaw: 0n, swapSpotRaw: 0n, poolAssetsRaw: 0n, poolSharesRaw: 0n, pricingAccounts: [], redemptionAccounts: [],
    };
  }

  /** 配置的 143 字节包含四个公钥、三个 u16 基点参数和一个 bump。 The 143-byte config contains four keys, three u16 basis-point settings, and a bump. */
  const configData = checkedData(strategy, vault.programId, 143, tags.strategy);
  const manager = keyAt(configData, 40);
  const strategyMint = keyAt(configData, 72);
  const reserveBps = configData.readUInt16LE(136);
  const lendingCapBps = configData.readUInt16LE(138);
  const maxTradeBps = configData.readUInt16LE(140);
  if (!keyAt(configData, 8).equals(vault.vaultAddress) || !keyAt(configData, 104).equals(keys.market) ||
      configData[142] !== keys.strategyBump || reserveBps > 10_000 || lendingCapBps > 10_000 || maxTradeBps > 10_000 ||
      strategyMint.equals(vault.assetMint) || strategyMint.equals(vault.shareMint)) {
    throw new Error('Invalid vault strategy configuration bindings.');
  }

  /** 借贷市场必须绑定同一对结算和策略 Mint，以及规范托管账户。 The lending market must bind the same mints and canonical custody accounts. */
  const marketData = checkedData(market, strategyLendingProgram, 169, tags.market);
  if (!keyAt(marketData, 40).equals(vault.assetMint) || !keyAt(marketData, 72).equals(strategyMint) ||
      !keyAt(marketData, 104).equals(keys.lendingCash) || !keyAt(marketData, 136).equals(keys.lendingCollateral) ||
      marketData[168] !== keys.marketBump) {
    throw new Error('Invalid strategy lending market bindings.');
  }

  /** 策略和兑换储备分别由金库与配置 PDA 控制。 The vault and configuration PDAs separately control strategy holdings and swap reserves. */
  const spotRaw = checkedBalance(keys.strategyCustody, spot, strategyMint, vault.vaultAddress);
  const swapCashRaw = checkedBalance(keys.swapCash, swapCash, vault.assetMint, keys.strategy);
  const swapSpotRaw = checkedBalance(keys.swapStrategy, swapSpot, strategyMint, keys.strategy);
  const lendingCashRaw = checkedBalance(keys.lendingCash, lendingCash, vault.assetMint, keys.market);
  /** 价格有效期以同槽链上 Clock 为准，未发布价格仍允许现金估值与收回。 Price validity uses the same-slot clock. Unpublished prices still allow cash valuation and recall. */
  /** 借贷利息和价格均从同一槽的 Clock 获得 Unix 秒。 Interest and price both use Unix seconds from the same-slot Clock. */
  const clockTime = clock && !clock.executable && clock.owner.equals(sysvarProgram) && clock.data.length === 40
    ? clock.data.readBigInt64LE(32) : null;
  let priceRaw: bigint | null = null;
  if (!isUnallocated(price)) {
    const oracle = checkedData(price, strategyLendingProgram, 56, tags.price);
    const timestamp = oracle.readBigInt64LE(48);
    const value = oracle.readBigUInt64LE(40);
    if (!keyAt(oracle, 8).equals(keys.market) || clockTime === null) throw new Error('Invalid strategy price observation.');
    const age = clockTime - timestamp;
    if (value > 0n && timestamp > 0n && age >= 0n && age <= priceMaxAgeSeconds) priceRaw = value;
  }

  /** 只从该金库作为出借人的规范 PDA 核算其出借资产。 Value only the position whose canonical supplier is this vault. */
  const lendingData = (info: SlotAccount, length: number, tag: readonly number[]) => {
    if (isUnallocated(info)) return null;
    const result = checkedData(info, strategyLendingProgram, length, tag);
    if (!keyAt(result, 8).equals(keys.market)) throw new Error('Lending ledger belongs to a different market.');
    return result;
  };
  /** 计息启用后池账本保留原字段，按扩展账户投影当前净资产。 Interest adds fields to the old pool layout and requires projecting current pool assets. */
  const activePool = pool?.data.length === lendingInterestLayouts.pool.size;
  const poolData = lendingData(pool, activePool ? lendingInterestLayouts.pool.size : lendingInterestLayouts.pool.legacySize, tags.pool);
  const positionData = lendingData(position, 80, tags.position);
  const borrowData = lendingData(borrow, 48, tags.borrow);
  if (positionData && !keyAt(positionData, 40).equals(vault.vaultAddress)) throw new Error('Unexpected supply position owner.');
  /** 原字段是旧市场资产或最后结算值。 Legacy fields store cash-market accounting or the last settlement value. */
  const legacyAssetsRaw = poolData?.readBigUInt64LE(40) ?? 0n;
  const poolSharesRaw = poolData?.readBigUInt64LE(48) ?? 0n;
  const lendingSharesRaw = positionData?.readBigUInt64LE(72) ?? 0n;
  const legacyDebtRaw = borrowData?.readBigUInt64LE(40) ?? 0n;
  if (activePool && clockTime === null) throw new Error('Missing same-slot clock for vault valuation.');
  const { accountedAssetsRaw: poolAssetsRaw, totalDebtRaw: debtRaw } =
    projectLendingInterest(poolData, legacyAssetsRaw, legacyDebtRaw, clockTime ?? 0n);
  if ((poolSharesRaw === 0n && poolAssetsRaw !== 0n) || lendingSharesRaw > poolSharesRaw ||
      debtRaw > poolAssetsRaw || poolAssetsRaw - debtRaw > lendingCashRaw) {
    throw new Error('Inconsistent strategy lending accounting.');
  }
  const accounting = {
    totalSharesRaw: poolSharesRaw, accountedAssetsRaw: poolAssetsRaw, totalDebtRaw: debtRaw,
    cashRaw: lendingCashRaw, sharesRaw: lendingSharesRaw, walletAssetFrozen: false,
  };
  const lendingValueRaw = valueSupplyShares(accounting, lendingSharesRaw);
  const recall = getSupplyWithdrawalLimit(accounting);
  /** 策略估值和出借价值按最小单位向下舍入。 Round spot and lending valuations down to base units. */
  const spotValue = spotRaw === 0n ? 0n : priceRaw === null ? null : spotRaw * priceRaw / strategyScale;
  const fullNav = spotValue === null ? null : cashRaw + spotValue + lendingValueRaw;
  // 链上用 u64 保存净值报价，溢出时金额不可报价。
  // The program quotes NAV as u64, so an overflowing amount cannot be quoted.
  const navRaw = fullNav !== null && fullNav <= maxRawAmount ? fullNav : null;
  const strategyValueRaw = navRaw === null ? null : spotValue;
  let maxLendRaw: bigint | null = null;
  if (navRaw !== null) {
    const cashBudget = cashRaw - strategyCashFloor(navRaw, reserveBps);
    const allocationBudget = navRaw * BigInt(lendingCapBps) / strategyBpsScale - lendingValueRaw;
    const budget = cashBudget < allocationBudget ? cashBudget : allocationBudget;
    maxLendRaw = budget > 0n ? budget : 0n;
  }
  /** 存入只读六个估值账户，赎回按能力标志选择是否附加三个 CPI 账户。 Deposits only read the six pricing accounts. Capability selects the additional CPI accounts for redemptions. */
  const pricingAccounts = [keys.strategy, keys.strategyCustody, keys.market, keys.price, keys.supplyPool, keys.supplyPosition];
  const redemptionAccounts = activation.autoRecallEnabled
    ? [...pricingAccounts, keys.lendingCash, keys.borrowMarket, strategyLendingProgram] : pricingAccounts;
  return {
    autoRecallEnabled: activation.autoRecallEnabled,
    config: { address: keys.strategy, manager, strategyMint, market: keys.market, reserveBps, lendingCapBps, maxTradeBps, strategyDecimals },
    spotRaw, strategyValueRaw, lendingSharesRaw, lendingValueRaw, navRaw, maxLendRaw, maxRecallRaw: recall.assetsRaw,
    maxRecallSharesRaw: recall.sharesRaw, priceRaw, swapCashRaw, swapSpotRaw, poolAssetsRaw, poolSharesRaw,
    pricingAccounts, redemptionAccounts,
  };
}

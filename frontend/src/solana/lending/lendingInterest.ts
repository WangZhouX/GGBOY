import type { Buffer } from 'buffer';

/** 计息池与个人仓位兼容旧账户前缀，扩展的起点和总长度均以字节计。 Indexed pools and positions keep the legacy account prefix. All offsets and sizes are in bytes. */
export const lendingInterestLayouts = {
  pool: { legacySize: 56, size: 88, start: 56, trackedCash: 64, normalizedDebt: 72 },
  position: { legacySize: 88, size: 112, start: 88, normalizedDebt: 96 },
} as const;

/** 名义借款年率的基点值与每个链上整分钟对应的定点增长倍率。 Nominal borrow APR in basis points and fixed-point growth factor for one complete chain minute. */
export const lendingFixedAprBps = 1_000n;
const indexScale = 1_000_000_000_000n;
const minuteGrowthFactor = indexScale + 190_258n;
/** 归一化份额在初始指数下按六位额外精度记账。 Normalized debt shares use six additional decimal places at the initial index. */
const normalizedDebtScale = indexScale * 1_000_000n;
/** Rust 计算的整数边界。 Integer limits of the Rust projection. */
const maxU64 = (1n << 64n) - 1n;
const maxU128 = (1n << 128n) - 1n;

/**
 * 读取 Borsh 小端无符号 128 位份额字段。
 * Decode a little-endian Borsh u128 share field.
 *
 * @param data 已通过长度校验的程序账户字节。 Program account bytes with a verified length.
 * @param offset 字段在账户中的字节偏移。 Byte offset into the account.
 */
function readU128(data: Buffer, offset: number) {
  return data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
}

/**
 * 按 Rust 的 u128 范围计算中间乘积，超出链上范围时拒绝报价。
 * Multiply within the Rust u128 range and reject a quote outside the on-chain range.
 *
 * @param left 第一个非负整数。 First nonnegative integer.
 * @param right 第二个非负整数。 Second nonnegative integer.
 */
function checkedMultiply(left: bigint, right: bigint) {
  /** 先保存未缩放的完整乘积，对齐链上 checked_mul 后再除法。 Keep the unscaled product to match checked_mul before division on-chain. */
  const product = left * right;
  if (product > maxU128) throw new Error('Lending interest arithmetic overflow.');
  return product;
}

/**
 * 使用平方求幂计算已完成分钟的统一债务指数。每次定点乘法向下取整。
 * Exponentiate complete minutes to the common debt index, flooring after each fixed-point multiplication.
 *
 * @param startedAt 市场启用计息的链上 Unix 秒。 On-chain Unix second at interest activation.
 * @param observedAt 同一观测的 Clock Unix 秒。 Clock Unix second from the same observation.
 */
function debtIndex(startedAt: bigint, observedAt: bigint) {
  /** 乱序但可解码的时钟观测只保留初始倍率。 A backwards clock observation retains the starting index. */
  let minutes = observedAt > startedAt ? (observedAt - startedAt) / 60n : 0n;
  let result = indexScale;
  let factor = minuteGrowthFactor;
  while (minutes > 0n) {
    if (minutes % 2n === 1n) result = checkedMultiply(result, factor) / indexScale;
    minutes /= 2n;
    if (minutes > 0n) factor = checkedMultiply(factor, factor) / indexScale;
  }
  return result;
}

/**
 * 还原当期应付额，按借款 Mint 最小单位向上取整。
 * Restore the debt due at the observation time, rounding up to a debt mint base unit.
 *
 * @param shares 归一化债务份额。 Normalized debt shares.
 * @param index 同槽的市场整数定点债务指数。 Fixed-point debt index of the same-slot market.
 */
function projectDebt(shares: bigint, index: bigint) {
  if (shares === 0n) return 0n;
  /** 先分离整单位和余数再乘指数，与链上拆分一致，避免中间乘积过大。 Split whole units and remainder before applying the index to match the on-chain calculation and bound intermediate products. */
  const whole = checkedMultiply(shares / normalizedDebtScale, index);
  const remainder = checkedMultiply(shares % normalizedDebtScale, index);
  const raw = whole + remainder / normalizedDebtScale + (remainder % normalizedDebtScale === 0n ? 0n : 1n);
  if (raw > maxU64) throw new Error('Indexed lending debt exceeds the token amount range.');
  return raw;
}

/**
 * 从已验证的出借记账账户投影全市场债务和账面资产。
 * Project aggregate debt and book assets from an already validated supply ledger.
 *
 * @param data 规范 SupplyPool 账户的字节，未创建时为空。 Canonical SupplyPool account bytes, or null before creation.
 * @param legacyAssetsRaw 旧前缀中的资产最小单位金额。 Asset amount from the legacy prefix, in base units.
 * @param legacyDebtRaw 旧借款总账的本金最小单位数量。 Principal base units from the legacy debt ledger.
 * @param clockUnixTimestamp 同批 Clock 给出的 Unix 秒。 Unix second from the same-batch Clock.
 */
export function projectLendingInterest(
  data: Buffer | null, legacyAssetsRaw: bigint, legacyDebtRaw: bigint, clockUnixTimestamp: bigint,
) {
  /** 对传统市场沿用可核实的本金账本，只有受验证的新版尺寸才解码扩展。 Preserve verified principal accounting in a legacy market. Decode extensions only at the known active size. */
  const layout = lendingInterestLayouts.pool;
  if (!data || data.length === layout.legacySize) {
    return { accountedAssetsRaw: legacyAssetsRaw, totalDebtRaw: legacyDebtRaw, interestEnabled: false, interestStartedAt: null, marketNormalizedShares: null };
  }
  if (data.length !== layout.size) throw new Error('Unknown lending interest pool layout.');
  const interestStartedAt = data.readBigInt64LE(layout.start);
  if (interestStartedAt <= 0n) throw new Error('The indexed lending epoch is invalid.');
  /** 记账现金独立于债务倍率。链上账外存款不加入池资产。 Tracked cash is independent of the debt index. Unaccounted transfers do not increase book assets. */
  const trackedCashRaw = data.readBigUInt64LE(layout.trackedCash);
  const normalizedShares = readU128(data, layout.normalizedDebt);
  const totalDebtRaw = projectDebt(normalizedShares, debtIndex(interestStartedAt, clockUnixTimestamp));
  const accountedAssetsRaw = trackedCashRaw + totalDebtRaw;
  if (accountedAssetsRaw > maxU64) throw new Error('Indexed lending assets exceed the token amount range.');
  return { accountedAssetsRaw, totalDebtRaw, interestEnabled: true, interestStartedAt, marketNormalizedShares: normalizedShares };
}

/**
 * 投影同一市场的个人债务。无扩展的旧仓位仅能在计息池中保留零本金。
 * Project wallet debt in the same market. A legacy position may remain in an indexed pool only with zero principal.
 *
 * @param data 已核对仓位身份的账户字节，未建仓时为空。 Identity-checked position bytes, or null before creation.
 * @param legacyDebtRaw 旧前缀债务最小单位。 Debt base units from the legacy prefix.
 * @param clockUnixTimestamp 同批 Clock 给出的 Unix 秒。 Unix second from the same-batch Clock.
 * @param poolEpoch 同批计息池的启动 Unix 秒，旧版市场为空。 Activation Unix second of the same-batch pool, or null in a legacy market.
 * @param marketNormalizedShares 同槽市场的归一化债务份额总量，旧版市场为空。 Same-slot market's total normalized debt shares, or null in a legacy market.
 */
export function projectLendingPositionDebt(
  data: Buffer | null, legacyDebtRaw: bigint, clockUnixTimestamp: bigint, poolEpoch: bigint | null,
  marketNormalizedShares: bigint | null,
) {
  /** 旧的零债务仓位无需扩容。 Empty legacy positions can remain unextended. */
  const layout = lendingInterestLayouts.position;
  let normalizedShares = 0n;
  if (!data || data.length === layout.legacySize) {
    if (poolEpoch === null) return { debtRaw: legacyDebtRaw, debtShareQuote: null };
    if (legacyDebtRaw !== 0n) throw new Error('Legacy principal remains in the indexed lending pool.');
  } else {
    if (data.length !== layout.size || poolEpoch === null || data.readBigInt64LE(layout.start) !== poolEpoch) {
      throw new Error('The indexed lending position does not match the pool epoch.');
    }
    normalizedShares = readU128(data, layout.normalizedDebt);
  }
  /** 整数指数和债务份额还用于精确计算增借和部分还款的前端报价。 The index and normalized shares also drive precise borrowing and partial repayment quotes. */
  if (marketNormalizedShares === null || normalizedShares > marketNormalizedShares) {
    throw new Error('Indexed position shares exceed the lending market total.');
  }
  const index = debtIndex(poolEpoch, clockUnixTimestamp);
  return { debtRaw: projectDebt(normalizedShares, index), debtShareQuote: { index, normalizedShares, marketNormalizedShares } };
}

/** 同槽计息市场的债务指数及钱包归一化份额。 Same-slot lending index and normalized wallet debt shares. */
export interface LendingDebtShareQuote {
  /** 采用 10^12 定点倍率的同槽债务指数。 Same-slot debt index on a 10^12 fixed-point scale. */
  index: bigint;
  /** 钱包归一化债务份额。 Normalized wallet debt shares. */
  normalizedShares: bigint;
  /** 同槽市场归一化债务份额总量。 Same-slot total normalized debt shares for the market. */
  marketNormalizedShares: bigint;
}

/**
 * 反推风险上限下允许的新借款最小单位数量。
 * Invert the risk ceiling into the largest additional debt mint base-unit input.
 *
 * @param ceilingRaw 风险校验允许的钱包债务总额。 Maximum wallet debt allowed by the risk check.
 * @param quote 同槽计息指数和个人债务份额。 Same-slot index and borrower debt shares.
 */
export function indexedBorrowCapacity(ceilingRaw: bigint, quote: LendingDebtShareQuote) {
  /** 向上取整后的新总债务不能超过风险上限，因此允许的总份额要向下取整。 The allowed total shares round down so rounded-up debt cannot breach the risk ceiling. */
  const bounded = ceilingRaw < maxU64 ? ceilingRaw : maxU64;
  const remaining = bounded * normalizedDebtScale / quote.index - quote.normalizedShares;
  return remaining > 0n ? remaining * quote.index / normalizedDebtScale : 0n;
}

/**
 * 计算授权上限内实际可能转入资金池的金额和偿还后的个人债务份额。
 * Calculate the estimated pool payment and remaining borrower shares under a signed limit.
 *
 * @param quote 同槽债务指数及个人和全池的归一化份额。 Same-slot index and normalized borrower and pool debt shares.
 * @param paymentLimit 允许扣除的最大借款代币最小单位。 Maximum authorized payment in debt mint base units.
 */
export function indexedDebtPayment(quote: LendingDebtShareQuote, paymentLimit: bigint) {
  const { index, normalizedShares, marketNormalizedShares } = quote;
  if (paymentLimit <= 0n || normalizedShares === 0n) return { amountRaw: 0n, remainingShares: normalizedShares };
  /** 反推保持市场向上取整的债务不少于市场旧债务减授权输入的最小总份额。 Invert the aggregate ceiling to keep pool debt at or above old debt minus the signed payment limit. */
  const marketDebt = projectDebt(marketNormalizedShares, index);
  const required = marketDebt > paymentLimit
    ? (marketDebt - paymentLimit - 1n) * normalizedDebtScale / index + 1n : 0n;
  const maximumReduction = marketNormalizedShares - required;
  const reducedShares = maximumReduction < normalizedShares ? maximumReduction : normalizedShares;
  const remainingShares = normalizedShares - reducedShares;
  const reduction = marketDebt - projectDebt(marketNormalizedShares - reducedShares, index);
  /** 一个个人仓位已全部结清、而全池整数债务未变化时，仍支付一个借款代币最小单位。 Pay one debt mint base unit when closing a wallet position that leaves the rounded pool debt unchanged. */
  const amountRaw = remainingShares === 0n && reduction === 0n ? 1n : reduction;
  return { amountRaw, remainingShares };
}

/**
 * 报出增借或偿还后的钱包债务，交易执行时以新的 Clock 重算。
 * Estimate borrower debt after borrowing or repayment. Execution recomputes with a fresh Clock.
 *
 * @param quote 同槽债务指数和归一化份额。 Same-slot debt index and normalized shares.
 * @param debtChangeRaw 借款 Mint 最小单位，增借为正、还款上限为负。 Debt mint base units, positive for borrow and negative for the repayment cap.
 */
export function indexedDebtAfterChange(quote: LendingDebtShareQuote, debtChangeRaw: bigint) {
  const { index, normalizedShares } = quote;
  if (debtChangeRaw < 0n) {
    return projectDebt(indexedDebtPayment(quote, -debtChangeRaw).remainingShares, index);
  }
  /** 增借份额向上取整，欠款须覆盖实际发出的借款。 Round up new shares so the debt backs the actual cash payout. */
  const numerator = checkedMultiply(debtChangeRaw, normalizedDebtScale);
  const delta = numerator / index + (numerator % index === 0n ? 0n : 1n);
  return projectDebt(normalizedShares + delta, index);
}

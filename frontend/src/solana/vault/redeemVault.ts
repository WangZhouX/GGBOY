import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PACKET_DATA_SIZE, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { devnetVaultConfig } from './devnetVault';
import {
  prepareVaultTransaction,
  validateVaultAmounts,
  VaultTransactionError,
  type PreparedVaultTransaction,
} from './vaultTransaction';

export {
  VaultTransactionError as VaultRedeemTransactionError,
  waitForVaultTransaction as waitForVaultRedeem,
  type PreparedVaultTransaction as PreparedVaultRedeem,
  type VaultTransactionErrorCode as VaultRedeemTransactionErrorCode,
} from './vaultTransaction';

/** 钱包名下可销毁份额的 SPL Token 账户。 Wallet-owned SPL Token account with shares eligible for burning. */
interface RedeemShareAccount {
  /** 已验证归属和 Mint 的 GG-V 账户地址。 GG-V account address with verified owner and mint. */
  address: PublicKey;
  /** 此账户持有的份额，以 GG-V 最小单位计。 Account balance in GG-V base units. */
  amountRaw: bigint;
}

/** Devnet 赎回所需的钱包、上下文和最低到账。 Wallet, context, and minimum payout for Devnet redemption. */
export interface PrepareVaultRedeemRequest {
  /** 已授权的 Phantom Base58 钱包地址。 Authorized Phantom wallet's Base58 address. */
  walletAddress: string;
  /** 要销毁的份额，单位为 GG-V 最小单位。 Shares to burn, in GG-V base units. */
  sharesRaw: bigint;
  /** 最低到账，以 mockUSDC 最小单位计。 Minimum payout in mockUSDC base units. */
  minAssetsRaw: bigint;
  /** 钱包和金库读数使用的已确认 RPC slot。 Confirmed RPC slot of the wallet and vault observation. */
  minContextSlot: number;
  /** 来自同一次读取、未冻结的 GG-V 来源账户。 Unfrozen GG-V source accounts from the same read. */
  shareAccounts: readonly RedeemShareAccount[];
}

/** 取初始化和读链检查固定的 GG-V Mint 精度。 GG-V precision fixed by initialization and checked on vault reads. */
const shareMintDecimals = 6;
/** 一个公钥占 32 字节，来源账户独占的空间不得超过整笔交易。 A public key takes 32 bytes; source accounts alone cannot exceed the whole packet. */
const maxShareTransfers = Math.floor(PACKET_DATA_SIZE / 32);

/**
 * 优先用单个足额账户。否则从其他余额最大的账户按需归集，减少 SPL 转账数量。
 * Prefer one account that covers the request. Otherwise consolidate from the largest balances and minimize SPL transfers.
 *
 * @param investor Phantom 授权的账户所有者。 Account owner authorized by Phantom.
 * @param sharesRaw 要赎回的 GG-V 最小单位。 GG-V base units to redeem.
 * @param shareAccounts 读链校验过的钱包份额账户。 Wallet share accounts validated by the chain read.
 */
function selectShareSource(investor: PublicKey, sharesRaw: bigint, shareAccounts: readonly RedeemShareAccount[]) {
  /** 按数量排序后使用余额最大的账户承接归集，避免创建中间账户。 Consolidate in the largest existing account so no intermediate account creation is needed. */
  const candidates = shareAccounts.filter(({ amountRaw }) => amountRaw > 0n)
    .sort((left, right) => left.amountRaw === right.amountRaw ? 0 : left.amountRaw > right.amountRaw ? -1 : 1);
  /** 份额销毁来源是钱包名下余额最大的账户。 Burn shares from the wallet's largest share account. */
  const destination = candidates[0];
  if (!destination) throw new VaultTransactionError('insufficientShares');

  /** 最大账户所缺份额，以 GG-V 最小单位计。 Amount missing in the largest account, in GG-V base units. */
  let remaining = sharesRaw - destination.amountRaw;
  /** 每条归集以当前钱包签名授权，均与后续赎回在同一笔交易。 The current wallet authorizes each transfer in the same transaction as redemption. */
  const transfers: TransactionInstruction[] = [];
  /** RPC 同一个账户只计一次，以免把重复条目当成可赎回数量。 Count each RPC account once to avoid treating a duplicate as redeemable shares. */
  const used = new Set([destination.address.toBase58()]);
  for (const source of candidates.slice(1)) {
    if (remaining <= 0n) break;
    /** 每笔归集只转入补齐本次赎回所需的数量。 Each transfer moves only the shares still needed for this redemption. */
    const amount = source.amountRaw < remaining ? source.amountRaw : remaining;
    const address = source.address.toBase58();
    if (used.has(address)) continue;
    used.add(address);

    if (transfers.length >= maxShareTransfers) throw new VaultTransactionError('tooManyShareAccounts');
    transfers.push(createTransferCheckedInstruction(
      source.address, devnetVaultConfig.shareMint, destination.address, investor, amount, shareMintDecimals,
    ));
    remaining -= amount;
  }

  if (remaining > 0n) throw new VaultTransactionError('insufficientShares');
  return { address: destination.address, transfers };
}

/**
 * 模拟归集、销毁份额和支付，返回由 Phantom 签名的 Devnet 交易。
 * Simulate share consolidation, burning, and payment, then return the Devnet transaction for Phantom.
 *
 * @param request 钱包、实际可用份额账户、已确认 slot、提交份额和最低到账。 Wallet, spendable share accounts, confirmed slot, input shares, and minimum payout.
 * @returns 只模拟通过后返回的原子赎回交易及其有效期。 Atomic redemption transaction and its lifetime, returned only after a successful simulation.
 */
export async function prepareVaultRedeem(request: PrepareVaultRedeemRequest): Promise<PreparedVaultTransaction> {
  validateVaultAmounts(request.sharesRaw, request.minAssetsRaw);
  try {
    /** 签名人既是份额来源账户所有者，也是 mockUSDC 收款人和费用支付人。 The signer owns the source shares, receives mockUSDC, and pays the fee. */
    const investor = new PublicKey(request.walletAddress);
    /** 关联账户不存在时在同一笔交易里创建，已有账户时保持幂等。 Create the ATA in this same transaction if missing, or leave an existing account intact. */
    const assetMint = devnetVaultConfig.assetMint;
    const investorAsset = getAssociatedTokenAddressSync(assetMint, investor);
    /** 链上只调用一次 redeem，使销毁和按比例向下取整的计算各发生一次。 Call redeem once so burn and proportional floor rounding happen once. */
    const source = selectShareSource(investor, request.sharesRaw, request.shareAccounts);

    return await prepareVaultTransaction({
      kind: 'redeem',
      investor,
      investorAsset,
      investorShares: source.address,
      amountRaw: request.sharesRaw,
      minOutputRaw: request.minAssetsRaw,
      minContextSlot: request.minContextSlot,
      setup: [
        createAssociatedTokenAccountIdempotentInstruction(investor, investorAsset, investor, assetMint),
        ...source.transfers,
      ],
    });
  } catch (error) {
    if (error instanceof VaultTransactionError) throw error;
    throw new VaultTransactionError('preparationFailed', error);
  }
}

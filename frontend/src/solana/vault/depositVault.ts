import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { devnetVaultConfig } from './devnetVault';
import {
  prepareVaultTransaction,
  validateVaultAmounts,
  VaultTransactionError,
  type PreparedVaultTransaction,
} from './vaultTransaction';

export {
  VaultTransactionError as VaultDepositTransactionError,
  waitForVaultTransaction as waitForVaultDeposit,
  type PreparedVaultTransaction as PreparedVaultDeposit,
  type VaultTransactionErrorCode as VaultDepositTransactionErrorCode,
  type VaultTransactionLifetime as VaultDepositLifetime,
} from './vaultTransaction';

/** Devnet 现金金库存入所需的签名账户、金额和报价 slot。 Signer, amounts, and quote slot for a Devnet cash-vault deposit. */
export interface PrepareVaultDepositRequest {
  /** 已连接 Phantom 钱包的 Base58 公钥，作为存款人和费用支付人。 Connected Phantom Base58 key, used as the investor and fee payer. */
  walletAddress: string;
  /** mockUSDC 存入量，单位为六位精度下的最小单位。 mockUSDC deposit amount in base units at six decimals. */
  assetsRaw: bigint;
  /** 用户接受的最低 GG-V，单位为六位精度下的最小单位。 Minimum accepted GG-V in base units at six decimals. */
  minSharesRaw: bigint;
  /** 报价使用的已确认 RPC slot，后续模拟不能用更早状态。 Confirmed quote slot that simulation must not precede. */
  minContextSlot: number;
}

/**
 * 创建必要的 GG-V 关联账户并模拟存款，成功后返回待签名交易。
 * Include the required GG-V ATA creation and simulate the deposit before returning an unsigned transaction.
 *
 * @param request 钱包地址、最小单位数量和报价的已确认 slot。 Wallet address, base-unit amounts, and confirmed quote slot.
 * @returns 原子创建 GG-V 关联账户并存款的交易及其有效期。 Unsigned deposit and ATA creation transaction with its lifetime.
 */
export async function prepareVaultDeposit(request: PrepareVaultDepositRequest): Promise<PreparedVaultTransaction> {
  validateVaultAmounts(request.assetsRaw, request.minSharesRaw);
  try {
    /** Phantom 钱包作为唯一签名人，支付交易和首次创建关联账户的费用。 Phantom is the sole signer and pays transaction and first ATA creation costs. */
    const investor = new PublicKey(request.walletAddress);
    /** 份额 Mint 为入账目标，结算 Mint 为扣款来源。 Share mint for incoming shares and settlement mint for the debit. */
    const { assetMint, shareMint } = devnetVaultConfig;
    const investorAsset = getAssociatedTokenAddressSync(assetMint, investor);
    const investorShares = getAssociatedTokenAddressSync(shareMint, investor);

    return await prepareVaultTransaction({
      kind: 'deposit',
      investor,
      investorAsset,
      investorShares,
      amountRaw: request.assetsRaw,
      minOutputRaw: request.minSharesRaw,
      minContextSlot: request.minContextSlot,
      setup: [createAssociatedTokenAccountIdempotentInstruction(investor, investorShares, investor, shareMint)],
    });
  } catch (error) {
    if (error instanceof VaultTransactionError) throw error;
    throw new VaultTransactionError('preparationFailed', error);
  }
}

import { devnetVaultConfig } from '../../solana/vault/devnetVault';
import type { VaultListItem } from './api/listVaults';

/** 金库和资产总览共用的实时缓存前缀。 Live cache prefix shared by the vault and portfolio pages. */
export const devnetVaultQueryPrefix = ['devnet-vault-state'] as const;

/**
 * 生成当前金库和钱包的读链缓存键。
 * Create the chain-read key for the current vault and wallet.
 *
 * @param vaultAddress 已登记金库的公钥，尚未加载目录时为空。 Registered vault public key, omitted while the catalog is loading.
 * @param walletAddress 当前已连接的钱包公钥，公开金库查询传入空值。 Connected wallet public key, or null for a public vault read.
 * @returns 按部署和钱包隔离的缓存键。 Cache key scoped to the deployment and wallet.
 */
export function devnetVaultStateKey(vaultAddress: string | undefined, walletAddress: string | null) {
  return [...devnetVaultQueryPrefix, vaultAddress, walletAddress] as const;
}

/**
 * 检查登记是否匹配可读写的 GGBOY Devnet 金库。
 * Check that a registry entry matches the readable and writable GGBOY Devnet vault.
 *
 * @param vault 公开目录中的金库配置。 Vault configuration from the public registry.
 * @returns 网络、程序、金库、两种 Mint 和精度均匹配时为 true。 True when the network, program, vault, both mints and decimals match.
 */
export function isSupportedDevnetVault(vault: VaultListItem): boolean {
  return vault.network === 'devnet' &&
    vault.address === devnetVaultConfig.vaultAddress.toBase58() &&
    vault.programId === devnetVaultConfig.programId.toBase58() &&
    vault.quoteAsset.mint === devnetVaultConfig.assetMint.toBase58() &&
    vault.shareAsset.mint === devnetVaultConfig.shareMint.toBase58() &&
    vault.quoteAsset.decimals === 6 && vault.shareAsset.decimals === 6;
}

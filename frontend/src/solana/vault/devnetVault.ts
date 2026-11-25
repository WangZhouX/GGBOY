import { ACCOUNT_SIZE, MINT_SIZE, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from '@solana/spl-token';
import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { devnetRpcUrl } from '../getDevnetSolBalance';
import { decodeVaultStrategy, strategyVaultStateSize, vaultStrategyAddresses, vaultStrategyObservationKeys, type VaultStrategyHoldings } from './strategyVaultAccounts';
import vaultIdl from './ggboyVaultIdl.json';

/** 已部署到 Devnet 的现金金库程序公钥。 Public key of the cash vault program deployed on Devnet. */
const programId = new PublicKey(vaultIdl.address);
/** Anchor 的固定金库种子和规范 bump，在读取状态时复核。 Fixed Anchor vault seed and canonical bump, verified when reading the state. */
const [vaultAddress, vaultBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], programId);
/** 从金库公钥派生托管账户和份额 Mint 所用的公开种子。 Public seeds that derive the custody account and the share mint from the vault. */
const [cashVault] = PublicKey.findProgramAddressSync(
  [new TextEncoder().encode('cash_vault'), vaultAddress.toBytes()], programId,
);
const [shareMint] = PublicKey.findProgramAddressSync(
  [new TextEncoder().encode('share_mint'), vaultAddress.toBytes()], programId,
);

/** Devnet 金库已核实的公开地址，读链和构造交易共用。 Verified public Devnet vault addresses shared by account reads and transaction construction. */
export const devnetVaultConfig = {
  programId,
  vaultAddress,
  cashVault,
  /** 初始化时指定的六位 mockUSDC Mint 公钥。 Public key of the six-decimal mockUSDC mint bound at initialization. */
  assetMint: new PublicKey('62vB22oh8fjXtitpKX3nLKyk9J7CVKb4ueKZcDGP1o1X'),
  shareMint,
  vaultBump,
  rpcUrl: devnetRpcUrl,
} as const;

/** 链上读金库所需的已核验登记和 RPC。 Verified registration and RPC endpoint for reading one vault deployment. */
export type VaultDeployment = Omit<typeof devnetVaultConfig, 'rpcUrl'> & { readonly rpcUrl: string };

/** Vault 在构建产物 IDL 中的八字节 Anchor 账户标识。 Eight-byte Anchor discriminator for Vault in the generated IDL. */
const vaultDiscriminator = vaultIdl.accounts.find(({ name }) => name === 'Vault')?.discriminator;
/** Vault 固定布局中的字节位置。 Byte offsets for the fixed Vault layout. */
const vaultLayout = { assetMint: 40, cashVault: 72, shareMint: 104, bump: 136, length: 137 } as const;
/** 首版结算资产和 GG-V 共用的代币小数位数。 Decimal places shared by the initial settlement token and GG-V. */
const tokenDecimals = 6;
/** 单次读链的总等待时间，以毫秒计。 Overall time budget for a read in milliseconds. */
const readTimeoutMs = 12_000;
/** 并行读取跨两个 slot 时重试的上限。 Limit on attempts when parallel reads cross two slots. */
const maxObservations = 3;

/**
 * 可作为赎回来源的钱包 GG-V 账户。
 * A wallet-owned GG-V account usable as a redemption source.
 */
export interface RedeemableShareAccount {
  /** 经典 SPL 代币账户的公钥。 Public key of the classic SPL token account. */
  address: PublicKey;
  /** 当次观测的 GG-V 最小单位数量。 GG-V base units at the observed slot. */
  amountRaw: bigint;
}

/** 已选钱包在金库中的链上余额。 On-chain balances for the selected wallet. */
interface DevnetVaultWalletBalances {
  /** 规范 mockUSDC 关联账户的可存资产，以最小单位计。 Depositable balance in the canonical mockUSDC ATA, in base units. */
  assetBalanceRaw: bigint;
  /** 钱包拥有的所有 GG-V 账户合计，以最小单位计。 Total across all wallet-owned GG-V token accounts, in base units. */
  sharesRaw: bigint;
  /** 可合并后销毁的 GG-V 最小单位数量。 GG-V base units eligible for consolidation and burning. */
  redeemableSharesRaw: bigint;
  /** 核验过的未冻结正余额 GG-V 来源账户。 Verified non-frozen GG-V sources with positive balances. */
  shareAccounts: readonly RedeemableShareAccount[];
  /** 钱包 mockUSDC 收款余额，没有 ATA 为零，冻结时为空。 Wallet mockUSDC payout balance, zero without an ATA and null when frozen. */
  receivableAssetBalanceRaw: bigint | null;
}

/** 同一个 Devnet 已确认 slot 中的现金金库与钱包观测。 Cash vault and wallet observation from one confirmed Devnet slot. */
export interface DevnetVaultState extends VaultStrategyHoldings {
  /** RPC 返回的已确认观测 slot。 Confirmed observation slot returned by RPC. */
  slot: number;
  /** 浏览器读取该状态的 ISO 8601 UTC 时间。 ISO 8601 UTC time at which the browser read the state. */
  observedAt: string;
  /** 金库托管账户余额，以 mockUSDC 最小单位计。 Vault custody balance in mockUSDC base units. */
  cashRaw: bigint;
  /** GG-V Mint 当前供给量，以份额最小单位计。 Current GG-V mint supply, in share base units. */
  totalSharesRaw: bigint;
  /** 可选的已授权钱包余额，未连接时为空。 Optional authorized wallet balances, or null without a connected wallet. */
  wallet: DevnetVaultWalletBalances | null;
}

/**
 * 核对 Anchor 金库状态中的地址绑定和派生 bump。
 * Validate the Anchor vault's account bindings and derivation bump.
 *
 * @param info RPC 读到的金库 PDA 账户。 Vault PDA account returned by RPC.
 * @param deployment 同网络登记的程序及账户绑定。 Same-network program and account bindings.
 * @returns 策略是否启用及链上标记的自动收回能力。 Strategy activation and on-chain automatic recall capability.
 */
function validateVaultAccount(info: AccountInfo<Buffer> | null, deployment: VaultDeployment) {
  if (!info || !info.owner.equals(deployment.programId) || info.executable ||
      (info.data.length !== vaultLayout.length && info.data.length !== strategyVaultStateSize)) {
    throw new Error('The configured Devnet vault account is invalid.');
  }

  /** 金库状态字节依次包含 discriminator、管理员、三项绑定和 bump。 Vault bytes contain the discriminator, administrator, three bindings and bump. */
  const data = info.data;
  if (
    vaultDiscriminator?.length !== 8 || !vaultDiscriminator.every((byte, index) => data[index] === byte) ||
    !new PublicKey(data.subarray(vaultLayout.assetMint, vaultLayout.cashVault)).equals(deployment.assetMint) ||
    !new PublicKey(data.subarray(vaultLayout.cashVault, vaultLayout.shareMint)).equals(deployment.cashVault) ||
    !new PublicKey(data.subarray(vaultLayout.shareMint, vaultLayout.bump)).equals(deployment.shareMint) ||
    data[vaultLayout.bump] !== deployment.vaultBump
  ) {
    throw new Error('The vault account bindings do not match this deployment.');
  }
  /** 仅已扩展的状态可通过第 137 字节启用自动收回。 Only extended states can enable recall at byte 137. */
  const active = data.length === strategyVaultStateSize;
  return { active, autoRecallEnabled: active && (data[vaultLayout.length] & 1) !== 0 };
}

/**
 * 解码并验证经典 SPL Token 账户的持有人和 Mint。
 * Decode a classic SPL Token account and validate its authority and mint.
 *
 * @param address 账户自身的公钥。 Public key of the token account itself.
 * @param info RPC 返回的账户字节和归属。 Account bytes and ownership returned by RPC.
 * @param expectedMint 应绑定的 Mint 公钥。 Expected mint public key.
 * @param expectedOwner 应控制代币账户的钱包或 PDA 公钥。 Expected wallet or PDA controlling the token account.
 * @returns 验证后的代币账户，其余额以最小单位计。 Verified token account with its balance in base units.
 */
function readTokenAccount(address: PublicKey, info: AccountInfo<Buffer> | null, expectedMint: PublicKey, expectedOwner: PublicKey) {
  if (!info || info.executable || info.data.length !== ACCOUNT_SIZE) {
    throw new Error('The Devnet token account does not have the classic SPL layout.');
  }

  /** SPL Token 解码器校验账户归属，并保留 bigint 余额。 The SPL Token decoder verifies program ownership and preserves bigint balances. */
  const account = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  if (!account.isInitialized || account.isNative || !account.mint.equals(expectedMint) || !account.owner.equals(expectedOwner)) {
    throw new Error('The Devnet token account has unexpected mint or owner.');
  }
  return account;
}

/**
 * 读取已部署 Devnet 现金金库。提供公钥时，同步读取其可存资金和份额。
 * Read the deployed Devnet cash vault and, when a wallet is supplied, its depositable balance and shares.
 *
 * @param walletAddress 已获钱包授权的 Base58 公钥，省略时只读金库。 Authorized Base58 wallet public key, omitted for a vault-only read.
 * @param minContextSlot 存入确认时的最小 slot，防止刷新读回交易之前。 Minimum slot from transaction confirmation to prevent a pre-deposit refresh.
 * @param signal 页面卸载或切换钱包时可取消请求。 Optional signal for cancelling when the page unmounts or wallet changes.
 * @returns 同一个已确认 slot 的金库状态和可选的钱包余额。 Vault state and optional wallet balances at the same confirmed slot.
 * @throws RPC 失败、查询取消、观测 slot 不一致或链上账户校验未通过时。 On RPC or cancellation errors, mismatched slots or invalid accounts.
 */
export function readDevnetVault(
  walletAddress?: string | null,
  minContextSlot?: number,
  signal?: AbortSignal,
): Promise<DevnetVaultState> {
  return readVaultAccounts(devnetVaultConfig, walletAddress, minContextSlot, signal);
}

/**
 * 按同一确认槽读取部署的金库、策略和可选钱包账户。
 * Read vault, strategy, and optional wallet accounts at the same confirmed slot.
 *
 * @param deployment 已核验的同网络金库绑定。 Verified same-network vault bindings.
 * @param walletAddress 钱包公钥，省略时仅采样金库。 Wallet public key, omitted for a vault-only read.
 * @param minContextSlot 确认交易之后重新读取所需的最低 slot。 Minimum slot when refreshing after a confirmed transaction.
 * @param signal 调用方取消读取的可选信号。 Optional caller cancellation signal.
 */
export async function readVaultAccounts(
  deployment: VaultDeployment,
  walletAddress?: string | null,
  minContextSlot?: number,
  signal?: AbortSignal,
): Promise<DevnetVaultState> {
  /** 同网络登记的只读 RPC 与地址。 Registered RPC endpoint and addresses for the same network. */
  const { programId, vaultAddress, cashVault, assetMint, shareMint, rpcUrl } = deployment;
  /** 超时覆盖整个读取流程，并保留调用方的主动取消。 The timeout covers the full read and preserves caller cancellation. */
  const timeout = AbortSignal.timeout(readTimeoutMs);
  const readSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  /** 读链以 confirmed 为准，让确认后的页面刷新看到同一笔存入。 Read at confirmed so the post-confirmation refresh can see the deposit. */
  const rpc = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: readSignal }),
  });

  /** 规范关联账户是存入指令实际使用的扣款来源。 The canonical ATA is the debit source used by the deposit instruction. */
  const wallet = walletAddress ? new PublicKey(walletAddress) : null;
  const walletAssetAddress = wallet ? getAssociatedTokenAddressSync(assetMint, wallet) : null;
  /** 可执行程序、金库身份、托管余额、结算 Mint 和份额供给一起采样。 Sample the executable program, vault identity, custody, settlement mint and share supply together. */
  /** 策略账户和可选钱包账户与现金一同采样，避免跨槽拼接净值。 Read strategy and optional wallet accounts with cash to avoid cross-slot NAV. */
  const strategyAddresses = vaultStrategyAddresses(programId, vaultAddress);
  const baseKeys = [programId, vaultAddress, cashVault, assetMint, shareMint, ...vaultStrategyObservationKeys(strategyAddresses)];
  const keys = walletAssetAddress ? [...baseKeys, walletAssetAddress] : baseKeys;

  /** 两个 RPC 请求应用同一个确认级别和最低观测 slot。 Both RPC calls use the same commitment and minimum observation slot. */
  const config = { commitment: 'confirmed', minContextSlot } as const;
  for (let attempt = 0; attempt < maxObservations; attempt += 1) {
    readSignal.throwIfAborted();
    // 并行读取持有的全部份额账户，防止只统计规范 ATA 而少计转入其他账户的 GG-V。
    // Read all owned share accounts in parallel so GG-V held outside the canonical ATA is included.
    const [vaultResponse, sharesResponse] = await Promise.all([
      rpc.getMultipleAccountsInfoAndContext(keys, config),
      wallet ? rpc.getTokenAccountsByOwner(wallet, { mint: shareMint }, config) : null,
    ]);
    /** slot 一致时，钱包份额才与计算净值的资金余额和总供给相容。 Wallet holdings match the valuation balances and supply only at the same slot. */
    const slot = vaultResponse.context.slot;
    if (!Number.isSafeInteger(slot) || slot < (minContextSlot ?? 0) || vaultResponse.value.length !== keys.length) {
      throw new Error('Devnet RPC returned an invalid vault observation.');
    }
    if (sharesResponse && slot !== sharesResponse.context.slot) continue;

    /** 按请求顺序校验程序可执行，并检查金库身份、托管账户和两种 Mint。 Verify the executable program, vault identity, custody, and mints in request order. */
    const [programInfo, vaultInfo, cashInfo, assetInfo, shareInfo] = vaultResponse.value;
    const walletAssetInfo = walletAssetAddress ? vaultResponse.value[baseKeys.length] : null;
    if (!programInfo?.executable) throw new Error('The configured vault program is not executable.');
    const strategyState = validateVaultAccount(vaultInfo, deployment);
    /** 托管账户由金库 PDA 授权，余额以 mockUSDC 最小单位计。 Custody is controlled by the vault PDA and holds mockUSDC base units. */
    const custody = readTokenAccount(cashVault, cashInfo, assetMint, vaultAddress);
    if (custody.isFrozen) throw new Error('The Devnet custody account is frozen.');

    if (
      !assetInfo || !shareInfo || assetInfo.executable || shareInfo.executable ||
      assetInfo.data.length !== MINT_SIZE || shareInfo.data.length !== MINT_SIZE
    ) {
      throw new Error('The Devnet vault mints do not have the classic SPL layout.');
    }
    /** 两个 Mint 的精度必须与存入指令一致，份额 Mint 的铸造权必须为金库 PDA。 Both mints must match the deposit decimals, and only the vault PDA may issue shares. */
    const asset = unpackMint(assetMint, assetInfo, TOKEN_PROGRAM_ID);
    const share = unpackMint(shareMint, shareInfo, TOKEN_PROGRAM_ID);
    if (
      !asset.isInitialized || !share.isInitialized || asset.decimals !== tokenDecimals ||
      share.decimals !== tokenDecimals || !share.mintAuthority?.equals(vaultAddress) || share.freezeAuthority !== null
    ) {
      throw new Error('The Devnet vault mint metadata does not match the deployment.');
    }

    /** 未指定钱包时不需要计算账户余额。 No wallet balances are needed without a supplied wallet. */
    let balances: DevnetVaultWalletBalances | null = null;
    if (wallet && walletAssetAddress && sharesResponse) {
      /** 缺少关联账户时，可存 mockUSDC 为零。 A missing associated token account has zero depositable mockUSDC. */
      const walletAsset = walletAssetInfo
        ? readTokenAccount(walletAssetAddress, walletAssetInfo, assetMint, wallet)
        : null;
      /** 同一个钱包的份额最小单位数累加，不经过浮点数。 Sum the wallet's share base units without floating-point conversion. */
      let sharesRaw = 0n;
      /** 只累加可以作为本次交易来源的可用份额，单位为 GG-V 最小单位。 Sum only eligible transaction sources, in GG-V base units. */
      let redeemableSharesRaw = 0n;
      /** 保留已核验的来源地址和余额，用来选择赎回时需要的账户。 Keep verified source addresses and balances for redemption selection. */
      const shareAccounts: RedeemableShareAccount[] = [];
      for (const { pubkey, account } of sharesResponse.value) {
        /** 已核验 Mint 和所有人的 SPL 份额账户。 SPL share account with its mint and owner verified. */
        const tokenAccount = readTokenAccount(pubkey, account, shareMint, wallet);
        sharesRaw += tokenAccount.amount;
        if (!tokenAccount.isFrozen && tokenAccount.amount > 0n) {
          redeemableSharesRaw += tokenAccount.amount;
          shareAccounts.push({ address: pubkey, amountRaw: tokenAccount.amount });
        }
      }
      if (sharesRaw > share.supply) throw new Error('Wallet shares exceed the Devnet mint supply.');

      balances = {
        assetBalanceRaw: walletAsset && !walletAsset.isFrozen ? walletAsset.amount : 0n,
        sharesRaw,
        redeemableSharesRaw,
        shareAccounts,
        receivableAssetBalanceRaw: walletAsset?.isFrozen ? null : walletAsset?.amount ?? 0n,
      };
    }
    /** 与现金余额同槽解码，空策略保留纯现金定价。 Decode at the cash balance's slot, retaining cash pricing for legacy vaults. */
    const strategy = decodeVaultStrategy(deployment, strategyState, custody.amount, strategyAddresses,
      vaultResponse.value.slice(5, baseKeys.length));
    readSignal.throwIfAborted();
    return { slot, observedAt: new Date().toISOString(), cashRaw: custody.amount,
      totalSharesRaw: share.supply, wallet: balances, ...strategy };
  }
  throw new Error('Could not observe the Devnet vault and wallet at the same confirmed slot.');
}

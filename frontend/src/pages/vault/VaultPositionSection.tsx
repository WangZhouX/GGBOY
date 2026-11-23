import { skipToken, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getVaultPosition, type VaultPositionSnapshot } from '../../features/vault/api/getVaultPosition';
import type { VaultAsset, VaultListItem } from '../../features/vault/api/listVaults';
import { formatVaultAmount } from '../../features/vault/vaultAmounts';
import type { Network } from '../../shared/navigation/network';
import { usePhantomWallet } from '../../solana/phantomWallet';
import './styles/vault-position.css';

/** 策略金库页传入共享的金库选择，供仓位区查询。 Shared vault selection supplied by the vault page for the position lookup. */
interface VaultPositionSectionProps {
  /** 全站当前网络。 Network currently selected in the application. */
  network: Network;
  /** 当前选中的金库，未找到目录记录时为 undefined。 Selected vault, or undefined until a registration is available. */
  vault: VaultListItem | undefined;
  /** 首次查询的公开金库列表是否仍在加载。 Whether the first public vault list is still loading. */
  isVaultListPending: boolean;
  /** 无可用列表时区分加载中与请求失败。 Distinguishes loading from failure when no vault list is available. */
  isVaultListError: boolean;
  /** 已支持读链的 Devnet 仓位由页面提供；其他金库仍使用后端索引。 The page supplies the supported Devnet position; other vaults use the backend index. */
  livePosition?: LiveVaultPosition;
}

/** 钱包份额区所用的实时查询结果和刷新操作。 Live position result and refresh control used by the wallet section. */
interface LiveVaultPosition {
  /** 用当前钱包和金库同一次读取推导的仓位。 Position computed from the same wallet and vault read. */
  snapshot: VaultPositionSnapshot | undefined;
  /** 首次读链、读链错误与后台刷新状态。 Initial read, chain error, and background refresh states. */
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  /** 重新从 Devnet 读取当前钱包与金库。 Read the current wallet and vault from Devnet again. */
  refresh(): Promise<unknown>;
}

/** 已采集的仓位与选中金库的资产信息。 An observed position and the selected vault's asset metadata. */
interface VaultPositionDetailsProps {
  /** 同一个观测 slot 的持仓、估值和赎回额度。 Shares, valuation, and redemption limits from the same observed slot. */
  snapshot: VaultPositionSnapshot;
  /** 提供份额与计价资产各自的精度。 Supplies the respective precisions of shares and the settlement asset. */
  vault: VaultListItem;
}

/**
 * 显示仓位快照的三项主要指标和采集时间。
 * Render the three main position metrics and their snapshot time.
 *
 * @param props 已采集的仓位及金库目录。 Observed wallet position and vault metadata.
 */
function VaultPositionDetails({ snapshot, vault }: VaultPositionDetailsProps) {
  /** 界面语言同时控制数字和时间格式。 Use the UI language for both numbers and observation times. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 索引快照的观测时间，显示时统一换算为 UTC。 Index snapshot time, displayed in UTC. */
  const observationTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC',
  }).format(new Date(snapshot.observedAt));
  /** 用金额标题区分上次记录的可赎回估算。 Identify a previous redemption estimate in the amount label. */
  const redeemableLabel = snapshot.freshness === 'STALE'
    ? t('vaultPosition.previousRedeemableEstimate')
    : t('vaultPosition.redeemableEstimate');
  /** 只有两种估值都可用时才判断是否只能兑现部分份额价值。 Compare the payout with the value only when both amounts are known. */
  const showRedemptionLimit = snapshot.positionValueRaw !== null
    && snapshot.redeemableRaw !== null
    && snapshot.maxRedeemSharesRaw !== null
    && BigInt(snapshot.redeemableRaw) < BigInt(snapshot.positionValueRaw);

  /**
   * 用对应 Mint 的精度显示金额和单位，保留 null 与真实零的区别。
   * Format base units using the mint precision and preserve the distinction between null and zero.
   *
   * @param raw 资产最小单位的整数字符串，未知为 null。 Integer string in mint base units, or null if unknown.
   * @param asset 提供 Mint 精度与资产简称。 Supplies the mint precision and asset ticker.
   * @returns 带单位的显示值，缺数据时为本地化提示。 Display amount with its unit, or a localized availability message.
   */
  function displayAmount(raw: string | null, asset: VaultAsset) {
    if (raw === null) return t('vaultOverview.unavailable');

    /** 缺少简称时显示 Mint 缩写，完整地址保留在悬浮提示中。 Use an abbreviated mint if the ticker is missing, with the full address in the tooltip. */
    const unit = asset.symbol || `${asset.mint.slice(0, 4)}…${asset.mint.slice(-4)}`;
    return <>{formatVaultAmount(raw, asset.decimals, locale)} <span title={asset.mint}>{unit}</span></>;
  }

  return (
    <div className="vault-position__details">
      <p className="vault-position__observation">
        <time dateTime={snapshot.observedAt}>{t('vaultOverview.updatedAt', { time: observationTime })}</time>
      </p>
      <dl className="vault-position__metrics">
        <div>
          <dt>{t('vaultPosition.sharesHeld')}</dt>
          <dd>{displayAmount(snapshot.sharesRaw, vault.shareAsset)}</dd>
        </div>
        <div>
          <dt>{t('vaultPosition.positionValue')}</dt>
          <dd>{displayAmount(snapshot.positionValueRaw, vault.quoteAsset)}</dd>
        </div>
        <div>
          <dt>{redeemableLabel}</dt>
          <dd>{displayAmount(snapshot.redeemableRaw, vault.quoteAsset)}</dd>
        </div>
      </dl>
      {showRedemptionLimit && (
        <p className="vault-position__limit">
          {t('vaultPosition.redemptionLimit')}{' '}
          <strong>{displayAmount(snapshot.maxRedeemSharesRaw, vault.shareAsset)}</strong>
        </p>
      )}
    </div>
  );
}

/**
 * 为已连接的钱包查询选中金库的份额，并显示仓位或当前查询状态。
 * Query the connected wallet's position in the selected vault and render the position or its query state.
 *
 * @param props 当前网络、选中金库及公开列表请求状态。 Network, selected vault, and public list request status.
 */
export function VaultPositionSection({ network, vault, isVaultListPending, isVaultListError, livePosition }: VaultPositionSectionProps) {
  /** 仓位区使用当前界面的语言。 Use the selected language for position content. */
  const { t } = useTranslation();
  /** 由全站 Phantom 连接状态提供公钥，断开时为空。 Public key from the shared Phantom connection, or null if disconnected. */
  const { walletAddress } = usePhantomWallet();
  /** 页面所选金库的状态账户地址，目录尚不可用时为空。 Selected vault's state account address, or null until available. */
  const vaultAddress = vault?.address ?? null;
  /** 只有同时确定钱包与金库时仓位请求才有完整的路径参数。 Position requests have both path parameters only when a wallet and vault are known. */
  const canQuery = walletAddress !== null && vaultAddress !== null;

  /** 仓位数据和请求状态供下面的加载、空快照、错误和数据显示。 Position and query state feed the loading, empty snapshot, error, and success views. */
  const indexedPosition = useQuery({
    // 每个网络、金库和钱包分别缓存。切换任何一项时不沿用上一份仓位。
    // Cache each network, vault, and wallet separately so switches never reuse another position.
    queryKey: ['vault-position', network, vaultAddress, walletAddress],
    // skipToken 暂停请求，同时让 Hook 可以在每次渲染时调用。
    // skipToken disables the request while allowing the hook to run on every render.
    queryFn: canQuery && livePosition === undefined
      ? ({ signal }) => getVaultPosition({ network, address: vaultAddress, wallet: walletAddress }, signal)
      : skipToken,
  });

  /** 当 Devnet 读链可用时使用实时仓位，其他情况展示索引返回值。 Use live position for the supported Devnet vault and indexed values elsewhere. */
  const snapshot = livePosition ? livePosition.snapshot : indexedPosition.data?.snapshot;
  /** 跟随当前数据来源的请求状态。 Follow the request state from the active data source. */
  const { isPending, isError, isFetching } = livePosition ?? indexedPosition;

  /**
   * 点击刷新或重试时重查当前仓位的数据来源。
   * Refetch the active position source on refresh or retry.
   */
  function refreshPosition() {
    if (livePosition) void livePosition.refresh();
    else void indexedPosition.refetch();
  }

  return (
    <section className="vault-position" aria-labelledby="vault-position-title">
      <header className="vault-position__header">
        <h2 id="vault-position-title">{t('vaultPosition.title')}</h2>
        {canQuery && (
          <button type="button" className="vault-position__refresh" onClick={refreshPosition} disabled={isFetching}>
            {t(isError && !isFetching ? 'vaultPosition.retry' : 'vaultPosition.refresh')}
          </button>
        )}
      </header>
      {walletAddress === null && <p className="vault-position__status" role="status">{t('vaultPosition.connectPrompt')}</p>}
      {walletAddress !== null && !vault && (
        <p className="vault-position__status" role="status">
          {t(isVaultListError ? 'vaultPosition.vaultListError' : isVaultListPending ? 'vaultPosition.waitingForVaults' : 'vaultPosition.noVault')}
        </p>
      )}
      {canQuery && isPending && <p className="vault-position__status" role="status">{t('vaultPosition.loading')}</p>}
      {canQuery && isError && (
        <p className="vault-position__status vault-position__status--error" role="alert">
          {t(snapshot ? 'vaultPosition.refreshError' : livePosition ? 'vaultPosition.chainError' : 'vaultPosition.error')}
        </p>
      )}
      {canQuery && !isError && snapshot === null && (
        <p className="vault-position__status" role="status">{t('vaultPosition.awaitingSnapshot')}</p>
      )}
      {/* 只有查询成功拿到快照时才展示数值。 */}
      {/* Render values only after a query has returned a snapshot. */}
      {canQuery && vault && snapshot && <VaultPositionDetails snapshot={snapshot} vault={vault} />}
    </section>
  );
}

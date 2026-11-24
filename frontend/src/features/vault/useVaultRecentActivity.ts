import { skipToken, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { listActivities, type ActivityItem } from '../activity/api/listActivities';
import type { Network } from '../../shared/navigation/network';

/** 金库底部仅展示存入和赎回，沿用活动接口的事件代码。 The vault footer shows deposits and redemptions using the activity API's event codes. */
const vaultActivityTypes = ['VAULT_DEPOSIT', 'VAULT_REDEEM'] as const;
/** 底部区块显示的最大事件数量。 Maximum number of events displayed in the vault footer. */
const recentActivityLimit = 4;
/** 交易确认后的查询间隔和自动等待上限，单位为毫秒。 Polling interval and maximum automatic wait after confirmation, in milliseconds. */
const pollIntervalMs = 4_000;
const maxIndexWaitMs = 90_000;

/** 已确认的链上交易，等待活动索引追上。 An on-chain confirmation awaiting activity indexing. */
interface VaultActivityConfirmation {
  /** 交易的 Base58 主签名。 Base58 primary signature of the transaction. */
  signature: string;
  /** 交易确认所在的链上 slot。 Chain slot in which the transaction confirmed. */
  slot: number;
  /** 浏览器获知确认的时间，毫秒时间戳。 When the browser observed confirmation, as Unix milliseconds. */
  confirmedAt: number;
}

/**
 * 让已索引活动和待同步状态分别缓存，并由网络、金库和钱包隔离。
 * Keep indexed activity and confirmation state in separate caches scoped by network, vault and wallet.
 *
 * @param scope 三个公开的作用域值，尚未连接或选中时允许空值。 Three public scope identifiers, with empty values before selection or connection.
 * @returns 列表缓存键和本地确认记录缓存键。 Query keys for the list and local confirmation.
 */
function recentActivityKeys(scope: readonly [Network, string | undefined, string | null]) {
  return {
    recent: ['vault-recent-activity', ...scope] as const,
    confirmation: ['vault-recent-activity-confirmation', ...scope] as const,
  };
}

/**
 * 记录成功的存入或赎回并让对应列表立即重查。确认状态与后端查询结果各自独立。
 * Record a successful deposit or redemption and immediately refresh its list. Chain confirmation remains independent of the API result.
 *
 * @param client 保存当前会话查询与确认状态的 TanStack Query 客户端。 TanStack Query client holding queries and confirmations for this session.
 * @param scope 发起交易的网络、金库公钥和钱包公钥。 Network, vault public key and wallet public key of the original transaction.
 * @param confirmation 刚确认的签名和 slot。 Newly confirmed transaction signature and chain slot.
 */
export function recordVaultActivityConfirmation(
  client: QueryClient,
  scope: readonly [Network, string, string],
  confirmation: Pick<VaultActivityConfirmation, 'signature' | 'slot'>,
) {
  /** 确认回调按发起交易时的作用域写入，切换钱包不影响原记录。 The callback writes to the original scope even if the wallet has changed. */
  const keys = recentActivityKeys(scope);
  client.setQueryData<VaultActivityConfirmation>(keys.confirmation, {
    ...confirmation,
    confirmedAt: Date.now(),
  });
  void client.invalidateQueries({ queryKey: keys.recent, exact: true });
}

/**
 * 判断活动列表是否已收录交易，或索引已跨过该交易所在的 slot。
 * Check whether the activity list contains the transaction or indexing has advanced past its slot.
 *
 * @param items 当前钱包在所选金库上的新活动。 Recently indexed activity for the current wallet and vault.
 * @param confirmation 正等待活动的链上确认。 Chain confirmation waiting for its activity.
 * @returns 已见签名或严格更新的 slot 时为 true。 True on an exact signature match or a strictly newer indexed slot.
 */
function hasReachedConfirmation(items: readonly ActivityItem[], confirmation: VaultActivityConfirmation) {
  // 后端按连续检查点顺序入库。更高 slot 已可见时，较早的交易可能已经排出四条之外。
  // The indexer writes in checkpoint order. An older event may have fallen out of the latest four if a higher slot is visible.
  return items.some((item) => item.signature === confirmation.signature || BigInt(item.slot) > BigInt(confirmation.slot));
}

/**
 * 获取所选金库中当前钱包的最新存赎。交易确认后在有限时间内尝试等到后端索引。
 * Fetch the wallet's latest deposits and redemptions in the selected vault, and briefly poll after an on-chain confirmation.
 *
 * @param network 顶栏当前选择的网络。 Currently selected network.
 * @param vaultAddress 当前选中的金库公钥，尚无选中项时为空。 Selected vault public key, undefined before selection.
 * @param walletAddress 已连接的钱包公钥，未连接时为空。 Connected wallet public key, or null when disconnected.
 */
export function useVaultRecentActivity(network: Network, vaultAddress: string | undefined, walletAddress: string | null) {
  /** 读写本地确认状态的客户端。 Client for reading and updating local confirmation state. */
  const client = useQueryClient();
  /** 当前列表和本地确认记录使用的目标作用域。 Current scope for the list and local confirmation. */
  const keys = recentActivityKeys([network, vaultAddress, walletAddress]);
  /** 仅订阅浏览器本地记录，不从后端读取。 Subscribe to the local confirmation only, without requesting it from the server. */
  const { data: confirmation } = useQuery<VaultActivityConfirmation | null>({
    queryKey: keys.confirmation,
    queryFn: skipToken,
  });

  /** 有钱包和金库才请求活动，切换时可取消旧请求，不展示另一个作用域的结果。 Fetch only for a connected wallet and selected vault, canceling obsolete scopes without showing their results. */
  const recent = useQuery({
    queryKey: keys.recent,
    queryFn: vaultAddress && walletAddress
      ? ({ signal }) => listActivities({
        network,
        subjectAddress: vaultAddress,
        wallet: walletAddress,
        types: vaultActivityTypes,
        limit: recentActivityLimit,
      }, signal)
      : skipToken,
    // 页面获得焦点时也能刷新历史；确认后的额外轮询只在索引落后期间运行。
    // Focus also refreshes history. Additional confirmation polling runs only while indexing is pending.
    refetchInterval: (query) => {
      if (!confirmation || hasReachedConfirmation(query.state.data?.items ?? [], confirmation)) return false;

      /** 最后一次请求安排在截止时刻，避免等待状态停在旧值。 Schedule the last read at the deadline to let the waiting state expire. */
      const remainingMs = confirmation.confirmedAt + maxIndexWaitMs - Date.now();
      return remainingMs > 0 ? Math.min(pollIntervalMs, remainingMs) : false;
    },
  });

  /** 缓存中有效的活动和本次确认是否已被覆盖。 Cached activity and whether it covers this confirmation. */
  const items = recent.data?.items ?? [];
  const reached = !!confirmation && hasReachedConfirmation(items, confirmation);
  useEffect(() => {
    if (!reached || !confirmation) return;

    // 检查签名，避免本轮刷新清除期间刚写入的另一笔确认。
    // Check the signature so this refresh cannot clear a confirmation that arrived in the meantime.
    client.setQueryData<VaultActivityConfirmation | null>(recentActivityKeys([network, vaultAddress, walletAddress]).confirmation,
      (current) => current?.signature === confirmation.signature ? null : current);
  }, [client, confirmation, network, reached, vaultAddress, walletAddress]);

  /** 自动尝试结束后改为允许手动刷新，保留原有已加载记录。 After automatic polling stops, allow manual refresh while retaining any loaded records. */
  const waiting = !!confirmation && !reached;
  const isDelayed = waiting && Date.now() - confirmation.confirmedAt >= maxIndexWaitMs;

  /**
   * 用户手动从后端重新查询所选钱包的最近活动。
   * Manually refresh the selected wallet's latest activity from the server.
   */
  function refresh() {
    if (vaultAddress && walletAddress) void recent.refetch();
  }

  return {
    items,
    isPending: recent.isPending,
    isError: recent.isError,
    isFetching: recent.isFetching,
    isSyncing: waiting && !isDelayed,
    isDelayed,
    refresh,
  };
}

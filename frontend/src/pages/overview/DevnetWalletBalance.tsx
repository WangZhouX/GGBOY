import { skipToken, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatTokenAmount } from '../../shared/formatTokenAmount';
import type { Network } from '../../shared/navigation/network';
import { getDevnetSolBalance } from '../../solana/getDevnetSolBalance';
import { usePhantomWallet } from '../../solana/phantomWallet';
import './styles/devnet-wallet-balance.css';

/** 区块所用的站点网络。 Site network used by this section. */
interface DevnetWalletBalanceProps {
  /** 顶栏当前选择的网络。 Network currently selected in the header. */
  network: Network;
}

/** SOL 的小数精度为九位，1 SOL 等于 10⁹ lamports。 SOL has nine decimals: 1 SOL equals 10⁹ lamports. */
const solDecimals = 9;

/**
 * 查询并显示已连接 Phantom 账户的 Devnet SOL 余额。
 * Look up and display the connected Phantom account's Devnet SOL balance.
 *
 * @param props 资产总览传入的站点网络。 Site network supplied by the portfolio overview.
 */
export function DevnetWalletBalance({ network }: DevnetWalletBalanceProps) {
  /** 状态提示和余额格式随界面语言更新。 Status messages and amount formatting follow the UI language. */
  const { t, i18n } = useTranslation();
  /** 钱包连接层提供当前账户公钥，断开或未授权时为空。 The wallet provider supplies the current public key, or null when disconnected or unauthorized. */
  const { walletAddress } = usePhantomWallet();
  /** 只有站点选中 Devnet 且钱包已授权时，才有可查询的公钥。 Use a public key only when the selected network is Devnet and the wallet is authorized. */
  const devnetAddress = network === 'devnet' ? walletAddress : null;

  /** 余额与加载、成功和失败状态，由当前网络与公钥共同决定。 Balance and request state scoped to the current network and public key. */
  const balance = useQuery({
    // 公钥变化时使用独立的查询，避免把上一只钱包余额显示在新钱包下。
    // Use a separate query on account changes so the previous wallet's balance cannot appear under the new wallet.
    queryKey: ['sol-balance', network, devnetAddress],
    // 传入取消信号，切换账户、网络或离开页面后可停止旧请求。
    // Pass the cancellation signal so changing accounts or networks, or leaving the page, can stop the old request.
    queryFn: devnetAddress === null
      ? skipToken
      : ({ signal }) => getDevnetSolBalance({ walletAddress: devnetAddress }, signal),
    // 回到已访问过的钱包也重新读余额，因为它可能在钱包或水龙头中发生了变化。
    // Revalidate a previously viewed wallet because its balance may have changed in Phantom or at a faucet.
    staleTime: 0,
  });

  /** 主动重读当前 Devnet 账户的 SOL 余额。 Read the current Devnet account's SOL balance again on demand. */
  function refreshBalance() {
    void balance.refetch();
  }

  return (
    <section className="wallet-balance" aria-labelledby="wallet-balance-title">
      <header className="wallet-balance__header">
        <h2 id="wallet-balance-title">{t('walletBalance.title')}</h2>
        {devnetAddress !== null && (
          <button type="button" onClick={refreshBalance} disabled={balance.isFetching}>
            {t(balance.isError ? 'walletBalance.retry' : 'walletBalance.refresh')}
          </button>
        )}
      </header>
      {devnetAddress === null ? (
        <p className="wallet-balance__status" role="status">
          {t(network === 'devnet' ? 'walletBalance.connectPrompt' : 'walletBalance.switchNetwork')}
        </p>
      ) : (
        <>
          <p className="wallet-balance__identity">
            <span>{t('walletBalance.address')}</span>
            <code>{devnetAddress}</code>
          </p>
          {balance.isPending && <p className="wallet-balance__status" role="status">{t('walletBalance.loading')}</p>}
          {balance.isError && <p className="wallet-balance__status wallet-balance__status--error" role="alert">{t('walletBalance.error')}</p>}
          {balance.isSuccess && (
            <output className="wallet-balance__amount">
              {formatTokenAmount(balance.data.lamports, solDecimals, i18n.resolvedLanguage ?? i18n.language)} SOL
            </output>
          )}
        </>
      )}
    </section>
  );
}

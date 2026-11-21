package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.api.AssetMintResponse;
import io.ggboy.backend.api.SnapshotFreshness;
import io.ggboy.backend.api.VaultHistoryCursor;
import io.ggboy.backend.api.VaultHistorySnapshotResponse;
import io.ggboy.backend.api.VaultListResponse;
import io.ggboy.backend.api.VaultPositionResponse;
import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.backend.entity.VaultPositionSnapshotDO;
import io.ggboy.backend.entity.VaultSnapshotDO;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.mapper.VaultMapper;
import io.ggboy.backend.mapper.VaultPositionSnapshotMapper;
import io.ggboy.backend.mapper.VaultSnapshotMapper;
import io.ggboy.backend.service.VaultService;
import io.ggboy.common.api.CursorPage;
import io.ggboy.common.api.SolanaNetwork;

import java.math.BigInteger;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.ProxyType;
import org.springframework.context.annotation.Proxyable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 组织金库目录、资产、历史快照和钱包持仓查询。
 * Coordinates read models for vault registrations, assets, snapshot history and wallet positions.
 */
@Service
// 通过 VaultService 接口代理只读事务，适配当前的 JPMS 启动方式。
// Proxy read-only transactions through the VaultService interface for the current JPMS launch mode.
@Proxyable(ProxyType.INTERFACES)
public class VaultServiceImpl extends ServiceImpl<VaultMapper, VaultDO>
        implements VaultService {

    /** 批量读取资产 Mint 元数据。 Loads asset mint metadata in batches. */
    private final AssetMintMapper assetMintMapper;

    /** 读取金库历史、最新或指定 slot 的快照。 Loads vault history, latest snapshots or a specific slot. */
    private final VaultSnapshotMapper vaultSnapshotMapper;

    /** 按钱包公钥读取最新持仓。 Loads the latest position by wallet public key. */
    private final VaultPositionSnapshotMapper vaultPositionSnapshotMapper;

    /** 快照从观测时间开始保持新鲜的时长。 Time for which a snapshot stays fresh after observation. */
    private final Duration snapshotMaxAge;

    /**
     * 注入金库和持仓快照查询依赖及新鲜度阈值。金库目录使用继承的基础 Mapper。
     * Wires vault and position snapshot queries and the freshness threshold. Registrations use the inherited base mapper.
     *
     * @param assetMintMapper 资产 Mint 元数据查询。 Asset mint metadata queries.
     * @param vaultSnapshotMapper 金库快照查询。 Vault snapshot queries.
     * @param vaultPositionSnapshotMapper 钱包持仓快照查询。 Wallet position snapshot queries.
     * @param snapshotMaxAgeSeconds 快照最大新鲜时长，以秒计，必须为正数。
     *        Maximum fresh age of a snapshot in seconds, which must be positive.
     * @throws IllegalArgumentException 配置的新鲜时长小于一秒。 The configured freshness interval is less than one second.
     */
    public VaultServiceImpl(
            AssetMintMapper assetMintMapper,
            VaultSnapshotMapper vaultSnapshotMapper,
            VaultPositionSnapshotMapper vaultPositionSnapshotMapper,
            @Value("${ggboy.vault.snapshot-stale-after-seconds}") long snapshotMaxAgeSeconds
    ) {
        // 启动时校验阈值，防止错误配置影响全部快照的状态。
        // Validate the threshold at startup so a configuration error cannot mislabel every snapshot.
        if (snapshotMaxAgeSeconds < 1) {
            throw new IllegalArgumentException("Vault snapshot freshness must be at least one second");
        }
        this.assetMintMapper = assetMintMapper;
        this.vaultSnapshotMapper = vaultSnapshotMapper;
        this.vaultPositionSnapshotMapper = vaultPositionSnapshotMapper;
        this.snapshotMaxAge = Duration.ofSeconds(snapshotMaxAgeSeconds);
    }

    /**
     * 按接口契约组装金库列表。目录、资产和快照查询使用同一个数据库读视图。
     * Builds the vault list using one consistent database view for registrations, assets, and snapshots.
     *
     * @param network 已解析的目标网络，其小写标识用于所有查询。
     *        Parsed target network whose lowercase identifier scopes all reads.
     * @return 按金库地址升序排列的列表。未登记金库时列表为空，未采集快照的金库仍保留。
     *        List ordered by vault address. An empty network yields an empty list, and unobserved vaults are retained.
     */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public VaultListResponse listVaults(SolanaNetwork network) {
        // 所有查询都使用相同的网络标识。目录顺序也是响应顺序。
        // Use the same network identifier for every query and preserve the registration order in the response.
        String networkValue = network.wireValue();
        List<VaultDO> vaults = getBaseMapper().selectByNetwork(networkValue);
        if (vaults.isEmpty()) {
            return new VaultListResponse(List.of());
        }

        // 去重结算、份额和已配置的策略 Mint 地址，避免重复查询共用资产。
        // Deduplicate quote, share, and configured strategy mint addresses shared by multiple vaults.
        Set<String> mintAddresses = new HashSet<>();
        for (VaultDO vault : vaults) {
            mintAddresses.add(vault.quoteMint());
            mintAddresses.add(vault.shareMint());
            if (vault.strategyMint() != null) {
                mintAddresses.add(vault.strategyMint());
            }
        }

        // 资产按 Mint 地址索引，快照按金库地址索引，便于在保持目录顺序时组装响应。
        // Index assets by mint and snapshots by vault so response assembly preserves the directory order.
        Map<String, AssetMintResponse> assetsByMint = assetMintMapper
                .selectByNetworkAndMintAddresses(networkValue, mintAddresses)
                .stream()
                .collect(Collectors.toMap(
                        AssetMintDO::mintAddress,
                        AssetMintResponse::from
                ));
        List<String> vaultAddresses = vaults.stream().map(VaultDO::vaultAddress).toList();
        Map<String, VaultSnapshotDO> snapshotsByVault = vaultSnapshotMapper
                .selectLatestByNetworkAndVaultAddresses(networkValue, vaultAddresses)
                .stream()
                .collect(Collectors.toMap(VaultSnapshotDO::vaultAddress, Function.identity()));

        // 同一响应内的所有快照按同一个服务端时刻判断新鲜度。
        // Assess every snapshot in the response against the same server time.
        Instant now = Instant.now();
        List<VaultListResponse.Item> items = vaults.stream()
                .map(vault -> new VaultListResponse.Item(
                        vault.network(),
                        vault.vaultAddress(),
                        vault.programId(),
                        requireAsset(assetsByMint, vault.quoteMint()),
                        requireAsset(assetsByMint, vault.shareMint()),
                        vault.strategyMint() == null ? null : requireAsset(assetsByMint, vault.strategyMint()),
                        vault.lendingMarketAddress(),
                        toSnapshot(snapshotsByVault.get(vault.vaultAddress()), now)
                ))
                .toList();
        return new VaultListResponse(items);
    }

    /**
     * 在一次只读事务中确认金库登记并查询一页历史快照。
     * Checks vault registration and reads one history page in a single read-only transaction.
     *
     * @param network 已解析的目标网络。 Parsed target network.
     * @param vaultAddress 已校验的金库公钥。 Validated vault public key.
     * @param beforeSlot 排他 slot 上界，首次请求时为空。 Exclusive slot bound, or null for the first page.
     * @param limit 已校验的每页最多条数，范围为 1 至 100。 Validated maximum rows per page, from 1 to 100.
     * @return 已登记金库的历史页，末页没有游标。金库未登记时返回空 Optional。
     *        A history page with no cursor on the final page. Empty Optional for an unregistered vault.
     */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Optional<CursorPage<VaultHistorySnapshotResponse>> listVaultSnapshots(
            SolanaNetwork network, String vaultAddress, BigInteger beforeSlot, int limit
    ) {
        // 目录和快照使用相同的小写网络标识，保证跨网络隔离。
        // Use the same lowercase network identifier for registrations and snapshots to keep networks isolated.
        String networkValue = network.wireValue();
        if (getBaseMapper().selectByNetworkAndAddress(networkValue, vaultAddress) == null) {
            return Optional.empty();
        }

        // 在数据库端多取一条来判断是否还有旧记录，无需额外计数。
        // Fetch one extra row from the database to detect older results without a count query.
        List<VaultSnapshotDO> fetched = vaultSnapshotMapper
                .selectHistoryByNetworkAndAddress(networkValue, vaultAddress, beforeSlot, limit + 1);
        boolean hasNext = fetched.size() > limit;
        List<VaultSnapshotDO> pageRows = hasNext ? fetched.subList(0, limit) : fetched;

        // 游标使用实际返回的末条 slot，下一页才会包含用于判断的额外记录。
        // Anchor the cursor to the last returned slot so the extra row remains available on the next page.
        String nextCursor = hasNext
                ? VaultHistoryCursor.encode(network, vaultAddress, pageRows.getLast().slot())
                : null;

        // 历史快照保留原有观测及空值。前端收到的是最小单位的整数字符串。
        // Preserve historical observations and nulls. The frontend receives base-unit integer strings.
        List<VaultHistorySnapshotResponse> items = pageRows.stream()
                .map(VaultHistorySnapshotResponse::from)
                .toList();
        return Optional.of(new CursorPage<>(items, nextCursor));
    }

    /**
     * 用同一个数据库读视图查询金库是否登记、钱包最新持仓和同 slot 的金库快照。
     * Uses one consistent read view for the vault registration, latest position and same-slot vault snapshot.
     *
     * @param network 已解析的目标网络。 Parsed target network.
     * @param vaultAddress 已校验的金库状态账户公钥。 Validated vault state account public key.
     * @param walletAddress 已校验的份额持有人公钥。 Validated share holder public key.
     * @return 未登记金库时为空。已登记但钱包尚无观测记录时返回空快照的数据。
     *        Empty for an unregistered vault, or a payload with a null snapshot for an unobserved wallet.
     */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Optional<VaultPositionResponse> getVaultPosition(
            SolanaNetwork network, String vaultAddress, String walletAddress
    ) {
        // 所有读取都以同一网络为范围，同地址在不同网络上独立登记。
        // Scope every read to the same network. The same address is registered independently on each network.
        String networkValue = network.wireValue();
        if (getBaseMapper().selectByNetworkAndAddress(networkValue, vaultAddress) == null) {
            return Optional.empty();
        }

        // 先选钱包最新的数值 slot，无记录代表尚未观测到钱包。
        // First select the wallet's latest numeric slot. An absent row means the wallet has not been observed.
        VaultPositionSnapshotDO position = vaultPositionSnapshotMapper
                .selectLatestByNetworkAndVaultAndWallet(networkValue, vaultAddress, walletAddress);
        if (position == null) {
            return Optional.of(new VaultPositionResponse(networkValue, vaultAddress, walletAddress, null));
        }

        // 精确匹配持仓 slot，避免使用另一时点的估值替换缺失数据。
        // Match the position slot exactly so missing data cannot be replaced with a valuation from another point in time.
        VaultSnapshotDO vaultSnapshot = vaultSnapshotMapper
                .selectByNetworkAndAddressAndSlot(networkValue, vaultAddress, position.slot());
        return Optional.of(new VaultPositionResponse(
                networkValue, vaultAddress, walletAddress, toPositionSnapshot(position, vaultSnapshot, Instant.now())
        ));
    }

    /**
     * 将钱包观测和可用的同 slot 估值组装为快照响应。
     * Builds the response from the wallet observation and any compatible same-slot valuation.
     *
     * @param position 最新钱包观测记录。 Latest observed wallet position.
     * @param vaultSnapshot 同 slot 的金库快照，未索引时为空。 Same-slot vault snapshot, or null if unindexed.
     * @param now 判断新鲜度的服务端时刻。 Server time used to assess freshness.
     * @return 含观测时间、持有份额和可用估值的响应快照。 Snapshot with observation time, shares and available valuation.
     */
    private VaultPositionResponse.Snapshot toPositionSnapshot(
            VaultPositionSnapshotDO position, VaultSnapshotDO vaultSnapshot, Instant now
    ) {
        // 份额采集时间统一输出 UTC。估值不可用时继续保留持有份额和观测时间。
        // Return the share observation time in UTC. Keep the observed shares and timestamp when valuation is unavailable.
        Instant observedAt = position.observedAt().toInstant();
        PositionValuation valuation = valuePosition(position, vaultSnapshot);
        return new VaultPositionResponse.Snapshot(
                position.slot().toString(),
                observedAt.toString(),
                SnapshotFreshness.at(observedAt, now, snapshotMaxAge),
                position.sharesRaw().toString(),
                Objects.toString(valuation.valueRaw(), null),
                Objects.toString(valuation.maxSharesRaw(), null),
                Objects.toString(valuation.redeemableRaw(), null)
        );
    }

    /**
     * 用同一 slot 的净值、份额总量和可用现金验证持仓估值，并计算安全赎回上限。
     * Checks the stored position valuation and derives a safe redemption cap from same-slot NAV, supply and cash.
     *
     * @param position 钱包观测的份额及已索引估值。 Observed wallet shares and indexed valuation.
     * @param vaultSnapshot 与持仓同 slot 的金库观测，可为空。 Same-slot vault observation, which may be null.
     * @return 已核对的估值和赎回上限，或字段全为空的不可用估值。
     *        Checked valuation and redemption cap, or an unavailable valuation with all fields null.
     */
    private static PositionValuation valuePosition(VaultPositionSnapshotDO position, VaultSnapshotDO vaultSnapshot) {
        if (vaultSnapshot == null || vaultSnapshot.navRaw() == null) {
            return PositionValuation.UNAVAILABLE;
        }

        // 净值使用计价资产最小单位，总量和持有量使用份额最小单位。
        // NAV uses quote asset base units. Supply and holdings use share asset base units.
        BigInteger nav = vaultSnapshot.navRaw();
        BigInteger supply = vaultSnapshot.totalSharesRaw();
        BigInteger shares = position.sharesRaw();
        if (shares.compareTo(supply) > 0 || (supply.signum() == 0 && nav.signum() > 0)) {
            return PositionValuation.UNAVAILABLE;
        }
        if (shares.signum() == 0 || nav.signum() == 0) {
            return PositionValuation.ZERO;
        }

        // 金库现金和此刻可从借贷池取回的金额才可用于支付。按份额粒度向下舍入。
        // Only vault cash and the currently withdrawable lending amount fund redemptions. Round down to share granularity.
        BigInteger liquidity = vaultSnapshot.cashRaw().add(vaultSnapshot.lendingWithdrawableRaw());
        BigInteger maxShares = liquidity.multiply(supply).divide(nav).min(shares);
        // 按可赎回份额向下计算计价资产到账。到账为零的份额无法用于赎回。
        // Round the payout down in quote base units. Shares that would pay zero cannot be redeemed.
        BigInteger payout = maxShares.multiply(nav).divide(supply);
        if (payout.signum() == 0) {
            maxShares = BigInteger.ZERO;
        }

        // 已索引金额必须与同 slot 输入的整数口径相容，避免展示彼此矛盾的上限和预计到账。
        // Indexed values must agree with the same-slot integer calculation to keep the share cap and payout consistent.
        BigInteger value = position.positionValueRaw();
        if (!shares.multiply(nav).divide(supply).equals(value) || !payout.equals(position.redeemableRaw())) {
            return PositionValuation.UNAVAILABLE;
        }
        return new PositionValuation(value, maxShares, position.redeemableRaw());
    }

    /**
     * 份额估值和赎回上限，统一表示不可用估值或可计算的金额。
     * Position valuation and redemption limits, representing either unavailable data or computable amounts.
     *
     * @param valueRaw 持仓价值，单位为计价资产最小单位。 Position value in quote asset base units.
     * @param maxSharesRaw 可赎回份额，单位为份额资产最小单位。 Redeemable shares in share asset base units.
     * @param redeemableRaw 上限对应的到账，单位为计价资产最小单位。 Payout at the limit in quote asset base units.
     */
    private record PositionValuation(BigInteger valueRaw, BigInteger maxSharesRaw, BigInteger redeemableRaw) {

        /** 无法确认估值时的三个空字段。 Three null amounts when the valuation is unavailable. */
        private static final PositionValuation UNAVAILABLE = new PositionValuation(null, null, null);

        /** 已确定都为零的三项金额。 Three amounts known to be zero. */
        private static final PositionValuation ZERO = new PositionValuation(BigInteger.ZERO, BigInteger.ZERO, BigInteger.ZERO);
    }

    /**
     * 根据金库登记的 Mint 地址取资产元数据。已配置的 Mint 应由目录外键保证存在。
     * Looks up the configured mint metadata, whose presence is required by the directory foreign keys.
     *
     * @param assetsByMint 请求网络中按 Mint 地址索引的资产。 Assets indexed by mint address for the requested network.
     * @param mintAddress 金库登记的资产 Mint 公钥。 Asset mint public key registered on the vault.
     * @return 包含 Mint、展示简称和精度的资产数据。 Asset data containing the mint, ticker, and decimals.
     * @throws IllegalStateException 已配置的资产缺少元数据。 A configured asset is missing its metadata.
     */
    private AssetMintResponse requireAsset(Map<String, AssetMintResponse> assetsByMint, String mintAddress) {
        // 资产元数据缺失属于目录数据异常，不能用假定精度返回金额。
        // Missing metadata indicates a directory inconsistency. Never guess the asset precision.
        AssetMintResponse asset = assetsByMint.get(mintAddress);
        if (asset == null) {
            throw new IllegalStateException("Missing asset metadata for configured mint: " + mintAddress);
        }
        return asset;
    }

    /**
     * 将数据库快照转换为接口数据并标记新鲜度。
     * Converts a stored snapshot into API data and marks its freshness.
     *
     * @param record 数据库快照。金库从未被采集时为空。 Stored snapshot, or null when the vault has never been observed.
     * @param now 本次列表响应使用的统一服务端时刻。 Server time shared by this list response.
     * @return 最新快照。尚未采集时为空。 Latest snapshot, or null when unobserved.
     */
    private VaultListResponse.Snapshot toSnapshot(VaultSnapshotDO record, Instant now) {
        if (record == null) {
            return null;
        }

        // 统一使用 UTC 观测时间，供 JSON 格式化及新鲜度计算。
        // Use the UTC observation time for both JSON formatting and the freshness check.
        Instant observedAt = record.observedAt().toInstant();

        // 复用历史快照的时间、金额和空值格式，并在最新概况中附加新鲜度。
        // Reuse history formatting for times, amounts and nulls, and add freshness to the latest overview.
        VaultHistorySnapshotResponse snapshot = VaultHistorySnapshotResponse.from(record);
        return new VaultListResponse.Snapshot(
                snapshot.slot(),
                snapshot.observedAt(),
                snapshot.oracleSlot(),
                snapshot.cashRaw(),
                snapshot.strategyAmountRaw(),
                snapshot.strategyValueRaw(),
                snapshot.lendValueRaw(),
                snapshot.lendingWithdrawableRaw(),
                snapshot.navRaw(),
                snapshot.totalSharesRaw(),
                SnapshotFreshness.at(observedAt, now, snapshotMaxAge)
        );
    }
}

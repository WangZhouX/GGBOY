package io.ggboy.backend.service.impl;

import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import io.ggboy.backend.api.AssetMintResponse;
import io.ggboy.backend.api.LendingMarketListResponse;
import io.ggboy.backend.api.LendingPositionResponse;
import io.ggboy.backend.api.SnapshotFreshness;
import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.mapper.LendingMarketMapper;
import io.ggboy.backend.mapper.LendingMarketSnapshotMapper;
import io.ggboy.backend.mapper.LendingPositionSnapshotMapper;
import io.ggboy.backend.service.LendingMarketService;
import io.ggboy.common.api.SolanaNetwork;

import java.math.BigDecimal;
import java.math.MathContext;
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
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 将市场登记、资产元数据和快照组装为资金池概况及钱包仓位。
 * Assembles market registrations, mint metadata, and snapshots into pool overviews and wallet positions.
 */
@Service
public class LendingMarketServiceImpl extends ServiceImpl<LendingMarketMapper, LendingMarketDO>
        implements LendingMarketService {

    /** 批量读取借款和抵押 Mint 的元数据。 Loads debt and collateral mint metadata in batches. */
    private final AssetMintMapper assetMintMapper;

    /** 查询最新资金池观测或指定 slot 的观测。 Loads the latest pool observation or one at a given slot. */
    private final LendingMarketSnapshotMapper snapshotMapper;

    /** 查询钱包最新的仓位观测。 Loads the latest observation of the wallet position. */
    private final LendingPositionSnapshotMapper positionMapper;

    /** 从快照观测时间开始计量的新鲜时长。 Freshness duration measured from the snapshot observation time. */
    private final Duration snapshotMaxAge;

    /**
     * 注入资产和快照查询依赖以及新鲜度配置。登记查询使用继承的 Mapper。
     * Wires asset and snapshot queries and freshness configuration. Registrations use the inherited mapper.
     *
     * @param assetMintMapper 资产 Mint 元数据查询。 Asset mint metadata queries.
     * @param snapshotMapper 借贷市场快照查询。 Lending market snapshot queries.
     * @param positionMapper 钱包仓位快照查询。 Wallet position snapshot queries.
     * @param snapshotMaxAgeSeconds 新鲜时长，单位为秒，必须为正数。
     *                              Freshness duration in seconds, which must be positive.
     * @throws IllegalArgumentException 新鲜时长配置小于一秒。 The configured duration is less than one second.
     */
    public LendingMarketServiceImpl(
            AssetMintMapper assetMintMapper,
            LendingMarketSnapshotMapper snapshotMapper,
            LendingPositionSnapshotMapper positionMapper,
            @Value("${ggboy.lending.snapshot-stale-after-seconds}") long snapshotMaxAgeSeconds
    ) {
        // 启动时校验阈值，避免配置错误导致快照新鲜度标记异常。
        // Validate the threshold at startup so misconfiguration cannot mislabel snapshots.
        if (snapshotMaxAgeSeconds < 1) {
            throw new IllegalArgumentException("Lending snapshot freshness must be at least one second");
        }
        this.assetMintMapper = assetMintMapper;
        this.snapshotMapper = snapshotMapper;
        this.positionMapper = positionMapper;
        this.snapshotMaxAge = Duration.ofSeconds(snapshotMaxAgeSeconds);
    }

    /**
     * 在同一数据库读视图下查询市场目录、资产元数据和最新快照。
     * Reads market registrations, mint metadata and latest snapshots in one consistent database view.
     *
     * @param network 已解析的目标 Solana 网络。 The parsed Solana network for the query.
     * @return 按市场地址升序排列的结果。无登记返回空列表，未观测的市场保留空快照。
     *         Results ordered by market address. No registrations yield an empty list, and unobserved markets keep null snapshots.
     */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public LendingMarketListResponse listMarkets(SolanaNetwork network) {
        // 所有查询共享同一网络标识；目录的市场地址排序决定响应顺序。
        // Scope all queries to the same network. Registration order by market address determines response order.
        String networkValue = network.wireValue();
        List<LendingMarketDO> markets = getBaseMapper().selectByNetwork(networkValue);
        if (markets.isEmpty()) {
            return new LendingMarketListResponse(List.of());
        }

        // 去重借款和抵押 Mint 地址，便于批量读取共用资产的展示简称与精度。
        // Deduplicate debt and collateral mint addresses to batch-load symbols and decimals for shared assets.
        Set<String> mintAddresses = new HashSet<>();
        for (LendingMarketDO market : markets) {
            mintAddresses.add(market.debtMint());
            mintAddresses.add(market.collateralMint());
        }

        // 分别按 Mint 和市场地址索引查询结果，便于按原目录顺序组装条目。
        // Index assets by mint and snapshots by market address to assemble items in registration order.
        Map<String, AssetMintResponse> assetsByMint = assetMintMapper
                .selectByNetworkAndMintAddresses(networkValue, mintAddresses)
                .stream()
                .collect(Collectors.toMap(AssetMintDO::mintAddress, AssetMintResponse::from));
        List<String> marketAddresses = markets.stream().map(LendingMarketDO::marketAddress).toList();
        Map<String, LendingMarketSnapshotDO> snapshotsByMarket = snapshotMapper
                .selectLatestByNetworkAndMarketAddresses(networkValue, marketAddresses)
                .stream()
                .collect(Collectors.toMap(LendingMarketSnapshotDO::marketAddress, Function.identity()));

        // 本次请求只取一次服务端时间，统一评估所有市场快照的新鲜度。
        // Capture server time once to assess freshness consistently across markets in this response.
        Instant now = Instant.now();
        List<LendingMarketListResponse.Item> items = markets.stream()
                .map(market -> new LendingMarketListResponse.Item(
                        market.network(),
                        market.marketAddress(),
                        market.programId(),
                        requireAsset(assetsByMint, market.debtMint()),
                        requireAsset(assetsByMint, market.collateralMint()),
                        toSnapshot(snapshotsByMarket.get(market.marketAddress()), now)
                ))
                .toList();
        return new LendingMarketListResponse(items);
    }

    /**
     * 在同一数据库读视图下确认市场登记，读取钱包最新仓位及同 slot 的市场快照。
     * Checks registration and reads the latest wallet position and same-slot market snapshot in one database view.
     *
     * @param network 已解析的目标 Solana 网络。 Parsed Solana network for the query.
     * @param marketAddress 已校验的市场状态账户公钥。 Validated market state account public key.
     * @param walletAddress 已校验的钱包公钥。 Validated wallet public key.
     * @return 未登记市场返回空 Optional。已登记但未观测的钱包返回空快照。
     *         Empty Optional for an unregistered market. A registered market with an unobserved wallet has a null snapshot.
     */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Optional<LendingPositionResponse> getLendingPosition(
            SolanaNetwork network, String marketAddress, String walletAddress) {
        // 市场、仓位和计算输入都限定在同一网络。
        // Keep the market, wallet position, and calculation inputs on the same network.
        String networkValue = network.wireValue();
        LendingMarketDO market = getBaseMapper().selectByNetworkAndAddress(networkValue, marketAddress);
        if (market == null) {
            return Optional.empty();
        }

        // 以钱包的最新 slot 为准。尚未观测的仓位需要与已观测的空仓区分。
        // Start from the wallet's latest slot and distinguish an unobserved position from an observed empty one.
        LendingPositionSnapshotDO position = positionMapper.selectLatestByNetworkAndMarketAndWallet(
                networkValue, marketAddress, walletAddress);
        if (position == null) {
            return Optional.of(new LendingPositionResponse(networkValue, marketAddress, walletAddress, null));
        }

        // 只匹配同一个 slot，找不到市场观测时仍保留钱包快照。
        // Match only the same slot and preserve the wallet observation if no market snapshot matches.
        LendingMarketSnapshotDO marketSnapshot = snapshotMapper.selectByNetworkAndAddressAndSlot(
                networkValue, marketAddress, position.slot());
        LendingPositionResponse.Snapshot snapshot = toPositionSnapshot(market, position, marketSnapshot, Instant.now());
        return Optional.of(new LendingPositionResponse(networkValue, marketAddress, walletAddress, snapshot));
    }

    /**
     * 保留钱包观测的原始数值，只在依赖数据仍新鲜且充分时返回当前额度。
     * Retains the original wallet observation and returns current limits only when the required facts are fresh and sufficient.
     *
     * @param market 用于识别资产 Mint 的市场登记。 Market registration used to identify the asset mints.
     * @param position 钱包最新仓位观测。 Latest wallet position observation.
     * @param marketSnapshot 同 slot 的市场观测，未采集时为空。 Same-slot market observation, or null if unobserved.
     * @param now 计算所有快照新鲜度的同一服务端时刻。 Shared server time for evaluating all observation freshness.
     * @return 钱包仓位、可推导的额度与同 slot 风险信息。 Wallet position, verifiable limits, and same-slot risk information.
     */
    private LendingPositionResponse.Snapshot toPositionSnapshot(
            LendingMarketDO market, LendingPositionSnapshotDO position,
            LendingMarketSnapshotDO marketSnapshot, Instant now) {
        // 钱包和市场的观测时间分别判断，过期市场数据不能用来推导当前额度。
        // Evaluate wallet and market observation ages separately. Stale market data cannot establish current limits.
        Instant observedAt = position.observedAt().toInstant();
        SnapshotFreshness freshness = SnapshotFreshness.at(observedAt, now, snapshotMaxAge);
        LendingMarketSnapshotDO freshMarketSnapshot = marketSnapshot != null
                && SnapshotFreshness.at(marketSnapshot.observedAt().toInstant(), now, snapshotMaxAge)
                        == SnapshotFreshness.FRESH
                ? marketSnapshot : null;
        PositionLimits limits = freshness == SnapshotFreshness.FRESH
                ? knownPositionLimits(position, freshMarketSnapshot)
                : PositionLimits.UNAVAILABLE;

        // 有匹配市场时保留该 slot 的风险参数；估算的清算价格要求两份快照都新鲜。
        // Keep observed risk parameters from the matching market slot. The liquidation price estimate requires both snapshots to be fresh.
        String liquidationPrice = freshness == SnapshotFreshness.FRESH && freshMarketSnapshot != null
                ? estimateLiquidationPrice(market, position, freshMarketSnapshot.liquidationThresholdBps()) : null;
        LendingPositionResponse.MarketRisk marketRisk = marketSnapshot == null ? null
                : new LendingPositionResponse.MarketRisk(
                        marketSnapshot.borrowLtvBps(), marketSnapshot.liquidationThresholdBps(),
                        // 现有快照没有预言机价格，不推断抵押价格或当前 LTV。
                        // The current snapshots do not contain an oracle price for collateral price or current LTV.
                        null, null, liquidationPrice);

        // 健康度和清算标记反映已采集的状态，缺失时保留 null，金额及 slot 用整数字符串无损传输。
        // Health and liquidation eligibility reflect the observation and keep missing values null. Preserve amounts and slots as exact integer strings.
        BigDecimal healthFactor = position.healthFactor();
        return new LendingPositionResponse.Snapshot(
                position.slot().toString(), observedAt.toString(), Objects.toString(position.oracleSlot(), null),
                freshness, position.collateralRaw().toString(), position.debtRaw().toString(),
                healthFactor == null ? null : healthFactor.toPlainString(), position.isLiquidatable(),
                position.supplySharesRaw().toString(), position.suppliedValueRaw().toString(),
                limits.borrowRaw(), limits.collateralWithdrawRaw(), limits.supplyWithdrawRaw(),
                limits.supplyWithdrawSharesRaw(), marketRisk);
    }

    /**
     * 从现有快照中推导可确定的额度，其余保留为空。
     * Derives limits that are provable from existing snapshots and leaves other limits null.
     *
     * @param position 新鲜的钱包仓位。 Fresh wallet position.
     * @param marketSnapshot 同 slot 且新鲜的市场快照，缺失或过期时为空。 Fresh same-slot market snapshot, or null if missing or stale.
     * @return 按对应 Mint 或份额单位表示的额度，未知时为空。 Limits as base-unit amounts or share quantities, or null when unknown.
     */
    private static PositionLimits knownPositionLimits(
            LendingPositionSnapshotDO position, LendingMarketSnapshotDO marketSnapshot) {
        // 抵押数量为零或市场禁止新增借款时，不需要依赖预言机价格即可确定零额度。
        // Zero collateral or a market restriction can establish zero borrowing headroom without an oracle price.
        boolean noCollateral = position.collateralRaw().signum() == 0;
        boolean zeroBorrowLtv = marketSnapshot != null && marketSnapshot.borrowLtvBps() == 0;
        boolean noMarketBorrowRoom = marketSnapshot != null && marketSnapshot.availableToBorrowRaw().signum() == 0;
        String borrowRaw = noCollateral || zeroBorrowLtv || noMarketBorrowRoom ? "0" : null;

        // 首版无抵押提取锁，因此无债务时可取回全部抵押品。有债务且无有效价格时只给出已知的零。
        // The first version has no collateral withdrawal lock, so a debt-free wallet can withdraw all collateral.
        // For a wallet with debt, return only a provable zero while a usable price is unavailable.
        String collateralWithdrawRaw = position.debtRaw().signum() == 0
                ? position.collateralRaw().toString()
                : noCollateral || zeroBorrowLtv ? "0" : null;

        // 整仓账面估值为零或池内现金为零时，任何可提份额的预计到账也为零。
        // If the whole position's book value or the pool cash is zero, any share withdrawal would pay zero.
        boolean zeroSupplyValue = position.suppliedValueRaw().signum() == 0;
        boolean inconsistentSupply = position.supplySharesRaw().signum() == 0 && !zeroSupplyValue;
        boolean noPoolCash = marketSnapshot != null && marketSnapshot.cashRaw().signum() == 0;
        String supplyWithdrawRaw = !inconsistentSupply && (zeroSupplyValue || noPoolCash) ? "0" : null;
        // 没有总份额和提现流动性，金额与份额都只能返回已知的零或空值。
        // Without total shares and withdrawal liquidity, both the payout and share cap are either known zero or null.
        return new PositionLimits(borrowRaw, collateralWithdrawRaw, supplyWithdrawRaw, supplyWithdrawRaw);
    }

    /**
     * 估算健康度等于一时的抵押价格。该临界价格不依赖当前预言机价格。
     * Estimates the collateral price at which health equals one, without using a current oracle price.
     *
     * @param market 借款 Mint 和抵押 Mint 的市场登记。 Market registration identifying the debt and collateral mints.
     * @param position 提供正债务和抵押数量的钱包仓位。 Wallet position supplying debt and collateral amounts.
     * @param thresholdBps 同 slot 市场的清算阈值，单位为基点。 Same-slot market liquidation threshold in basis points.
     * @return 每个整单位抵押资产所需的借款资产价格，无法推导时为空。
     *         Debt asset units per whole collateral unit, or null when the estimate is unavailable.
     */
    private String estimateLiquidationPrice(LendingMarketDO market, LendingPositionSnapshotDO position, int thresholdBps) {
        if (position.debtRaw().signum() == 0 || position.collateralRaw().signum() == 0 || thresholdBps <= 0) {
            return null;
        }

        // 用同网络登记的两种 Mint 精度换算最小单位；缺少任一精度时保留空值。
        // Scale base units using the two mint decimals from the same network. Leave the result null if either is unavailable.
        Map<String, AssetMintDO> assetsByMint = assetMintMapper
                .selectByNetworkAndMintAddresses(market.network(), Set.of(market.debtMint(), market.collateralMint()))
                .stream()
                .collect(Collectors.toMap(AssetMintDO::mintAddress, Function.identity()));
        AssetMintDO debtMint = assetsByMint.get(market.debtMint());
        AssetMintDO collateralMint = assetsByMint.get(market.collateralMint());
        if (debtMint == null || collateralMint == null) {
            return null;
        }

        // 用展示单位的债务除以乘上清算阈值的抵押数量。十进制精度仅用于估算展示。
        // Divide debt in display units by collateral units weighted by the liquidation threshold. Decimal precision is for display.
        BigDecimal debt = new BigDecimal(position.debtRaw(), debtMint.decimals());
        BigDecimal collateral = new BigDecimal(position.collateralRaw(), collateralMint.decimals());
        BigDecimal threshold = BigDecimal.valueOf(thresholdBps, 4);
        return debt.divide(collateral.multiply(threshold), MathContext.DECIMAL128)
                .stripTrailingZeros().toPlainString();
    }

    /**
     * 钱包当前额度，按相应资产或池份额最小单位传输。
     * Current wallet limits expressed in asset base units or pool share units.
     *
     * @param borrowRaw 借款资产的最多可借金额，未知时为空。 Maximum borrow amount in debt asset units, or null when unknown.
     * @param collateralWithdrawRaw 最多可取回的抵押数量，未知时为空。 Maximum collateral withdrawal, or null when unknown.
     * @param supplyWithdrawRaw 出借资金最多可提取金额，未知时为空。 Maximum supply payout, or null when unknown.
     * @param supplyWithdrawSharesRaw 与提取额对应的份额数量，未知时为空。 Shares corresponding to the payout, or null when unknown.
     */
    private record PositionLimits(
            String borrowRaw, String collateralWithdrawRaw, String supplyWithdrawRaw, String supplyWithdrawSharesRaw) {

        /** 观测过期时所有当前额度均不可用。 Current limits are unavailable when the wallet observation is stale. */
        private static final PositionLimits UNAVAILABLE = new PositionLimits(null, null, null, null);
    }

    /**
     * 获取市场登记要求存在的指定 Mint 资产元数据。
     * Looks up mint metadata required by the market registration.
     *
     * @param assetsByMint 同一网络中按 Mint 地址索引的资产。 Assets indexed by mint address on the same network.
     * @param mintAddress 借款或抵押 Mint 的链上公钥。 On-chain public key of the debt or collateral mint.
     * @return 含 Mint、展示简称和小数位的元数据。 Metadata containing mint, symbol and decimal precision.
     * @throws IllegalStateException 所需 Mint 缺少元数据。 Metadata for the required mint is missing.
     */
    private static AssetMintResponse requireAsset(Map<String, AssetMintResponse> assetsByMint, String mintAddress) {
        // 目录外键要求该 Mint 存在，缺失时中止查询，避免猜测资产精度。
        // The registration foreign key requires this mint. Abort rather than guessing decimals when it is missing.
        AssetMintResponse asset = assetsByMint.get(mintAddress);
        if (asset == null) {
            throw new IllegalStateException("Missing asset metadata for configured mint: " + mintAddress);
        }
        return asset;
    }

    /**
     * 转换资金池快照的时间和原始金额，并按配置标记新鲜度。
     * Formats snapshot timing and raw amounts and marks freshness using the configured threshold.
     *
     * @param record 最新资金池快照，尚未观测时为空。 Latest pool snapshot, or null if the market is unobserved.
     * @param now 本次响应的统一服务端时刻。 Server time shared by all markets in this response.
     * @return 最新概况，未观测时为空。 Latest overview, or null for an unobserved market.
     */
    private LendingMarketListResponse.Snapshot toSnapshot(LendingMarketSnapshotDO record, Instant now) {
        if (record == null) {
            return null;
        }

        // 观测时间转换为 UTC；slot 和金额用完整精度的十进制文本，比例沿用观测基点。
        // Convert observation time to UTC. Use full-precision decimal text for slot and amounts and retain observed bps.
        Instant observedAt = record.observedAt().toInstant();
        return new LendingMarketListResponse.Snapshot(
                record.slot().toString(),
                observedAt.toString(),
                record.cashRaw().toString(),
                record.availableToBorrowRaw().toString(),
                record.totalDebtRaw().toString(),
                record.utilizationBps(),
                record.borrowRateBps(),
                record.supplyRateBps(),
                SnapshotFreshness.at(observedAt, now, snapshotMaxAge)
        );
    }
}

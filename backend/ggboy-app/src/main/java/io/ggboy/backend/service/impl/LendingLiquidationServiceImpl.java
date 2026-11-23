package io.ggboy.backend.service.impl;

import io.ggboy.backend.api.LendingLiquidationPageResponse;
import io.ggboy.backend.api.LendingLiquidationPageResponse.Availability;
import io.ggboy.backend.api.LendingLiquidationPageResponse.Item;
import io.ggboy.backend.api.LendingOraclePriceVersion;
import io.ggboy.backend.api.LiquidationCursor;
import io.ggboy.backend.api.SnapshotFreshness;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;
import io.ggboy.backend.mapper.LendingMarketMapper;
import io.ggboy.backend.mapper.LendingMarketSnapshotMapper;
import io.ggboy.backend.mapper.LendingPositionSnapshotMapper;
import io.ggboy.backend.service.LendingLiquidationService;
import io.ggboy.common.api.SolanaNetwork;
import io.ggboy.common.utils.SolanaAddressUtil;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 在一致的数据库读视图中验证预言机观测并筛选已发布的最新仓位。
 * Verifies the oracle observation and filters the latest published positions in a consistent database view.
 */
@Service
public class LendingLiquidationServiceImpl implements LendingLiquidationService {

    /** 单次读取的原始仓位上限，也限制新仓位查询的地址集合。 Bounds each position batch and its newer-wallet lookup. */
    private static final int SCAN_BATCH_SIZE = 100;

    /** 查询市场登记与预言机配置。 Loads market registration and oracle configuration. */
    private final LendingMarketMapper marketMapper;

    /** 查询市场的最新观测。 Loads the latest market observation. */
    private final LendingMarketSnapshotMapper snapshotMapper;

    /** 按风险顺序扫描仓位并查询有更新观测的钱包。 Scans positions in risk order and finds wallets with newer observations. */
    private final LendingPositionSnapshotMapper positionMapper;

    /** 市场与仓位快照允许的最长观测时长。 Maximum observation age for market and position snapshots. */
    private final Duration snapshotMaxAge;

    /**
     * 注入查询依赖和快照有效期。
     * Wires query dependencies and the snapshot freshness threshold.
     *
     * @param marketMapper 市场登记查询。 Market registration queries.
     * @param snapshotMapper 市场快照查询。 Market snapshot queries.
     * @param positionMapper 仓位快照查询。 Position snapshot queries.
     * @param snapshotMaxAgeSeconds 快照最大有效期，单位为秒，必须为正数。 Positive snapshot age limit in seconds.
     * @throws IllegalArgumentException 快照有效期小于一秒。 The snapshot age limit is less than one second.
     */
    public LendingLiquidationServiceImpl(
            LendingMarketMapper marketMapper,
            LendingMarketSnapshotMapper snapshotMapper,
            LendingPositionSnapshotMapper positionMapper,
            @Value("${ggboy.lending.snapshot-stale-after-seconds}") long snapshotMaxAgeSeconds
    ) {
        // 启动时校验快照时间阈值，保证请求可使用有效的最大观测时长。
        // Validate the freshness threshold at startup so requests use a valid age limit.
        if (snapshotMaxAgeSeconds < 1) {
            throw new IllegalArgumentException("Lending snapshot freshness must be at least one second");
        }
        this.marketMapper = marketMapper;
        this.snapshotMapper = snapshotMapper;
        this.positionMapper = positionMapper;
        this.snapshotMaxAge = Duration.ofSeconds(snapshotMaxAgeSeconds);
    }

    /**
     * 为「清算市场」列表加载首页或续页，覆盖进入页面、切换市场及前端刷新。
     * Loads the first or next Liquidation Market page on entry, market switch, or frontend refresh.
     *
     * @param network 已解析的目标网络。 The parsed target network.
     * @param marketAddress 已验证的市场公钥。 The validated market public key.
     * @param limit 单页返回的最大条数。 Maximum number of items to return.
     * @param cursor 上页游标，首页为空值。 Cursor from the previous page, or null for the first page.
     * @return 市场状态及分页列表，市场未登记时为空。 Market availability and page, or empty if unregistered.
     * @throws LiquidationCursor.ObservationChangedException 可用市场观测与游标不同。
     *                                                       The available market observation differs from the cursor.
     */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Optional<LendingLiquidationPageResponse> listLiquidations(
            SolanaNetwork network, String marketAddress, int limit, LiquidationCursor cursor
    ) {
        // 网络协议值限定所有查询的范围，先读登记和该市场的最后一次观测。
        // The network wire value scopes all queries. Read the registration and its last market observation first.
        String networkValue = network.wireValue();
        LendingMarketDO market = marketMapper.selectByNetworkAndAddress(networkValue, marketAddress);
        if (market == null) {
            return Optional.empty();
        }
        LendingMarketSnapshotDO snapshot = snapshotMapper.selectLatestByNetworkAndAddress(networkValue, marketAddress);

        // 固定本次请求的时间基准，让价格和仓位使用同一时间评估。
        // Capture the request time once so price and position checks use the same instant.
        Instant now = Instant.now();
        Availability availability = availability(market, snapshot, now);

        // 数据不可用时直接返回当前市场状态。状态可用时才校验续页是否仍对应同一次观测。
        // Return the current market status when unavailable. Validate cursor continuity only when it is ready.
        if (availability != Availability.READY) {
            return Optional.of(unavailablePage(networkValue, marketAddress, snapshot, availability));
        }
        if (cursor != null) {
            cursor.requireObservation(snapshot.slot(), snapshot.oraclePriceVersion());
        }

        // 命中集可多含一条以判断还有续页。响应页只保留实际应返回的行，并使用其末条生成游标。
        // The match set includes one possible lookahead row. Keep only the requested rows and use their final row for the cursor.
        List<LendingPositionSnapshotDO> matches = selectPageCandidates(
                networkValue, marketAddress, snapshot, limit + 1, cursor, now
        );
        boolean hasMore = matches.size() > limit;
        List<LendingPositionSnapshotDO> page = hasMore ? matches.subList(0, limit) : matches;
        String nextCursor = hasMore ? encodeCursor(network, marketAddress, snapshot, page.getLast()) : null;

        // 预言机比率已按完整代币记录，响应使用十进制文本保留精度。
        // The oracle ratio is already in whole-token units. Use decimal text in the response.
        String collateralPrice = new BigDecimal(snapshot.oraclePriceNumerator())
                .divide(new BigDecimal(snapshot.oraclePriceDenominator()), MathContext.DECIMAL128)
                .stripTrailingZeros()
                .toPlainString();
        return Optional.of(new LendingLiquidationPageResponse(
                networkValue,
                marketAddress,
                Availability.READY,
                snapshot.slot().toString(),
                snapshot.observedAt().toInstant().toString(),
                snapshot.oracleAddress(),
                snapshot.oracleSlot().toString(),
                snapshot.oraclePublishedAt().toInstant().toString(),
                collateralPrice,
                page.stream().map(LendingLiquidationServiceImpl::toItem).toList(),
                nextCursor
        ));
    }

    /**
     * 按快照、观测时效、价格和批次发布状态依次确定可用性。
     * Resolves availability in order of snapshot presence, freshness, price validity and batch publication.
     *
     * @param market 登记的市场与预言机配置。 Registered market and oracle configuration.
     * @param snapshot 最新市场快照，可为空。 Latest market snapshot, which may be null.
     * @param now 用于本次请求的新鲜度时间基准。 Freshness reference instant for the request.
     * @return 前端应展示的清算数据状态。 Liquidation data status to display in the frontend.
     */
    private Availability availability(LendingMarketDO market, LendingMarketSnapshotDO snapshot, Instant now) {
        // 保留最新观测的状态，避免使用先前的价格或风险批次重新筛选。
        // Report the latest observation without selecting an earlier price or risk batch.
        if (snapshot == null) {
            return Availability.NO_SNAPSHOT;
        }
        if (!isFresh(snapshot.observedAt().toInstant(), now, snapshotMaxAge)) {
            return Availability.STALE;
        }
        if (!hasValidOraclePrice(market, snapshot, now)) {
            return Availability.PRICE_UNAVAILABLE;
        }
        return snapshot.riskBatchPublished() ? Availability.READY : Availability.NO_SNAPSHOT;
    }

    /**
     * 核对预言机身份、报价方向、价格数值、发布时间及同一报价版本。
     * Checks oracle identity, quote direction, price values, publication time and the price version.
     *
     * @param market 登记的市场及其预言机公钥与允许时长。 Registered market with its oracle address and age limit.
     * @param snapshot 包含预言机元数据的市场快照。 Market snapshot with oracle metadata.
     * @param now 用于检查价格时效的时间基准。 Reference instant for price freshness.
     * @return 价格能否用于此市场的清算查询。 Whether this price can be used for the market's liquidation query.
     */
    private boolean hasValidOraclePrice(LendingMarketDO market, LendingMarketSnapshotDO snapshot, Instant now) {
        // 价格必须来自市场登记的预言机，并按抵押资产兑借款资产报价。
        // The configured oracle must quote the collateral asset in debt-asset units.
        String expectedOracle = market.oracleAddress();
        Integer oracleMaxAgeSeconds = market.oracleMaxAgeSeconds();
        if (!isPublicKey(expectedOracle) || !expectedOracle.equals(snapshot.oracleAddress())
                || oracleMaxAgeSeconds == null || oracleMaxAgeSeconds < 1
                || !market.collateralMint().equals(snapshot.oracleCollateralMint())
                || !market.debtMint().equals(snapshot.oracleDebtMint())) {
            return false;
        }

        // 预言机 slot 必须是有效的无符号整数，且不能领先于市场观测。
        // The oracle slot must be an unsigned 64-bit value no later than the market observation.
        BigInteger oracleSlot = snapshot.oracleSlot();
        if (oracleSlot == null || oracleSlot.signum() < 0 || oracleSlot.bitLength() > 64
                || oracleSlot.compareTo(snapshot.slot()) > 0
                || !isPositive(snapshot.oraclePriceNumerator()) || !isPositive(snapshot.oraclePriceDenominator())
                || snapshot.oraclePublishedAt() == null) {
            return false;
        }

        // 价格的独立有效期从预言机发布时间起算。
        // Assess price freshness independently from the oracle's publication time.
        Instant publishedAt = snapshot.oraclePublishedAt().toInstant();
        return !publishedAt.isAfter(snapshot.observedAt().toInstant())
                && isFresh(publishedAt, now, Duration.ofSeconds(oracleMaxAgeSeconds))
                && LendingOraclePriceVersion.matches(snapshot);
    }

    /**
     * 从游标边界分批扫描仓位，先排除有更新观测的钱包，再按清算规则筛选。
     * Scans positions in batches after the cursor, excluding superseded wallets before applying liquidation checks.
     *
     * @param network 查询网络。 Query network.
     * @param marketAddress 借贷市场公钥。 Lending market public key.
     * @param snapshot 已验证且已发布的目标市场快照。 Verified, published market snapshot.
     * @param fetchCount 需要的命中条数，含用来判断续页的额外一条。 Number of matches needed, including the lookahead row.
     * @param cursor 上页边界，首页为空值。 Previous page boundary, or null for the first page.
     * @param now 用于检查仓位时效的时间基准。 Reference instant for position freshness.
     * @return 按健康度和钱包地址升序的有效仓位。 Eligible positions ordered by health factor and wallet address.
     */
    private List<LendingPositionSnapshotDO> selectPageCandidates(
            String network, String marketAddress, LendingMarketSnapshotDO snapshot,
            int fetchCount, LiquidationCursor cursor, Instant now
    ) {
        // 健康度和钱包公钥共同定位数据库扫描边界，命中集仅保留通过清算校验的仓位。
        // Health factor and wallet key locate the scan boundary. The match list keeps only eligible positions.
        BigDecimal afterHealth = cursor == null ? null : cursor.healthFactor();
        String afterWallet = cursor == null ? null : cursor.walletAddress();
        List<LendingPositionSnapshotDO> matches = new ArrayList<>(fetchCount);

        while (true) {
            // 固定到已发布的市场 slot，再按批读取观测和查找钱包的更新观测。
            // Read one batch at the published market slot, then look up any newer observations for those wallets.
            List<LendingPositionSnapshotDO> batch = positionMapper.selectLiquidationScanBatch(
                    network, marketAddress, snapshot.slot(), afterHealth, afterWallet, SCAN_BATCH_SIZE
            );
            if (batch.isEmpty()) {
                return matches;
            }
            // 批量候选公钥用来查询较新记录，结果转换为集合供筛选时按公钥查找。
            // Query for newer rows using the batch wallet keys, then index those results for candidate filtering.
            List<String> wallets = batch.stream().map(LendingPositionSnapshotDO::walletAddress).toList();
            Set<String> newerWallets = Set.copyOf(positionMapper
                    .selectWalletsWithNewerPosition(network, marketAddress, snapshot.slot(), wallets));

            for (LendingPositionSnapshotDO position : batch) {
                // 更新观测即使已还清债务或缺少价格，也会使旧仓位失效。
                // A newer observation supersedes the earlier row even if it has no debt or price.
                if (newerWallets.contains(position.walletAddress()) || !isCandidate(position, snapshot, now)) {
                    continue;
                }
                matches.add(position);
                if (matches.size() == fetchCount) {
                    return matches;
                }
            }
            if (batch.size() < SCAN_BATCH_SIZE) {
                return matches;
            }

            // 按本数据库批次的末条推进键集边界，即使该条未入选。
            // Advance the keyset using the final scanned row even when it was ineligible.
            LendingPositionSnapshotDO lastScanned = batch.getLast();
            afterHealth = lastScanned.healthFactor();
            afterWallet = lastScanned.walletAddress();
        }
    }

    /**
     * 确认最新仓位可展示且与本次价格版本兼容。
     * Checks that the latest position can be displayed and is compatible with the selected price version.
     *
     * @param position 钱包在已发布批次中的最新仓位。 Latest wallet position in the published batch.
     * @param snapshot 已验证的市场价格观测。 Verified market price observation.
     * @param now 用于检查仓位时效的时间基准。 Reference instant for position freshness.
     * @return 当前仓位是否可出现在清算市场。 Whether the position can appear in the liquidation market.
     */
    private boolean isCandidate(LendingPositionSnapshotDO position, LendingMarketSnapshotDO snapshot, Instant now) {
        // 清算布尔标志来自索引的链上风险结果，健康度仅用于排序和展示。
        // The indexed on-chain risk flag determines eligibility. Health factor serves ordering and display.
        return isPositive(position.collateralRaw())
                && isPositive(position.debtRaw())
                && Boolean.TRUE.equals(position.isLiquidatable())
                && position.healthFactor() != null
                && snapshot.oracleSlot().equals(position.oracleSlot())
                && snapshot.oraclePriceVersion().equals(position.oraclePriceVersion())
                && isFresh(position.observedAt().toInstant(), now, snapshotMaxAge)
                && isPublicKey(position.walletAddress());
    }

    /**
     * 检查观测时间未超出当前时间和最大时长。
     * Checks that an observation is neither in the future nor older than the applicable age limit.
     *
     * @param observedAt 观测时间。 Observation time.
     * @param now 服务端参考时间。 Server reference time.
     * @param maxAge 允许的最长时长。 Maximum permitted age.
     * @return 观测是否有效。 Whether the observation is fresh.
     */
    private static boolean isFresh(Instant observedAt, Instant now, Duration maxAge) {
        return !observedAt.isAfter(now) && SnapshotFreshness.at(observedAt, now, maxAge) == SnapshotFreshness.FRESH;
    }

    /**
     * 确认原始金额或价格的有理数分量大于零。
     * Checks whether a raw amount or rational price component is positive.
     *
     * @param value 可为空的整数值。 Nullable integer value.
     * @return 值是否大于零。 Whether the value is greater than zero.
     */
    private static boolean isPositive(BigInteger value) {
        return value != null && value.signum() > 0;
    }

    /**
     * 确认地址是可用于分页或报价身份校验的 Solana 公钥。
     * Validates the Solana public key used for pagination or price identity checks.
     *
     * @param address 可为空的钱包或预言机地址。 Nullable wallet or oracle address.
     * @return 地址是否为 32 字节的 Base58 公钥。 Whether the address encodes a 32-byte Base58 public key.
     */
    private static boolean isPublicKey(String address) {
        if (address == null) {
            return false;
        }
        try {
            SolanaAddressUtil.requirePublicKey(address, "address");
            return true;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    /**
     * 构造不可用状态，保留已观测的市场元数据供前端展示。
     * Builds an unavailable response and retains observed market metadata for the frontend.
     *
     * @param network 查询网络。 Query network.
     * @param marketAddress 借贷市场公钥。 Lending market public key.
     * @param snapshot 可为空的最新市场观测。 Latest market observation, or null if absent.
     * @param availability 市场清算数据不可用的原因。 Reason liquidation data is unavailable.
     * @return 空仓位列表和无价格的市场状态。 Availability with no positions or price.
     */
    private static LendingLiquidationPageResponse unavailablePage(
            String network, String marketAddress, LendingMarketSnapshotDO snapshot, Availability availability
    ) {
        return new LendingLiquidationPageResponse(
                network,
                marketAddress,
                availability,
                snapshot == null ? null : snapshot.slot().toString(),
                snapshot == null ? null : snapshot.observedAt().toInstant().toString(),
                null,
                null,
                null,
                null,
                List.of(),
                null
        );
    }

    /**
     * 将市场价格观测和末条仓位的排序值组合成续页游标。
     * Encodes the market price observation and the final returned position's sort values in a cursor.
     *
     * @param network 查询网络。 Query network.
     * @param marketAddress 借贷市场公钥。 Lending market public key.
     * @param snapshot 续页必须匹配的市场价格观测。 Market price observation required on the next page.
     * @param lastItem 已返回的末条仓位。 Last returned position.
     * @return 续页游标字符串。 Continuation cursor token.
     */
    private static String encodeCursor(
            SolanaNetwork network, String marketAddress, LendingMarketSnapshotDO snapshot, LendingPositionSnapshotDO lastItem
    ) {
        return LiquidationCursor.encode(network, marketAddress, new LiquidationCursor(
                snapshot.slot(), snapshot.oraclePriceVersion(), lastItem.healthFactor(), lastItem.walletAddress()
        ));
    }

    /**
     * 使用十进制文本保留清算表格所需的链上金额和健康度精度。
     * Preserves on-chain amount and health factor precision as decimal text for the liquidation table.
     *
     * @param position 已通过清算展示校验的仓位。 Position verified for liquidation display.
     * @return 清算市场表格的一行。 One row in the liquidation market table.
     */
    private static Item toItem(LendingPositionSnapshotDO position) {
        return new Item(
                position.walletAddress(),
                position.collateralRaw().toString(),
                position.debtRaw().toString(),
                position.healthFactor().toPlainString(),
                position.slot().toString(),
                position.observedAt().toInstant().toString(),
                true
        );
    }
}

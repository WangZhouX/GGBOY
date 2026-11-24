package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.entity.ChainEventKey;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.indexer.LendingActivityDecoder.Event;
import io.ggboy.backend.indexer.LendingActivityDecoder.SupplyWithdrawalEvent;
import io.ggboy.backend.indexer.VaultActivityData.Signature;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.mapper.ChainEventAssetMapper;
import io.ggboy.backend.mapper.ChainEventMapper;
import io.ggboy.backend.mapper.ChainEventParticipantMapper;
import io.ggboy.backend.mapper.LendingMarketMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static io.ggboy.backend.indexer.ActivityIndexStore.NETWORK;

/**
 * 将已确认借贷动作、签名参与者、资产变动和续扫边界原子地写入现有活动表。
 * Atomically persists finalized lending actions, signing participants, asset movements and the frontier in the existing activity tables.
 */
@Service
public class LendingActivityStore {

    /** 读写共用的检查点和父交易。 Shared checkpoint and parent transaction persistence. */
    private final ActivityIndexStore indexStore;
    /** 核对链上动作对应的 Devnet 市场登记及其 Mint 绑定。 Verifies registered Devnet markets and their mint bindings. */
    private final LendingMarketMapper markets;
    /** 按网络读取市场绑定 Mint 的精度。 Reads the decimals of market-bound mints in the same network. */
    private final AssetMintMapper mints;
    /** 按网络、签名和日志序号读写借贷事件。 Reads and writes lending events by network, signature and log index. */
    private final ChainEventMapper activity;
    /** 写入借款人或出借人角色，供交易活动按钱包检索。 Writes borrower or supplier roles for wallet-filtered activity. */
    private final ChainEventParticipantMapper participants;
    /** 写入抵押品或借款代币的实际转账。 Writes the actual transfer of collateral or debt tokens. */
    private final ChainEventAssetMapper assets;

    /**
     * 注入共用存储、借贷登记和活动明细 Mapper。
     * Injects shared persistence, lending registrations and activity detail mappers.
     *
     * @param indexStore 检查点与父交易存储。 Checkpoint and parent transaction persistence.
     * @param markets 借贷市场登记。 Registered lending markets.
     * @param mints 代币 Mint 登记。 Token mint registrations.
     * @param activity 借贷业务事件。 Lending business events.
     * @param participants 事件参与者。 Event participants.
     * @param assets 事件资产变动。 Event asset movements.
     */
    LendingActivityStore(
            ActivityIndexStore indexStore, LendingMarketMapper markets, AssetMintMapper mints,
            ChainEventMapper activity, ChainEventParticipantMapper participants, ChainEventAssetMapper assets
    ) {
        this.indexStore = indexStore;
        this.markets = markets;
        this.mints = mints;
        this.activity = activity;
        this.participants = participants;
        this.assets = assets;
    }

    /**
     * 仅在已登记属于当前程序的 Devnet 市场时开始索引。
     * Indexes only if a Devnet market has been registered for this program.
     *
     * @param programId 配置的 Devnet 借贷程序公钥。 Configured Devnet lending program public key.
     * @return 已有匹配登记时为真。 True when a matching registration exists.
     */
    public boolean hasRegisteredMarket(String programId) {
        return markets.selectByNetwork(NETWORK).stream().anyMatch(market -> programId.equals(market.programId()));
    }

    /**
     * 读取当前借贷程序最后处理的最终确认签名及 slot。
     * Reads the lending program's last processed finalized signature and slot.
     *
     * @param programId 配置的 Devnet 借贷程序公钥。 Configured Devnet lending program public key.
     * @return 已推进的边界，首次同步时为空。 Committed frontier or empty before indexing.
     */
    public Optional<Signature> checkpoint(String programId) {
        return indexStore.checkpoint(programId);
    }

    /**
     * 在一次事务中推进签名边界并保存同笔交易的全部已登记市场事件。
     * Advances the signature frontier and writes all events for registered markets in a single database transaction.
     *
     * @param programId 当前扫描的 Devnet 借贷程序公钥。 Devnet lending program public key being scanned.
     * @param expected 本轮读取的边界，首次同步时为空。 Observed frontier, or null on first sync.
     * @param current 已处理的最终确认签名及 slot。 Processed finalized signature and slot.
     * @param blockTime 链上区块 UTC 时间，未提供时可为空。 On-chain UTC block time, nullable when unavailable.
     * @param events 已验证的借贷动作日志，失败交易或没有借贷动作的交易传空列表。 Validated action logs, empty for failed or unrelated transactions.
     * @return 事务获准推进时为真，并发实例已更新旧边界时为假。 True after advancement, or false if a concurrent worker updated the frontier.
     */
    @Transactional
    public boolean commit(String programId, Signature expected, Signature current,
                          OffsetDateTime blockTime, List<Event> events) {
        if (current.failed() && !events.isEmpty()) {
            throw new IllegalArgumentException("A failed finalized transaction cannot create lending activity");
        }

        /** 记录索引的 UTC 时间，链上交易时间单独保存。 UTC indexing time, distinct from the transaction's on-chain time. */
        OffsetDateTime indexedAt = OffsetDateTime.now(ZoneOffset.UTC);
        // 先用检查点获得当前边界的写入资格。后续任意插入失败时连同边界一起回滚。
        // Claim the frontier before inserting. Any later insert failure rolls back the frontier in the same transaction.
        if (!indexStore.advanceCheckpoint(programId, expected, current, indexedAt)) {
            return false;
        }

        /** 同笔交易只准备一个父记录，只有实际写入事件时才创建。 Prepare one parent per transaction and only when an event is inserted. */
        boolean parentReady = false;
        for (Event event : events) {
            /** 事件市场必须已在 Devnet 登记且绑定当前程序。 The event market must be registered on Devnet and bound to this program. */
            LendingMarketDO market = markets.selectByNetworkAndAddress(NETWORK, event.market());
            if (market == null || !programId.equals(market.programId())) {
                continue;
            }
            /** 用原始日志位置保证同一签名的不同动作拥有独立的回执链接。 Use the raw log position to give each action in a transaction its own receipt URL. */
            ChainEventKey key = new ChainEventKey(current.value(), event.logIndex());
            if (activity.selectByEventKey(NETWORK, key) != null) {
                continue;
            }
            if (!parentReady) {
                indexStore.ensureParent(current, blockTime, indexedAt);
                parentReady = true;
            }
            insertEvent(programId, key, market, event);
        }
        return true;
    }

    /**
     * 依据已登记市场的抵押 Mint 和借款 Mint 写入事件、参与方和实际资产变动。
     * Stores the event, participant, and actual asset movement using the registered collateral or debt mint.
     *
     * @param programId 已核对的链上借贷程序公钥。 Verified on-chain lending program public key.
     * @param key 签名及原始日志序号。 Signature and original log index.
     * @param market 已登记的 Devnet 市场和绑定 Mint。 Registered Devnet market and its mint bindings.
     * @param event 已核对签名的链上动作和实际最小单位转账量。 Signer-verified on-chain action and actual transfer in token base units.
     */
    private void insertEvent(String programId, ChainEventKey key, LendingMarketDO market, Event event) {
        /** 抵押存取使用抵押 Mint。借款、还款与出借提取使用借款 Mint。 Collateral deposits and withdrawals use the collateral mint. Borrows, repayments, and supply withdrawals use the debt mint. */
        String mintAddress = event.action().usesCollateralMint() ? market.collateralMint() : market.debtMint();
        // 提取回执中的付款 Mint 必须与市场登记一致。遇到不一致时回滚本次事务与检查点。
        // Verify the payout mint against the market registry. A mismatch rolls back the transaction and checkpoint.
        if (event instanceof SupplyWithdrawalEvent withdrawal && !mintAddress.equals(withdrawal.debtMint())) {
            throw new IllegalStateException("Devnet lending withdrawal payout mint does not match market " + market.marketAddress());
        }

        /** 由市场登记选择的 Mint，精度用于数值展示，实际数量仍保存整数。 Market-bound mint supplying precision for display while the amount remains an integer. */
        AssetMintDO mint = mints.selectByNetworkAndMintAddresses(NETWORK, List.of(mintAddress)).stream()
                .findFirst().orElseThrow(() -> new IllegalStateException("Missing Devnet lending mint metadata: " + mintAddress));

        activity.insert(new ChainEventDO(NETWORK, key.signature(), key.eventIndex(), programId, "LENDING",
                event.action().eventType(), market.marketAddress()));
        participants.insert(new ChainEventParticipantDO(
                NETWORK, key.signature(), key.eventIndex(), event.wallet(), event.action().participantRole()));
        assets.insert(new ChainEventAssetDO(NETWORK, key.signature(), key.eventIndex(), 0,
                mint.mintAddress(), mint.decimals(), event.amountRaw(), event.action().movement()));
    }
}

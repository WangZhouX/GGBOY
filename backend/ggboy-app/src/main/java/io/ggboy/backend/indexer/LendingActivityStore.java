package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.entity.ChainEventKey;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.indexer.LendingActivityDecoder.Event;
import io.ggboy.backend.indexer.LendingActivityDecoder.LiquidationEvent;
import io.ggboy.backend.indexer.LendingActivityDecoder.SinglePartyEvent;
import io.ggboy.backend.indexer.LendingActivityDecoder.SupplyEvent;
import io.ggboy.backend.indexer.VaultActivityData.Signature;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.mapper.ChainEventAssetMapper;
import io.ggboy.backend.mapper.ChainEventMapper;
import io.ggboy.backend.mapper.ChainEventParticipantMapper;
import io.ggboy.backend.mapper.LendingMarketMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigInteger;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;

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
    /** 写入借款人、出借人及清算人角色，供交易活动按钱包检索。 Writes borrower, supplier and liquidator roles for wallet-filtered activity. */
    private final ChainEventParticipantMapper participants;
    /** 写入实际转账和坏账核销。 Persists actual transfers and bad debt write-offs. */
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
            switch (event) {
                case SinglePartyEvent single -> insertEvent(programId, key, market, single);
                case LiquidationEvent liquidation -> insertLiquidation(programId, key, market, liquidation);
            }
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
    private void insertEvent(String programId, ChainEventKey key, LendingMarketDO market, SinglePartyEvent event) {
        /** 抵押存取使用抵押 Mint。借款、还款及出借存取使用借款 Mint。 Collateral transfers use the collateral mint. Loans, repayments, supply deposits, and supply withdrawals use the debt mint. */
        String mintAddress = event.action().usesCollateralMint() ? market.collateralMint() : market.debtMint();
        // 出借存取回执中的实际 Mint 必须与市场登记一致，不匹配时回滚本次事务与检查点。
        // Both supply flows must use the registered debt mint. A mismatch rolls back the transaction and checkpoint.
        if (event instanceof SupplyEvent supply && !mintAddress.equals(supply.debtMint())) {
            throw new IllegalStateException("Devnet lending supply mint does not match market " + market.marketAddress());
        }

        /** 由市场登记选择的 Mint，精度用于数值展示，实际数量仍保存整数。 Market-bound mint supplying precision for display while the amount remains an integer. */
        AssetMintDO mint = mints.selectByNetworkAndMintAddresses(NETWORK, List.of(mintAddress)).stream()
                .findFirst().orElseThrow(() -> new IllegalStateException("Missing Devnet lending mint metadata: " + mintAddress));

        activity.insert(new ChainEventDO(NETWORK, key.signature(), key.eventIndex(), programId, "LENDING",
                event.action().eventType(), market.marketAddress()));
        participants.insert(new ChainEventParticipantDO(
                NETWORK, key.signature(), key.eventIndex(), event.wallet(), event.action().participantRole()));
        insertAsset(key, 0, mint, event.amountRaw(), event.action().movement());
    }

    /**
     * 用登记 Mint 的精度写入清算双方、实际代偿、划转抵押品和坏账核销。
     * Stores both liquidation parties, actual repayment, seized collateral and bad debt using registered mint precision.
     *
     * @param programId 已核对的借贷程序公钥。 Verified lending program key.
     * @param key 交易签名及稳定的原始日志序号。 Transaction signature and stable original log index.
     * @param market 已登记的目标市场及两个 Mint。 Registered market and its two mints.
     * @param event 已核对发起人签名和金额关系的清算事件。 Liquidation event with verified signer and amount relationships.
     * @throws IllegalStateException 事件 Mint 与市场不一致，或 Mint 元数据缺失。 Event mints differ from the market or required mint metadata is missing.
     */
    private void insertLiquidation(String programId, ChainEventKey key, LendingMarketDO market, LiquidationEvent event) {
        // 借款和抵押 Mint 与登记方向分别匹配，避免错用精度或把抵押品误记作坏账。
        // Match the debt and collateral mints in order to preserve decimals and keep collateral separate from bad debt.
        if (!event.debtMint().equals(market.debtMint()) || !event.collateralMint().equals(market.collateralMint())) {
            throw new IllegalStateException("Devnet lending liquidation mints do not match market " + market.marketAddress());
        }
        /** 代偿与坏账共享借款 Mint，抵押品用自己的精度。 Repayment and bad debt share the debt mint. Collateral uses its own precision. */
        Map<String, AssetMintDO> byMint = mints.selectByNetworkAndMintAddresses(NETWORK,
                        List.of(event.debtMint(), event.collateralMint())).stream()
                .collect(Collectors.toMap(AssetMintDO::mintAddress, Function.identity()));
        AssetMintDO debt = byMint.get(event.debtMint());
        AssetMintDO collateral = byMint.get(event.collateralMint());
        if (debt == null || collateral == null) {
            throw new IllegalStateException("Missing Devnet mint metadata for liquidation market " + market.marketAddress());
        }

        activity.insert(new ChainEventDO(NETWORK, key.signature(), key.eventIndex(), programId, "LENDING",
                "LENDING_LIQUIDATION", market.marketAddress()));
        participants.insert(new ChainEventParticipantDO(
                NETWORK, key.signature(), key.eventIndex(), event.borrower(), "BORROWER"));
        participants.insert(new ChainEventParticipantDO(
                NETWORK, key.signature(), key.eventIndex(), event.liquidator(), "LIQUIDATOR"));

        // 只保存真实发生的金额。单独核销坏账时用序号零，且不生成代偿或抵押品转账。
        // Store only actual movements. Write-off alone uses leg index zero and does not generate transfers.
        boolean repaid = event.repaidRaw().signum() > 0;
        if (repaid) {
            insertAsset(key, 0, debt, event.repaidRaw(), "DEBT_REPAID");
            insertAsset(key, 1, collateral, event.seizedCollateralRaw(), "COLLATERAL_SEIZED");
        }
        if (event.badDebtRaw().signum() > 0) {
            insertAsset(key, repaid ? 2 : 0, debt, event.badDebtRaw(), "BAD_DEBT");
        }
    }

    /**
     * 保存交易回执的一项资产变动或账面损失。
     * Persists one receipt leg for an asset movement or book loss.
     *
     * @param key 交易签名与原始日志序号。 Transaction signature and original log index.
     * @param legIndex 本事件内从零开始的回执明细序号。 Zero-based leg index within this event.
     * @param mint 已登记的 Mint 及其小数位数。 Registered mint and its decimal precision.
     * @param amountRaw 使用对应 Mint 最小单位的实际金额。 Actual amount in the mint's base units.
     * @param legType 数据库接受的业务变动代码。 Business movement code accepted by the database.
     */
    private void insertAsset(ChainEventKey key, int legIndex, AssetMintDO mint, BigInteger amountRaw, String legType) {
        assets.insert(new ChainEventAssetDO(NETWORK, key.signature(), key.eventIndex(), legIndex,
                mint.mintAddress(), mint.decimals(), amountRaw, legType));
    }
}

package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.entity.ChainEventKey;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.backend.indexer.VaultActivityData.Event;
import io.ggboy.backend.indexer.VaultActivityData.Signature;
import io.ggboy.backend.mapper.AssetMintMapper;
import io.ggboy.backend.mapper.ChainEventAssetMapper;
import io.ggboy.backend.mapper.ChainEventMapper;
import io.ggboy.backend.mapper.ChainEventParticipantMapper;
import io.ggboy.backend.mapper.VaultMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;

import static io.ggboy.backend.indexer.ActivityIndexStore.NETWORK;

/**
 * 将已解析的 Devnet 金库存赎记录和续扫检查点原子地保存到现有活动表。
 * Atomically persists decoded Devnet deposits and redemptions and the scan checkpoint in the existing activity tables.
 */
@Service
public class VaultActivityStore {

    /** 共用检查点推进和父交易写入。 Shares checkpoint advancement and parent transaction writes. */
    private final ActivityIndexStore indexStore;
    /** 从登记表核对金库归属和资产绑定。 Checks the vault registry for program and mint bindings. */
    private final VaultMapper vaultMapper;
    /** 从登记表读取 Mint 的小数位精度。 Reads registered mint decimal precision. */
    private final AssetMintMapper mintMapper;
    /** 读写单条已索引的业务事件。 Reads and writes individual indexed business events. */
    private final ChainEventMapper eventMapper;
    /** 保存事件投资者的参与记录。 Stores the investor's participation in each event. */
    private final ChainEventParticipantMapper participantMapper;
    /** 保存事件涉及的实际资产变动。 Stores actual asset movements recorded by each event. */
    private final ChainEventAssetMapper assetMapper;

    /**
     * 注入活动表、登记表和检查点的 MyBatis-Plus Mapper。
     * Injects MyBatis-Plus mappers for activities, registrations and checkpoints.
     *
     * @param indexStore 共用检查点与父交易存储。 Shared checkpoints and parent transaction store.
     * @param vaultMapper 金库登记。 Vault registrations.
     * @param mintMapper Mint 登记。 Mint registrations.
     * @param eventMapper 交易内业务事件。 Business events within a transaction.
     * @param participantMapper 事件参与者。 Event participants.
     * @param assetMapper 事件资产变动。 Event asset movements.
     */
    public VaultActivityStore(
            ActivityIndexStore indexStore, VaultMapper vaultMapper, AssetMintMapper mintMapper, ChainEventMapper eventMapper,
            ChainEventParticipantMapper participantMapper, ChainEventAssetMapper assetMapper
    ) {
        this.indexStore = indexStore;
        this.vaultMapper = vaultMapper;
        this.mintMapper = mintMapper;
        this.eventMapper = eventMapper;
        this.participantMapper = participantMapper;
        this.assetMapper = assetMapper;
    }

    /**
     * 检查是否有归属该程序的 Devnet 金库，供调度器在访问 RPC 前判断。
     * Checks for registered Devnet vaults belonging to this program before the scheduler calls RPC.
     *
     * @param programId Devnet 金库程序的公开地址。 Public address of the Devnet vault program.
     * @return 至少登记了一个匹配的金库时为真。 True if at least one matching vault is registered.
     */
    public boolean hasRegisteredVault(String programId) {
        return vaultMapper.existsByNetworkAndProgram(NETWORK, programId);
    }

    /**
     * 读取最近处理的交易签名和 slot，调度器据此找到后续待处理签名。
     * Reads the latest processed signature and slot so the scheduler can discover remaining entries.
     *
     * @param programId Devnet 金库程序的公开地址。 Public address of the Devnet vault program.
     * @return 已处理边界，从未推进时为空。 Processed frontier, or empty when it has never advanced.
     */
    public Optional<Signature> checkpoint(String programId) {
        return indexStore.checkpoint(programId);
    }

    /**
     * 在一个数据库事务中接受触发事件的交易并推进连续索引边界。
     * Accepts one processed transaction and advances the contiguous frontier in a single database transaction.
     *
     * @param programId Devnet 金库程序的公开地址。 Public address of the Devnet vault program.
     * @param expected 本次扫描看到的旧边界，首次同步为空。 Previous frontier observed by this scan, or null on the first scan.
     * @param current 经过最终确认的交易签名和 slot。 Finalized transaction signature and slot.
     * @param blockTime RPC 提供的区块时间，可为空。 RPC block timestamp, nullable.
     * @param events 已校验来源的 Anchor 存赎事件，失败交易或无匹配事件时为空表。 Provenanced Anchor deposit and redeem events, empty for failed or unrelated transactions.
     * @return 成功推进时为真，其他实例已推进后返回假以重新扫描。 True when committed, or false when a concurrent advance requires a fresh scan.
     */
    @Transactional
    public boolean commit(
            String programId, Signature expected, Signature current, OffsetDateTime blockTime, List<Event> events
    ) {
        if (current.failed() && !events.isEmpty()) {
            throw new IllegalArgumentException("A failed finalized transaction cannot create vault activity");
        }

        /** 记录处理时刻，不代替链上区块时间。 Processing timestamp, separate from the on-chain block time. */
        OffsetDateTime indexedAt = OffsetDateTime.now(ZoneOffset.UTC);
        // 把检查点当作写入前的并发门闩。事件写入失败时，事务回滚也会撤销边界推进。
        // Gate writes on the checkpoint. A failed event insert also rolls back the frontier change.
        if (!indexStore.advanceCheckpoint(programId, expected, current, indexedAt)) {
            return false;
        }

        /** 父交易是否已为本次处理准备好；仅存在符合条件的事件时才需要父记录。 Whether the parent is ready; only transactions with eligible events need a parent row. */
        boolean parentReady = false;
        for (Event event : events) {
            /** 事件所引用的 Devnet 金库登记。 Devnet vault registration referenced by the event. */
            VaultDO vault = vaultMapper.selectByNetworkAndAddress(NETWORK, event.vault());
            if (vault == null || !programId.equals(vault.programId())) {
                continue;
            }
            checkMintBindings(vault, event);
            /** 精确的事件主键中保留完整链上日志的位置。 Exact event key containing the position in the original on-chain logs. */
            ChainEventKey key = new ChainEventKey(current.value(), event.logIndex());
            // 同一签名仍可能有其他未导入的事件，去重必须包含事件序号。
            // A signature may contain other unindexed events, so deduplication includes the event index.
            if (eventMapper.selectByEventKey(NETWORK, key) != null) {
                continue;
            }
            if (!parentReady) {
                indexStore.ensureParent(current, blockTime, indexedAt);
                parentReady = true;
            }
            insertEvent(programId, key, event);
        }
        return true;
    }

    /**
     * 验证已登记金库所发出的事件使用配置表绑定的两个 Mint。
     * Verifies that a registered vault event uses both bound mints.
     *
     * @param vault 匹配网络和程序的金库登记。 Vault registration matching the network and program.
     * @param event 本笔交易中的链上存赎事件。 On-chain deposit or redemption event.
     * @throws IllegalStateException Mint 不匹配时回滚，以便修复配置后重试。 If the binding mismatches, roll back so configuration can be fixed and retried.
     */
    private void checkMintBindings(VaultDO vault, Event event) {
        if (!vault.quoteMint().equals(event.assetMint()) || !vault.shareMint().equals(event.shareMint())) {
            throw new IllegalStateException("Vault event mints differ from Devnet vault registration: " + event.vault());
        }
    }

    /**
     * 写入存赎事件、投资者及两条实际变动，金额保持链上最小单位。
     * Writes a deposit or redemption, its investor, and two movements in the original on-chain base units.
     *
     * @param programId 发出事件的金库程序公开地址。 Public key of the vault program that emitted the event.
     * @param key 本次写入的签名和日志位置。 Signature and original log position being written.
     * @param event 已验证的事件地址、类型和整数金额。 Validated on-chain event addresses, action and integer amounts.
     */
    private void insertEvent(String programId, ChainEventKey key, Event event) {
        /** 链上事件涉及的资产和份额 Mint 精度登记。 Registered precision for the asset and share mints from the event. */
        Map<String, AssetMintDO> mints = mintMapper.selectByNetworkAndMintAddresses(
                        NETWORK, List.of(event.assetMint(), event.shareMint())).stream()
                .collect(Collectors.toMap(AssetMintDO::mintAddress, Function.identity()));
        /** 结算资产的小数位精度，必须来自 Mint 登记。 Settlement mint precision from its required registration. */
        AssetMintDO asset = mints.get(event.assetMint());
        /** 份额的小数位精度，必须来自 Mint 登记。 Share mint precision from its required registration. */
        AssetMintDO shares = mints.get(event.shareMint());
        if (asset == null || shares == null) {
            throw new IllegalStateException("Missing Devnet mint metadata for vault: " + event.vault());
        }

        /** 现有活动查询采用的稳定事件类型。 Stable event type used by the existing activity query. */
        String eventType = switch (event.action()) {
            case DEPOSIT -> "VAULT_DEPOSIT";
            case REDEEM -> "VAULT_REDEEM";
        };
        eventMapper.insert(new ChainEventDO(NETWORK, key.signature(), key.eventIndex(), programId, "VAULT", eventType,
                event.vault()));
        participantMapper.insert(new ChainEventParticipantDO(NETWORK, key.signature(), key.eventIndex(), event.investor(),
                "INVESTOR"));
        // 按业务执行顺序编号，使回执先展示支付一侧，再展示用户实收一侧。
        // Number legs in execution order so the receipt shows payment before what the investor receives.
        switch (event.action()) {
            case DEPOSIT -> {
                assetMapper.insert(new ChainEventAssetDO(NETWORK, key.signature(), key.eventIndex(), 0,
                        asset.mintAddress(), asset.decimals(), event.assetAmount(), "ASSET_IN"));
                assetMapper.insert(new ChainEventAssetDO(NETWORK, key.signature(), key.eventIndex(), 1,
                        shares.mintAddress(), shares.decimals(), event.shareAmount(), "SHARES_MINTED"));
            }
            case REDEEM -> {
                assetMapper.insert(new ChainEventAssetDO(NETWORK, key.signature(), key.eventIndex(), 0,
                        shares.mintAddress(), shares.decimals(), event.shareAmount(), "SHARES_BURNED"));
                assetMapper.insert(new ChainEventAssetDO(NETWORK, key.signature(), key.eventIndex(), 1,
                        asset.mintAddress(), asset.decimals(), event.assetAmount(), "ASSET_OUT"));
            }
        }
    }
}

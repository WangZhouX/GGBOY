package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.indexer.LendingRiskBatch.Loan;
import io.ggboy.backend.indexer.LendingRiskBatch.Observation;
import io.ggboy.backend.indexer.LendingRiskBatch.Quote;
import io.ggboy.backend.indexer.VaultSnapshotProgramAddress.Address;
import io.ggboy.common.utils.SolanaAddressUtil;
import io.ggboy.common.utils.UnsignedIntegerUtil;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;

import static io.ggboy.backend.indexer.VaultSnapshotRpc.publicKeyAt;
import static io.ggboy.backend.indexer.VaultSnapshotRpc.unsignedLongAt;

/**
 * 通过同一最终确认 slot 的市场账本和所有市场 PDA 验证借贷风险输入。
 * Verifies lending risk inputs from market ledgers and all market PDAs at one finalized slot.
 */
@Component
class LendingRiskSnapshotRpc {

    /** 链上 Clock 系统变量账户和所属程序。 The Clock sysvar account and its owning program. */
    private static final String CLOCK = "SysvarC1ock11111111111111111111111111111111";
    private static final String SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
    /** 借款和当前部署抵押 Mint 的小数精度。 Decimal precision of the current debt and collateral mints. */
    static final int DEBT_DECIMALS = 6;
    static final int COLLATERAL_DECIMALS = 9;
    /** 在节点推进导致两个并行读跨槽时重新读取的次数。 Attempts when node advancement causes concurrent reads to span different slots. */
    private static final int SAME_SLOT_ATTEMPTS = 3;

    /** 最终确认 RPC 客户端，与借贷、金库活动索引共用。 Finalized RPC client shared with vault and lending activity. */
    private final VaultActivityRpc rpc;
    /** 在后续观测中复用已证实的最终确认交易证据。 Reuses conclusive finalized transaction evidence across observations. */
    private final LendingOraclePublication publications;

    /**
     * 复用已有的最终确认 RPC 客户端。
     * Reuses the established finalized RPC client.
     *
     * @param rpc 已配置的 Devnet 账户和历史读取客户端。 Configured Devnet account and history reader.
     */
    LendingRiskSnapshotRpc(VaultActivityRpc rpc) {
        this.rpc = rpc;
        this.publications = new LendingOraclePublication(rpc);
    }

    /**
     * 并行查询资产控制账户与市场明细，仅在响应同槽且账户布局完整时构造批次。
     * Reads control accounts and market detail concurrently and builds a batch only from complete layouts at one slot.
     *
     * @param registration Devnet 市场登记，包括链上程序和 Mint。 Devnet registry market, program and mint keys.
     * @param minSlot 已存最新市场观测，首次采集可为空。 Latest persisted market observation, or null on the first pass.
     * @return 同槽风险批次。 Coherent risk batch.
     */
    LendingRiskBatch observe(LendingMarketDO registration, BigInteger minSlot) {
        /** 校验 Mint 的固定账户列表及规范市场地址。 Canonical market and fixed addresses for mint checks. */
        Bindings bindings = Bindings.from(registration);
        List<String> fixedAddresses = List.of(registration.marketAddress(), bindings.cash(), bindings.collateral(),
                registration.debtMint(), registration.collateralMint(), CLOCK);
        BigInteger floor = minSlot;
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int attempt = 0; attempt < SAME_SLOT_ATTEMPTS; attempt++) {
                /** 每轮两请求使用相同的 slot 下限，但 RPC 的最终确认状态仍可能在两者之间推进。 Both requests use the same slot floor. The node can still advance between the reads. */
                BigInteger requestFloor = floor;
                CompletableFuture<JsonNode> details = CompletableFuture.supplyAsync(() ->
                        rpc.getLendingMarketAccounts(registration.programId(), registration.marketAddress(), requestFloor), executor);
                JsonNode fixed = rpc.getMultipleAccounts(fixedAddresses, requestFloor);
                JsonNode rows = details.join();
                BigInteger fixedSlot = slot(fixed);
                BigInteger detailSlot = slot(rows);
                if (requestFloor != null && fixedSlot.min(detailSlot).compareTo(requestFloor) < 0) {
                    throw invalid("slot older than the read floor");
                }
                if (fixedSlot.equals(detailSlot)) {
                    return capture(registration, bindings, fixedSlot, fixed.path("value"), rows.path("value"));
                }
                // 重试时从较新的上下文继续，绝不拼装来自不同 slot 的仓位。
                // Retry from the newer context without combining positions from different slots.
                floor = fixedSlot.max(detailSlot);
            }
        }
        throw invalid("RPC could not provide a same-slot observation");
    }

    /**
     * 校验固定账户、明细和价格提交证明后，为现有查询接口构造风险批次。
     * Validates fixed accounts, market detail and publication evidence before building the API's risk batch.
     *
     * @param market 已登记的市场与资产。 Registered market and assets.
     * @param bindings 依照程序种子派生的账户绑定。 Program-derived account bindings.
     * @param observationSlot 已核对相等的 RPC 响应槽。 Matching RPC response slot.
     * @param fixed 按请求顺序返回的市场、托管、Mint 和 Clock。 Market, custody, mints and Clock in request order.
     * @param rows 本次同槽的市场相关 Anchor 账户。 Same-slot Anchor market account rows.
     * @return 可原子发布的市场和钱包输入。 Market and wallet observations ready for atomic publication.
     */
    private LendingRiskBatch capture(LendingMarketDO market, Bindings bindings, BigInteger observationSlot,
                                     JsonNode fixed, JsonNode rows) {
        if (!fixed.isArray() || fixed.size() != 6 || !rows.isArray()) {
            throw invalid("unexpected account response");
        }
        /** 市场状态以字节布局和 PDA bump 核对程序管理者、两种 Mint 及托管地址。 Market bytes bind administrator, mints and custodies, with the PDA bump checked. */
        byte[] state = VaultSnapshotRpc.accountData(fixed.get(0), market.programId(), 169);
        if (!Layout.MARKET.matches(state)
                || (state[168] & 0xff) != bindings.marketBump()
                || !market.debtMint().equals(publicKeyAt(state, 40))
                || !market.collateralMint().equals(publicKeyAt(state, 72))
                || !bindings.cash().equals(publicKeyAt(state, 104))
                || !bindings.collateral().equals(publicKeyAt(state, 136))) {
            throw invalid("lending market PDA or mint binding");
        }
        /** 两种 SPL Mint 精度及其原版 Token Program 从链上账户验证。 Verify both mints' decimals and classic token program on chain. */
        VaultSnapshotRpc.requireMint(fixed.get(3), DEBT_DECIMALS);
        VaultSnapshotRpc.requireMint(fixed.get(4), COLLATERAL_DECIMALS);
        BigInteger cash = VaultSnapshotRpc.readTokenBalance(fixed.get(1), market.debtMint(), market.marketAddress());
        BigInteger collateral = VaultSnapshotRpc.readTokenBalance(fixed.get(2), market.collateralMint(), market.marketAddress());
        /** 同槽链上时钟同时用于快照观测时间和价格有效期。 Use the same-slot clock for both observation time and checking quote age. */
        ByteBuffer clock = littleEndian(VaultSnapshotRpc.accountData(fixed.get(5), SYSVAR_OWNER, 40));
        long clockSeconds = clock.getLong(32);
        if (!unsignedLongAt(clock, 0).equals(observationSlot) || clockSeconds <= 0) {
            throw invalid("clock slot or time");
        }

        /** 状态汇总要与实际出借、借款和抵押账户对得上。 Account totals must agree with supplier, borrower and locked collateral accounts. */
        Details details = readDetails(market, bindings, rows);
        Ledger ledger = details.reconcile(collateral, clockSeconds);
        Quote quote = readQuote(market, bindings, details.price(), publicKeyAt(state, 8), clockSeconds, observationSlot);
        return LendingRiskBatch.from(market, new Observation(observationSlot, utc(clockSeconds), cash,
                ledger.assetsRaw(), ledger.totalSharesRaw(), ledger.totalDebtRaw(), DEBT_DECIMALS,
                COLLATERAL_DECIMALS, bindings.oracle(), quote, ledger.borrows(), details.supplies(), ledger.interestEnabled()));
    }

    /**
     * 识别已知账户并核对所有者、规范地址和市场字段。
     * Recognizes known accounts and validates their owner, canonical address and market field.
     *
     * @param market 账户必须属于这个市场。 Market whose accounts are being sampled.
     * @param bindings 已派生的公共账本地址。 Derived public ledger addresses.
     * @param rows 带账户地址及原始数据的 RPC 响应。 RPC rows with account address and raw data.
     * @return 已验证的明细与总账字节。 Verified detail and aggregate ledger bytes.
     */
    private static Details readDetails(LendingMarketDO market, Bindings bindings, JsonNode rows) {
        /** 缺少未创建的总账可视为零。重复行或不支持的已知布局使整批无效。 Missing uninitialized ledgers default to zero. Duplicates or unsupported known layouts invalidate the batch. */
        ByteBuffer pool = null;
        BigInteger legacyTotalDebt = BigInteger.ZERO;
        ByteBuffer price = null;
        Map<String, ByteBuffer> borrows = new HashMap<>();
        Map<String, BigInteger> supplies = new HashMap<>();
        Set<String> seen = new HashSet<>();
        for (JsonNode row : rows) {
            /** 每条 JSON-RPC 行包含 Base58 地址和原始账户。 Each JSON-RPC row contains the base58 address and raw account. */
            String address = row.path("pubkey").textValue();
            SolanaAddressUtil.requirePublicKey(address, "lending account");
            if (!seen.add(address)) {
                throw invalid("duplicate market account");
            }
            JsonNode account = row.path("account");
            Layout layout = Layout.read(account);
            if (layout == null) {
                // 可忽略扩展中的无关 PDA。每个已知账本仍必须完整读取。
                // Ignore unrelated extension PDAs, while reading every known ledger.
                continue;
            }
            byte[] data = VaultSnapshotRpc.accountData(account, market.programId(), layout.size(account));
            if (!market.marketAddress().equals(publicKeyAt(data, 8))) {
                throw invalid("wrong market in program account");
            }
            ByteBuffer buffer = littleEndian(data);
            switch (layout) {
                case POOL -> {
                    requireAddress(address, bindings.pool());
                    pool = buffer;
                }
                case BORROW_MARKET -> {
                    requireAddress(address, bindings.borrowMarket());
                    legacyTotalDebt = unsignedLongAt(buffer, 40);
                }
                case PRICE -> {
                    requireAddress(address, bindings.oracle());
                    price = buffer;
                }
                case BORROW_POSITION -> {
                    /** 借款 PDA 绑定仓位所有者。 The loan PDA binds its borrower. */
                    String borrower = publicKeyAt(data, 40);
                    requireAddress(address, pda(market, "borrow_position", borrower));
                    borrows.put(borrower, buffer);
                }
                case SUPPLY_POSITION -> {
                    /** 普通钱包和金库 PDA 使用相同的出借份额派生规则。 Wallets and vault PDAs use the same supply-share derivation. */
                    String supplier = publicKeyAt(data, 40);
                    requireAddress(address, pda(market, "supply_position", supplier));
                    supplies.put(supplier, unsignedLongAt(buffer, 72));
                }
                case MARKET -> throw invalid("unexpected market account in market details");
            }
        }
        return new Details(pool, legacyTotalDebt, price, Map.copyOf(borrows), Map.copyOf(supplies));
    }

    /**
     * 解析有效的测试报价及原始写入 slot。缺价或证明不足时仍发布现金观测。
     * Resolves a usable mock price and its original write slot, allowing cash snapshots without price evidence.
     *
     * @param market 含预言机配置和资产绑定的市场登记。 Registered market and configured price feed.
     * @param bindings 规范的市场价格 PDA。 Canonical market oracle PDA.
     * @param price 已核对所有者和市场绑定的价格数据，未创建时为空。 Canonical bound oracle data or null.
     * @param administrator 市场管理员，必须签名发布旧版报价。 Market administrator required to sign a legacy publication.
     * @param now 同一 slot 的 Clock Unix 秒。 Same-slot Clock Unix seconds.
     * @param observationSlot 本次同槽观测的 slot。 Common observation slot.
     * @return 有效价格或空值。 Verified quote or null.
     */
    private Quote readQuote(LendingMarketDO market, Bindings bindings, ByteBuffer price, String administrator,
                            long now, BigInteger observationSlot) {
        if (price == null || !registrationAcceptsOracle(market, bindings.oracle())) {
            return null;
        }
        /** 预言机布局中的报价整数、发布时间及允许的有效期。 Oracle price integer, publication time and permitted lifetime. */
        BigInteger raw = unsignedLongAt(price, 40);
        long published = price.getLong(48);
        int maxAge = market.oracleMaxAgeSeconds() == null ? LendingRiskBatch.ORACLE_MAX_AGE_SECONDS
                : Math.min(market.oracleMaxAgeSeconds(), LendingRiskBatch.ORACLE_MAX_AGE_SECONDS);
        if (raw.signum() <= 0 || published <= 0 || published > now || now - published > maxAge) {
            return null;
        }
        /** 从最终确认的原始写入交易证明价格 PDA 内容的发布 slot。 Verify the price PDA's publication slot using the finalized original write transaction. */
        BigInteger publishedSlot = publications.resolve(market.programId(), administrator,
                market.marketAddress(), bindings.oracle(), raw, published, observationSlot);
        return publishedSlot == null || publishedSlot.signum() <= 0 || publishedSlot.compareTo(observationSlot) > 0
                ? null : new Quote(raw, utc(published), publishedSlot);
    }

    /**
     * 判断登记的预言机是否匹配规范 PDA，上线时允许填入尚未配置的市场。
     * Checks that a registered oracle matches the canonical PDA, allowing initial setup for unconfigured markets.
     *
     * @param market 已登记的借贷市场。 Registered lending market.
     * @param oracle 规范预言机 PDA。 Canonical oracle PDA.
     * @return 已匹配或未设置时为真。 True for matching or previously absent configuration.
     */
    static boolean registrationAcceptsOracle(LendingMarketDO market, String oracle) {
        return (market.oracleAddress() == null && market.oracleMaxAgeSeconds() == null)
                || (oracle.equals(market.oracleAddress()) && market.oracleMaxAgeSeconds() != null
                && market.oracleMaxAgeSeconds() > 0);
    }

    /** 读取 RPC 上下文的精确无符号 slot。 Reads the exact unsigned slot from an RPC context. */
    private static BigInteger slot(JsonNode result) {
        JsonNode value = result.path("context").path("slot");
        if (!value.isIntegralNumber()) {
            throw invalid("missing finalized context slot");
        }
        return UnsignedIntegerUtil.requireUint64(value.bigIntegerValue());
    }

    /** 按程序顺序拼接市场及可选的钱包 PDA 种子。 Derives a PDA using the registered market and optional wallet seeds in program order. */
    private static String pda(LendingMarketDO market, String seed, String... wallet) {
        String[] keys = new String[1 + wallet.length];
        keys[0] = market.marketAddress();
        System.arraycopy(wallet, 0, keys, 1, wallet.length);
        return VaultSnapshotProgramAddress.derive(market.programId(), seed, keys).publicKey();
    }

    /** 拒绝任何与规范种子不符的账户。 Rejects an account that does not match the canonical seeds. */
    private static void requireAddress(String actual, String expected) {
        if (!expected.equals(actual)) {
            throw invalid("noncanonical lending PDA");
        }
    }

    /** 以小端顺序读取 Solana 账户金额和时间。 Reads Solana wire amounts and times in little-endian order. */
    private static ByteBuffer littleEndian(byte[] data) {
        return ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
    }

    /** 将链上 Unix 秒规范化为 UTC。 Normalizes on-chain seconds to UTC. */
    private static OffsetDateTime utc(long epochSeconds) {
        return OffsetDateTime.ofInstant(Instant.ofEpochSecond(epochSeconds), ZoneOffset.UTC);
    }

    /** 构造不带响应正文或 URL 的校验错误。 Builds a validation message without response bodies or URLs. */
    private static IllegalStateException invalid(String detail) {
        return new IllegalStateException("Invalid lending risk observation: " + detail);
    }

    /**
     * 由登记中的程序 ID 与资产约束核对和派生的账户。
     * Accounts derived and validated from the registered program and asset bindings.
     *
     * @param marketBump 规范市场 bump。 Canonical market bump.
     * @param cash 资金池的现金托管。 Pool cash custody.
     * @param collateral 抵押资产托管。 Collateral custody.
     * @param pool 出借总账。 Supply pool ledger.
     * @param borrowMarket 全市场借款总账。 Market borrowing ledger.
     * @param oracle 测试预言机账户。 Mock oracle account.
     */
    private record Bindings(int marketBump, String cash, String collateral, String pool, String borrowMarket, String oracle) {
        /** 仅从 Devnet 规范单市场程序布局派生，拒绝未配置的其他模式。 Derives only from the canonical Devnet singleton market layout. */
        private static Bindings from(LendingMarketDO market) {
            Address canonical = VaultSnapshotProgramAddress.derive(market.programId(), "lending_market");
            if (!"devnet".equals(market.network()) || !canonical.publicKey().equals(market.marketAddress())
                    || market.debtMint().equals(market.collateralMint())) {
                throw invalid("registry market binding");
            }
            return new Bindings(canonical.bump(), pda(market, "cash_vault"), pda(market, "collateral_vault"),
                    pda(market, "supply_pool"), pda(market, "borrow_market"), pda(market, "mock_collateral_price"));
        }
    }

    /**
     * 市场明细账户中的金额、价格和仓位。
     * Amounts, quote data and positions from market detail accounts.
     *
     * @param pool 池总账缓冲区，尚未建池时为空。 Supply ledger buffer, null before pool initialization.
     * @param legacyTotalDebt 旧借款总账余额，借款 Mint 最小单位。 Legacy recorded total debt in debt mint base units.
     * @param price 已验证归属的预言机缓冲区，可为空。 Oracle buffer with owner validated, or null.
     * @param rawLoans 借款人公钥索引的原始借款账户。 Raw loan accounts keyed by borrower.
     * @param supplies 出借人公钥索引的出借份额最小单位。 Supply share base units keyed by supplier.
     */
    private record Details(ByteBuffer pool, BigInteger legacyTotalDebt, ByteBuffer price,
                           Map<String, ByteBuffer> rawLoans, Map<String, BigInteger> supplies) {

        /**
         * 同一时钟投影未偿金额，核对扫描的归一化债务、份额和抵押。
         * Projects outstanding debt at one clock and reconciles scanned normalized debt, shares and collateral.
         *
         * @param custodyCollateral 抵押托管余额，抵押 Mint 最小单位。 Custodied collateral in collateral mint base units.
         * @param now 链上 Clock Unix 秒。 On-chain Clock Unix seconds.
         * @return 可用于快照的完整账本。 Complete snapshot-ready ledgers.
         */
        private Ledger reconcile(BigInteger custodyCollateral, long now) {
            /** 旧池用本金对账。启用计息的池用归一化总额对账，避免逐仓位上取整的差额。 Reconcile principal for legacy pools and normalized balances for interest pools to avoid per-position rounding differences. */
            boolean active = pool != null && pool.capacity() == LendingInterestProjection.ACTIVE_POOL_BYTES;
            long start = active ? LendingInterestProjection.startTime(pool) : 0;
            BigInteger shares = pool == null ? BigInteger.ZERO : unsignedLongAt(pool, 48);
            BigInteger assets = pool == null ? BigInteger.ZERO
                    : active ? LendingInterestProjection.poolAssets(pool, now) : unsignedLongAt(pool, 40);
            BigInteger debt = active ? LendingInterestProjection.marketDebt(pool, now) : legacyTotalDebt;
            BigInteger expected = active ? LendingInterestProjection.normalizedTotal(pool) : debt;
            BigInteger observedShares = supplies.values().stream().reduce(BigInteger.ZERO, BigInteger::add);
            BigInteger observedDebt = BigInteger.ZERO;
            BigInteger observedCollateral = BigInteger.ZERO;
            Map<String, Loan> loans = new HashMap<>();
            if (active && (start <= 0 || start > now || assets.bitLength() > 64)) {
                throw invalid("interest pool clock or asset width");
            }

            for (var entry : rawLoans.entrySet()) {
                /** 借款账户的固定抵押字段不随计息改变。 The loan's collateral field is unchanged by interest. */
                ByteBuffer position = entry.getValue();
                boolean activePosition = position.capacity() == LendingInterestProjection.ACTIVE_POSITION_BYTES;
                BigInteger collateral = unsignedLongAt(position, 72);
                BigInteger principal = unsignedLongAt(position, 80);
                BigInteger amount = principal;
                if (activePosition) {
                    /** 统一计息起点，确保归一化金额处于同一标尺。 Match accrual anchors so normalized amounts have a common scale. */
                    if (!active || LendingInterestProjection.positionStartTime(position) != start) {
                        throw invalid("interest pool and position anchors differ");
                    }
                    observedDebt = observedDebt.add(LendingInterestProjection.normalizedPosition(position));
                    amount = LendingInterestProjection.positionDebt(position, now);
                } else {
                    // 计息市场仍可保留旧布局的零债务抵押仓，但未迁移的正数本金不可参与风控。
                    // An interest market may retain collateral-only legacy positions, but unconverted positive principal cannot enter risk evaluation.
                    if (active && principal.signum() != 0) {
                        throw invalid("legacy principal in interest market");
                    }
                    observedDebt = observedDebt.add(principal);
                }
                observedCollateral = observedCollateral.add(collateral);
                loans.put(entry.getKey(), new Loan(collateral, amount));
            }
            if (!shares.equals(observedShares) || !expected.equals(observedDebt)
                    || observedCollateral.compareTo(custodyCollateral) > 0
                    || assets.signum() > 0 && shares.signum() == 0) {
                throw invalid("the market detail totals do not reconcile");
            }
            return new Ledger(assets, shares, debt, Map.copyOf(loans), active);
        }
    }

    /**
     * 已用同一 Clock 验证的资金池账本。
     * Lending pool ledgers reconciled at one Clock value.
     *
     * @param assetsRaw 池账面资产，单位为借款 Mint 最小单位。 Pool assets in debt mint base units.
     * @param totalSharesRaw 池全部出借份额最小单位。 Total pool supply share base units.
     * @param totalDebtRaw 池未偿金额，单位为借款 Mint 最小单位。 Outstanding debt in debt mint base units.
     * @param borrows 借款人按公钥分组的债务和抵押。 Borrower collateral and debt keyed by public key.
     * @param interestEnabled 是否以链上归一化账本计息。 Whether the chain uses its normalized interest ledger.
     */
    private record Ledger(BigInteger assetsRaw, BigInteger totalSharesRaw, BigInteger totalDebtRaw,
                          Map<String, Loan> borrows, boolean interestEnabled) {
    }

    /**
     * Anchor 判别字节及各账户精确线布局长度。
     * Anchor discriminators and exact wire lengths of known accounts.
     */
    private enum Layout {
        MARKET("f6723262489d1c78", 169, 169),
        POOL("ee5be59835d5a599", LendingInterestProjection.LEGACY_POOL_BYTES, LendingInterestProjection.ACTIVE_POOL_BYTES),
        SUPPLY_POSITION("f8ddfade25a740d1", 80, 80),
        BORROW_MARKET("948512f2f8429c63", 48, 48),
        BORROW_POSITION("f38c148b20f37237", LendingInterestProjection.LEGACY_POSITION_BYTES, LendingInterestProjection.ACTIVE_POSITION_BYTES),
        PRICE("153ff545db01090e", 56, 56);

        /** 判别字节与旧版、新版允许的精确长度。 Discriminator bytes and exact legacy and active lengths. */
        private final byte[] discriminator;
        private final int legacyBytes;
        private final int activeBytes;

        /** 解析新旧两套账户布局。 Initializes both supported wire lengths. */
        Layout(String discriminatorHex, int legacyBytes, int activeBytes) {
            this.discriminator = HexFormat.of().parseHex(discriminatorHex);
            this.legacyBytes = legacyBytes;
            this.activeBytes = activeBytes;
        }

        /** 核对账户所需的前八字节。 Checks the account's eight-byte prefix. */
        private boolean matches(byte[] data) {
            return data.length >= 8 && Arrays.equals(data, 0, 8, discriminator, 0, 8);
        }

        /** 读取前十二个 Base64 字符识别 Anchor 判别符，再完整核对布局。 Identifies the Anchor discriminator in twelve base64 characters before full validation. */
        private static Layout read(JsonNode account) {
            String data = account.path("data").path(0).textValue();
            if (data == null || data.length() < 12) {
                throw invalid("missing Anchor discriminator");
            }
            byte[] prefix = Base64.getDecoder().decode(data.substring(0, 12));
            return Arrays.stream(values()).filter(layout -> layout.matches(prefix)).findFirst().orElse(null);
        }

        /** 从 Base64 长度选择候选布局，解码时再验证准确字节长度。 Selects a candidate layout by base64 length. Decoding verifies the exact byte length. */
        private int size(JsonNode account) {
            String encoded = account.path("data").path(0).textValue();
            return encoded.length() == 4 * ((activeBytes + 2) / 3) ? activeBytes : legacyBytes;
        }
    }
}

package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.VaultDO;
import tools.jackson.databind.JsonNode;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;

import static io.ggboy.backend.indexer.VaultSnapshotRpc.accountData;
import static io.ggboy.backend.indexer.VaultSnapshotRpc.invalidAccount;
import static io.ggboy.backend.indexer.VaultSnapshotRpc.publicKeyAt;
import static io.ggboy.backend.indexer.VaultSnapshotRpc.readTokenBalance;
import static io.ggboy.backend.indexer.VaultSnapshotRpc.requireMint;
import static io.ggboy.backend.indexer.VaultSnapshotRpc.unsignedLongAt;

/**
 * 派生并验证已启用策略的金库估值账户。所有余额从调用方提供的同槽批次读取。
 * Derives and validates valuation accounts for a strategy-enabled vault. All balances come from the caller's same-slot batch.
 */
final class VaultStrategySnapshot {

    /** 金库策略程序允许调用的借贷程序。 Lending program accepted by the vault strategy program. */
    private static final String LENDING_PROGRAM = "8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H";
    /** 未初始化 PDA 的系统程序，以及 Clock 的规范账户和所有者。 System program for uninitialized PDAs and canonical Clock address and owner. */
    private static final String SYSTEM_PROGRAM = "11111111111111111111111111111111";
    private static final String CLOCK_ACCOUNT = "SysvarC1ock11111111111111111111111111111111";
    private static final String SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
    /** tSOL 小数位数、每枚 tSOL 的最小单位数和预言机最大有效时间（秒）。 tSOL decimals, base units per whole tSOL, and maximum oracle age in seconds. */
    static final int SPOT_DECIMALS = 9;
    private static final BigInteger SPOT_SCALE = BigInteger.TEN.pow(SPOT_DECIMALS);
    private static final long MAX_PRICE_AGE_SECONDS = 604_800L;

    /** 链上账户类型的判别字节和序列化长度。 Discriminators and serialized lengths of on-chain account types. */
    private static final Layout STRATEGY = new Layout("7409492549c03fd7", 143);
    private static final Layout MARKET = new Layout("f6723262489d1c78", 169);
    private static final Layout ORACLE = new Layout("153ff545db01090e", 56);
    /** 启用计息后借贷池增加 32 字节的跟踪现金及债务份额。 Interest activation appends 32 bytes for tracked cash and debt shares. */
    private static final Layout SUPPLY_POOL = new Layout("ee5be59835d5a599",
            LendingInterestProjection.LEGACY_POOL_BYTES, LendingInterestProjection.ACTIVE_POOL_BYTES);
    private static final Layout SUPPLY_POSITION = new Layout("f8ddfade25a740d1", 80);
    private static final Layout BORROW_MARKET = new Layout("948512f2f8429c63", 48);
    /** Borsh 公钥、数量和 bump 字段的共享偏移，单位为字节。 Shared Borsh offsets in bytes for keys, quantities and bumps. */
    private static final int CONFIG_VAULT = 8;
    private static final int CONFIG_MINT = 72;
    private static final int CONFIG_MARKET = 104;
    private static final int CONFIG_BUMP = 142;
    private static final int MARKET_DEBT_MINT = 40;
    private static final int MARKET_COLLATERAL_MINT = 72;
    private static final int MARKET_CASH = 104;
    private static final int MARKET_BUMP = 168;
    private static final int RECORD_MARKET = 8;
    private static final int ORACLE_PRICE = 40;
    private static final int ORACLE_TIME = 48;
    private static final int POOL_ASSETS = 40;
    private static final int POOL_SHARES = 48;
    private static final int POSITION_SUPPLIER = 40;
    private static final int POSITION_SHARES = 72;
    private static final int MARKET_DEBT = 40;
    /** Clock 账户长度及 Unix 时间戳的偏移，单位为字节。 Clock account length and offset of its Unix timestamp, in bytes. */
    private static final int CLOCK_BYTES = 40;
    private static final int CLOCK_UNIX_TIME = 32;

    /** 估值账户与本轮已登记的金库及资产市场对应。 The valuation accounts belong to this registered vault, asset and market. */
    private final VaultDO vault;
    private final VaultSnapshotProgramAddress.Address strategy;
    private final VaultSnapshotProgramAddress.Address market;
    private final String lendingCash;
    /** 有固定顺序的地址列表，与最终 RPC 返回数组的位置一一对应。 Ordered addresses corresponding positionally to the final RPC account array. */
    private final List<String> addresses;

    /**
     * 从登记的链上标识派生估值账户，拒绝未登记或未知市场。
     * Derives valuation accounts from registered on-chain identifiers, rejecting missing or unsupported markets.
     *
     * @param vault 链上已经启用策略的金库登记。 Registry entry for a vault with strategy already active on-chain.
     */
    VaultStrategySnapshot(VaultDO vault) {
        this.vault = vault;
        this.strategy = VaultSnapshotProgramAddress.derive(vault.programId(), "strategy", vault.vaultAddress());
        this.market = VaultSnapshotProgramAddress.derive(LENDING_PROGRAM, "lending_market");
        if (vault.strategyMint() == null || vault.strategyMint().equals(vault.quoteMint())
                || vault.strategyMint().equals(vault.shareMint())
                || !market.publicKey().equals(vault.lendingMarketAddress())) {
            throw invalidAccount("strategy mint or lending market registration");
        }
        this.lendingCash = lendingAddress("cash_vault", market.publicKey());
        this.addresses = List.of(
                strategy.publicKey(),
                vault.strategyMint(),
                VaultSnapshotProgramAddress.derive(vault.programId(), "strategy_custody", strategy.publicKey()).publicKey(),
                market.publicKey(),
                lendingAddress("mock_collateral_price", market.publicKey()),
                lendingAddress("supply_pool", market.publicKey()),
                lendingAddress("supply_position", market.publicKey(), vault.vaultAddress()),
                lendingCash,
                lendingAddress("borrow_market", market.publicKey()),
                CLOCK_ACCOUNT);
    }

    /**
     * 返回策略估值所需的规范账户地址，顺序与读取方法一致。
     * Returns canonical strategy valuation addresses in the reader's order.
     *
     * @return 同槽读取所需的策略和借贷账户。 Strategy and lending accounts to fetch in the same observation.
     */
    List<String> addresses() {
        return addresses;
    }

    /**
     * 验证同槽策略和借贷数据并计算金库的持仓价值与可收回资金。
     * Validates same-slot strategy and lending data and calculates the vault's holdings and recallable cash.
     *
     * @param values 完整的 JSON-RPC 账户批次。 Complete JSON-RPC account batch.
     * @param start 策略账户在批次中的起始索引。 Initial index of strategy accounts in the batch.
     * @return 已核对的持仓估值和手工收回上限。 Verified holdings valuation and manager recall cap.
     */
    Valuation value(JsonNode values, int start) {
        verifyBindings(values.get(start), values.get(start + 3));
        requireMint(values.get(start + 1), SPOT_DECIMALS);
        /** 金库的策略账户与供给市场现金，分别按各自 Mint 最小单位读取。 Vault strategy custody and lending cash, each read in its own mint's base units. */
        BigInteger spot = readTokenBalance(values.get(start + 2), vault.strategyMint(), vault.vaultAddress());
        BigInteger poolCash = readTokenBalance(values.get(start + 7), vault.quoteMint(), market.publicKey());
        /** 同槽 Clock 为策略价格时效和借贷池计息提供同一 Unix 秒。 The same-slot Clock supplies Unix seconds for spot pricing and lending interest. */
        long now = ByteBuffer.wrap(accountData(values.get(start + 9), SYSVAR_OWNER, CLOCK_BYTES))
                .order(ByteOrder.LITTLE_ENDIAN).getLong(CLOCK_UNIX_TIME);
        /** 价格缺失不阻断借贷资金的独立收回。 A missing price does not prevent an independent recall from lending. */
        BigInteger spotValue = spot.signum() == 0 ? BigInteger.ZERO : spotValue(spot, values.get(start + 4), now);
        return readLending(spot, spotValue, poolCash, values.get(start + 5),
                values.get(start + 6), values.get(start + 8), now);
    }

    /**
     * 校验已归属规范程序的配置和市场是否绑定本次估值的账户。
     * Verifies that program-owned configuration and market accounts bind this valuation's accounts.
     *
     * @param configAccount 金库策略配置。 Vault strategy configuration account.
     * @param marketAccount 借贷市场状态。 Lending market state account.
     */
    private void verifyBindings(JsonNode configAccount, JsonNode marketAccount) {
        /** 已通过归属和 Anchor 类型校验的两份绑定账户。 Both binding accounts with verified owner and Anchor type. */
        ByteBuffer config = STRATEGY.read(configAccount, vault.programId());
        ByteBuffer lendingMarket = MARKET.read(marketAccount, LENDING_PROGRAM);
        if (!vault.vaultAddress().equals(publicKeyAt(config.array(), CONFIG_VAULT))
                || !vault.strategyMint().equals(publicKeyAt(config.array(), CONFIG_MINT))
                || !market.publicKey().equals(publicKeyAt(config.array(), CONFIG_MARKET))
                || Byte.toUnsignedInt(config.get(CONFIG_BUMP)) != strategy.bump()
                || !vault.quoteMint().equals(publicKeyAt(lendingMarket.array(), MARKET_DEBT_MINT))
                || !vault.strategyMint().equals(publicKeyAt(lendingMarket.array(), MARKET_COLLATERAL_MINT))
                || !lendingCash.equals(publicKeyAt(lendingMarket.array(), MARKET_CASH))
                || Byte.toUnsignedInt(lendingMarket.get(MARKET_BUMP)) != market.bump()) {
            throw invalidAccount("strategy or lending market binding");
        }
    }

    /**
     * 按链上 Clock 判断价格时效，并按计价资产最小单位向下取整。
     * Checks oracle age against the on-chain Clock and floors the result in quote mint base units.
     *
     * @param spot 以 tSOL 最小单位计的持仓量。 Holding in tSOL base units.
     * @param oracleAccount 规范的价格账户，可以尚未创建。 Canonical price account, which may not exist yet.
     * @param now 同一观测 slot 的链上 Unix 秒。 On-chain Unix seconds from the same observation slot.
     * @return 持仓价值，无有效价格时为空。 Position value, or null without a usable price.
     */
    private BigInteger spotValue(BigInteger spot, JsonNode oracleAccount, long now) {
        /** 已核对的市场预言机记录，可以尚未建立。 Verified market oracle record, which may be uninitialized. */
        ByteBuffer oracle = lendingRecord(oracleAccount, ORACLE);
        if (oracle == null) {
            return null;
        }
        long published = oracle.getLong(ORACLE_TIME);
        BigInteger price = unsignedLongAt(oracle, ORACLE_PRICE);
        if (price.signum() == 0 || published <= 0 || published > now || now - published > MAX_PRICE_AGE_SECONDS) {
            return null;
        }
        return spot.multiply(price).divide(SPOT_SCALE);
    }

    /**
     * 用总份额、已记账资产和实际可提现金计算金库的出借价值与收回额度。
     * Uses total supply shares, accounted assets and available cash to value the vault position and its recall cap.
     *
     * @param spot 金库策略代币余额，单位为 tSOL 最小单位。 Vault strategy token balance in tSOL base units.
     * @param spotValue 计价 Mint 最小单位的策略估值，缺价时为空。 Strategy value in quote mint base units, or null without a usable price.
     * @param poolCash 市场托管金额，单位为计价 Mint 最小单位。 Market cash custody balance in quote mint base units.
     * @param poolAccount 市场出借账本，可以尚未建立。 Market supply ledger, which may not exist yet.
     * @param positionAccount 金库出借仓位，可以尚未建立。 Vault supply position, which may not exist yet.
     * @param debtAccount 市场借款总账，可以尚未建立。 Market debt ledger, which may not exist yet.
     * @param now 同槽 Clock 提供的 Unix 秒。 Unix seconds supplied by the same-slot Clock.
     * @return 采用链上舍入与流动性限制计算的估值。 Valuation using on-chain rounding and liquidity limits.
     */
    private Valuation readLending(BigInteger spot, BigInteger spotValue, BigInteger poolCash,
                                  JsonNode poolAccount, JsonNode positionAccount, JsonNode debtAccount, long now) {
        /** 已核对的池账本、金库出借仓位和借款总账，未创建时为空。 Verified pool ledger, vault position and debt ledger, or null if uninitialized. */
        ByteBuffer pool = lendingRecord(poolAccount, SUPPLY_POOL);
        ByteBuffer position = lendingRecord(positionAccount, SUPPLY_POSITION);
        ByteBuffer debtLedger = lendingRecord(debtAccount, BORROW_MARKET);
        if (position != null && (pool == null
                || !vault.vaultAddress().equals(publicKeyAt(position.array(), POSITION_SUPPLIER)))) {
            throw invalidAccount("vault lending position or pool binding");
        }
        /** 金库份额及总份额使用份额最小单位，资产和债务使用计价 Mint 最小单位。 Position and total shares use share base units, while assets and debt use quote mint base units. */
        BigInteger shares = position == null ? BigInteger.ZERO : unsignedLongAt(position, POSITION_SHARES);
        BigInteger totalShares = pool == null ? BigInteger.ZERO : unsignedLongAt(pool, POOL_SHARES);
        /** 已计息的资产由追踪现金和本槽债务份额计算，旧账本前缀继续使用旧口径。 Active interest values tracked cash plus same-slot debt shares, while legacy prefixes retain their existing rule. */
        boolean interestEnabled = pool != null && pool.capacity() == LendingInterestProjection.ACTIVE_POOL_BYTES;
        BigInteger accountedAssets = interestEnabled ? LendingInterestProjection.poolAssets(pool, now)
                : pool == null ? BigInteger.ZERO : unsignedLongAt(pool, POOL_ASSETS);
        BigInteger availableCash = interestEnabled ? LendingInterestProjection.trackedCash(pool)
                : accountedAssets.subtract(debtLedger == null ? BigInteger.ZERO : unsignedLongAt(debtLedger, MARKET_DEBT));
        if (accountedAssets.bitLength() > Long.SIZE || shares.compareTo(totalShares) > 0
                || (totalShares.signum() == 0 && accountedAssets.signum() > 0)
                || availableCash.signum() < 0 || availableCash.compareTo(poolCash) > 0) {
            throw invalidAccount("lending valuation accounting");
        }

        // 全额核销可能留下零价值份额。仍单独记录仓位是否存在，避免误当作无仓位。
        // A complete write-off can leave worthless shares. Keep the position flag even when its value is zero.
        boolean lendingPositionOpen = shares.signum() > 0;
        if (!lendingPositionOpen || accountedAssets.signum() == 0) {
            return new Valuation(spot, spotValue, BigInteger.ZERO, BigInteger.ZERO, lendingPositionOpen);
        }
        /** 当前份额估值包含未偿债务，收回上限仅使用已记账且实际可支出的现金。 Share value includes outstanding debt, while recall uses only spendable tracked cash. */
        BigInteger lendingValue = shares.multiply(accountedAssets).divide(totalShares);
        BigInteger maxRecallShares = availableCash.add(BigInteger.ONE).multiply(totalShares).subtract(BigInteger.ONE)
                .divide(accountedAssets).min(shares);
        BigInteger maxRecall = maxRecallShares.multiply(accountedAssets).divide(totalShares);
        return new Valuation(spot, spotValue, lendingValue, maxRecall, true);
    }

    /**
     * 解码指定市场的可选 Anchor 借贷记录。
     * Decodes an optional Anchor lending record for the configured market.
     *
     * @param account 链上账户数据。 On-chain account data.
     * @param layout 指定记录类型的 Anchor 布局。 Anchor layout of the record type.
     * @return 已验证的借贷记录，未初始化时为空。 Validated lending record, or null if uninitialized.
     */
    private ByteBuffer lendingRecord(JsonNode account, Layout layout) {
        if (account.isNull()) {
            return null;
        }
        if (SYSTEM_PROGRAM.equals(account.path("owner").textValue())) {
            accountData(account, SYSTEM_PROGRAM, 0);
            return null;
        }
        /** 规范程序拥有的账户必须同时包含预期的记录类型及市场地址。 Program-owned accounts must contain the expected record type and market address. */
        ByteBuffer data = layout.read(account, LENDING_PROGRAM);
        if (!market.publicKey().equals(publicKeyAt(data.array(), RECORD_MARKET))) {
            throw invalidAccount("lending record market");
        }
        return data;
    }

    /**
     * 派生规范的借贷程序 PDA 地址。
     * Derives the canonical lending program PDA address.
     *
     * @param seed 固定种子前缀。 Fixed seed prefix.
     * @param keys 依账户约束顺序使用的公钥种子。 Public key seeds in account-constraint order.
     * @return 规范的 Base58 PDA 地址。 Canonical Base58 PDA address.
     */
    private static String lendingAddress(String seed, String... keys) {
        return VaultSnapshotProgramAddress.derive(LENDING_PROGRAM, seed, keys).publicKey();
    }

    /**
     * 支持固定版本的 Anchor 账户布局。 Anchor account layout with exact supported versions.
     *
     * @param discriminatorHex Anchor 账户判别字节的十六进制记录。 Hex encoding of the Anchor account discriminator.
     * @param length 账户的原有序列化字节数。 Legacy serialized account byte count.
     * @param extendedLength 明确支持的扩展布局字节数，相同表示没有扩展。 Supported extended account byte count, identical when unextended.
     */
    private record Layout(String discriminatorHex, int length, int extendedLength) {

        /** 建立仅支持一个字节长度的账户布局。 Creates an account layout supporting a single exact byte length. */
        Layout(String discriminatorHex, int length) {
            this(discriminatorHex, length, length);
        }

        /**
         * 核验归属、布局长度、判别字节并返回小端读取缓冲区。
         * Validates owner, layout size and discriminator, then returns a little-endian reader.
         *
         * @param account RPC 账户对象。 RPC account object.
         * @param owner 拥有账户的程序地址。 Owning program address.
         * @return 小端读取缓冲区。 Little-endian read buffer.
         */
        ByteBuffer read(JsonNode account, String owner) {
            /** 已校验长度的字节和本类型判别字节。 Length-checked account bytes and expected discriminator. */
            byte[] bytes = accountData(account, owner, length, extendedLength);
            byte[] discriminator = HexFormat.of().parseHex(discriminatorHex);
            if ((bytes.length != length && bytes.length != extendedLength)
                    || !Arrays.equals(bytes, 0, discriminator.length, discriminator, 0, discriminator.length)) {
                throw invalidAccount("strategy or lending account discriminator");
            }
            return ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        }
    }

    /**
     * 金库策略与出借头寸的同槽估值。
     * Same-slot valuation of vault strategy and lending positions.
     *
     * @param spotAmount 策略代币数量，按其 Mint 最小单位计。 Strategy token quantity in its mint base units.
     * @param spotValue 策略代币的价值，单位为计价 Mint 最小单位，缺价时为空。 Strategy token value in quote mint base units, or null without usable pricing.
     * @param lendingValue 金库出借份额账面价值，单位为计价 Mint 最小单位。 Book value of vault supply shares in quote mint base units.
     * @param recallable 此刻可收回的出借资金，单位为计价 Mint 最小单位。 Currently recallable lending liquidity in quote mint base units.
     * @param lendingPositionOpen 金库是否还有非零出借份额。 Whether the vault has nonzero lending shares.
     */
    record Valuation(BigInteger spotAmount, BigInteger spotValue, BigInteger lendingValue, BigInteger recallable,
                     boolean lendingPositionOpen) {
    }
}

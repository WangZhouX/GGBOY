package io.ggboy.backend.indexer;

import io.ggboy.backend.entity.VaultDO;
import io.ggboy.common.utils.SolanaAddressUtil;
import io.ggboy.common.utils.UnsignedIntegerUtil;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Stream;

/**
 * 从同一个最终确认的 Devnet slot 读取已登记金库的估值数据。
 * Reads registered vault valuation inputs from one finalized Devnet slot.
 */
@Component
class VaultSnapshotRpc {

    /** 经典 SPL Token 程序的规范公钥。 Canonical public key of the classic SPL Token program. */
    static final String TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    /** 金库初始化指令规定的结算资产和份额精度，单位为小数位数。 Settlement and share precision in decimal places required by vault initialization. */
    static final int TOKEN_DECIMALS = 6;
    /** 链上二进制布局中的公钥字节数。 Public key length in the on-chain binary layouts. */
    private static final int PUBLIC_KEY_BYTES = 32;

    /** Anchor Vault 账户的 IDL 判别字节，后面依次为管理员和三项账户绑定。 Anchor Vault IDL discriminator followed by its administrator and three account bindings. */
    private static final byte[] VAULT_DISCRIMINATOR = HexFormat.of().parseHex("d308e82b02987577");
    /** Anchor 状态的长度、结算 Mint、现金托管和份额 Mint 的起始字节偏移。 Anchor state size and byte offsets of settlement mint, cash custody, and share mint. */
    private static final int VAULT_BYTES = 137;
    /** 原有 Vault 布局追加一个字节即已启用策略。 The legacy Vault layout has one trailing byte after strategy activation. */
    private static final int ACTIVE_VAULT_BYTES = 138;
    /** 策略版本字节中启用自动收回的最低位。 Low bit enabling automatic recall in the strategy version byte. */
    private static final int AUTO_RECALL_FLAG = 1;
    private static final int VAULT_QUOTE_MINT_OFFSET = 40;
    private static final int VAULT_CASH_OFFSET = 72;
    private static final int VAULT_SHARE_MINT_OFFSET = 104;

    /** 经典 SPL Token 账户长度，以及各字段的起始字节偏移。 Classic SPL token account size and field offsets in bytes. */
    private static final int CASH_BYTES = 165;
    private static final int CASH_MINT_OFFSET = 0;
    private static final int CASH_AUTHORITY_OFFSET = 32;
    private static final int CASH_AMOUNT_OFFSET = 64;
    private static final int CASH_STATE_OFFSET = 108;
    private static final int CASH_NATIVE_OPTION_OFFSET = 109;
    /** 经典 SPL Token 账户状态 1 代表已初始化且未冻结。 Classic SPL token account state 1 means initialized and unfrozen. */
    private static final int ACTIVE_CASH_STATE = 1;

    /** 经典 SPL Mint 长度，以及各字段的起始字节偏移。 Classic SPL mint size and field offsets in bytes. */
    private static final int MINT_BYTES = 82;
    private static final int MINT_AUTHORITY_OPTION_OFFSET = 0;
    private static final int MINT_AUTHORITY_OFFSET = 4;
    private static final int MINT_SUPPLY_OFFSET = 36;
    private static final int MINT_DECIMALS_OFFSET = 44;
    private static final int MINT_INITIALIZED_OFFSET = 45;
    private static final int MINT_FREEZE_OPTION_OFFSET = 46;

    /** 与交易索引共用的 Devnet 只读 JSON-RPC 客户端。 Read-only Devnet JSON-RPC client shared with transaction indexing. */
    private final VaultActivityRpc rpc;

    /**
     * 创建复用现有 Devnet RPC 连接的金库采样器。
     * Creates a vault reader sharing the existing Devnet RPC connection.
     *
     * @param rpc 只读 Devnet RPC 客户端。 Read-only Devnet RPC client.
     */
    VaultSnapshotRpc(VaultActivityRpc rpc) {
        this.rpc = rpc;
    }

    /**
     * 从金库状态发现现金账户和策略模式，再在单次观测中重新验证并读取估值输入。
     * Discovers custody and strategy mode from vault state, then revalidates and reads valuation inputs in one observation.
     *
     * @param vault Devnet 金库的数据库登记信息。 Registry entry for the Devnet vault.
     * @return 同一个最终确认 slot 的现金、份额和持仓估值。 Cash, shares, and position valuation from the same finalized slot.
     * @throws IllegalArgumentException 金库登记不是 Devnet。 The registry entry is not on Devnet.
     * @throws IllegalStateException RPC 数据缺失、回退或账户绑定校验失败。 RPC data is missing, regressed, or inconsistent with the account bindings.
     */
    Observation observe(VaultDO vault) {
        if (!"devnet".equals(vault.network())) {
            throw new IllegalArgumentException("Vault snapshot reader requires a Devnet vault");
        }
        SolanaAddressUtil.requirePublicKey(vault.programId(), "vault program");
        if (vault.quoteMint().equals(vault.shareMint())) {
            throw new IllegalArgumentException("Vault snapshot requires distinct settlement and share mints");
        }

        /** 首次读取决定最终批次所需的现金地址与策略估值账户。 Discovery identifies the custody and strategy accounts needed for the final valuation batch. */
        JsonNode discovery = rpc.getMultipleAccounts(List.of(vault.vaultAddress()), null);
        BigInteger discoverySlot = contextSlot(discovery);
        VaultBinding binding = readVaultBinding(accountValues(discovery, 1).get(0), vault);
        VaultStrategySnapshot strategy = binding.strategyActive() ? new VaultStrategySnapshot(vault) : null;

        /** 纯现金模式沿用原四个账户。启用策略时同批追加策略、借贷和 Clock 输入。 Cash mode keeps the original four accounts. Strategy mode adds strategy, lending, and Clock inputs to the same batch. */
        List<String> baseAddresses = List.of(vault.vaultAddress(), binding.custody(), vault.quoteMint(), vault.shareMint());
        List<String> addresses = strategy == null ? baseAddresses
                : Stream.concat(baseAddresses.stream(), strategy.addresses().stream()).toList();
        JsonNode result = rpc.getMultipleAccounts(addresses, discoverySlot);
        BigInteger slot = contextSlot(result);
        JsonNode values = accountValues(result, addresses.size());

        // 估值和自动收回状态都取最终批次。若金库模式或托管绑定变化，下一轮重新发现。
        // Use final-batch valuation and auto-recall state. Rediscover on the next pass if the vault mode or custody changes.
        if (slot.compareTo(discoverySlot) < 0 || !binding.equals(readVaultBinding(values.get(0), vault))) {
            throw invalidAccount("observation context or custody binding");
        }

        /** 通过账户归属和 Mint 绑定校验后的实际现金余额。 Actual custody balance verified against account owner and mint binding. */
        BigInteger cash = readTokenBalance(values.get(1), vault.quoteMint(), vault.vaultAddress());
        requireMint(values.get(2), TOKEN_DECIMALS);
        /** 通过代币程序、精度和金库铸造权限验证后的份额 Mint。 Share mint validated against token program, precision and vault mint authority. */
        ByteBuffer shares = requireMint(values.get(3), TOKEN_DECIMALS);
        if (shares.getInt(MINT_AUTHORITY_OPTION_OFFSET) != 1
                || !vault.vaultAddress().equals(publicKeyAt(shares.array(), MINT_AUTHORITY_OFFSET))
                || shares.getInt(MINT_FREEZE_OPTION_OFFSET) != 0) {
            throw invalidAccount("share mint authority");
        }
        /** 同一 slot 的 GG-V 供给量。 GG-V supply at the same slot. */
        BigInteger totalShares = unsignedLongAt(shares, MINT_SUPPLY_OFFSET);
        if (strategy == null) {
            return new Observation(slot, cash, totalShares);
        }
        /** 在原有四个账户之后读取策略专属估值。 Decode strategy valuation after the four original accounts. */
        VaultStrategySnapshot.Valuation valuation = strategy.value(values, baseAddresses.size());
        return new Observation(slot, cash, totalShares, valuation.spotAmount(), valuation.spotValue(),
                valuation.lendingValue(), valuation.recallable(), binding.autoRecallEnabled(), valuation.lendingPositionOpen());
    }

    /**
     * 验证金库账户归属、Anchor 布局和数据库登记的两种 Mint，读取现金绑定、策略和自动收回状态。
     * Verifies ownership, Anchor layout and registered mints, then reads custody, strategy activation and auto recall.
     *
     * @param account RPC 返回的金库状态账户。 Vault state account returned by RPC.
     * @param vault 用于核对公钥绑定的数据库登记。 Registry entry supplying the expected key bindings.
     * @return 托管公钥、策略与自动收回状态。 Bound custody address, strategy activation and auto-recall state.
     */
    private VaultBinding readVaultBinding(JsonNode account, VaultDO vault) {
        /** 已通过长度和程序归属校验的 Vault 账户字节。 Vault bytes with the account size and owning program validated. */
        byte[] data = accountData(account, vault.programId(), VAULT_BYTES, ACTIVE_VAULT_BYTES);
        if (!Arrays.equals(data, 0, VAULT_DISCRIMINATOR.length, VAULT_DISCRIMINATOR, 0, VAULT_DISCRIMINATOR.length)
                || !vault.quoteMint().equals(publicKeyAt(data, VAULT_QUOTE_MINT_OFFSET))
                || !vault.shareMint().equals(publicKeyAt(data, VAULT_SHARE_MINT_OFFSET))) {
            throw invalidAccount("vault discriminator or mint bindings");
        }
        /** 旧布局没有版本字节，旧策略的零版本字节也继续按现金赎回。 Legacy layout has no flag and zero-version strategies still redeem from cash only. */
        boolean strategyActive = data.length == ACTIVE_VAULT_BYTES;
        boolean autoRecallEnabled = strategyActive && (data[VAULT_BYTES] & AUTO_RECALL_FLAG) != 0;
        return new VaultBinding(publicKeyAt(data, VAULT_CASH_OFFSET), strategyActive, autoRecallEnabled);
    }

    /**
     * 检查托管账户由对应 PDA 控制、持有所绑定的 Mint，并解码金额。
     * Verifies that custody is controlled by its PDA and holds the bound mint, then decodes its balance.
     *
     * @param account RPC 返回的托管 SPL Token 账户。 Custody SPL Token account returned by RPC.
     * @param mint 账户绑定的代币 Mint。 Token mint bound to the account.
     * @param authority 控制账户的金库或借贷市场 PDA。 Vault or lending market PDA controlling the account.
     * @return 代币最小单位余额，按无符号 u64 解析。 Token balance as an unsigned u64 in base units.
     */
    static BigInteger readTokenBalance(JsonNode account, String mint, String authority) {
        /** SPL 账户的固定布局及用于读取 u32 与 u64 字段的小端缓冲区。 Fixed SPL account layout with a little-endian buffer for u32 and u64 fields. */
        byte[] data = accountData(account, TOKEN_PROGRAM_ID, CASH_BYTES);
        ByteBuffer cash = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        if (!mint.equals(publicKeyAt(data, CASH_MINT_OFFSET))
                || !authority.equals(publicKeyAt(data, CASH_AUTHORITY_OFFSET))
                || cash.get(CASH_STATE_OFFSET) != ACTIVE_CASH_STATE || cash.getInt(CASH_NATIVE_OPTION_OFFSET) != 0) {
            throw invalidAccount("custody mint, authority or state");
        }
        return unsignedLongAt(cash, CASH_AMOUNT_OFFSET);
    }

    /**
     * 确认 Mint 是具有预期小数位且已初始化的经典 SPL Mint。
     * Confirms the mint is initialized with expected decimals and uses the classic SPL program.
     *
     * @param account RPC 返回的 Mint 账户。 Mint account returned by RPC.
     * @param decimals 该资产要求的 Mint 小数位数。 Mint decimals required for this asset.
     * @return 已验证的小端布局，可进一步读取供给量和权限。 Verified little-endian layout for reading supply and authorities.
     */
    static ByteBuffer requireMint(JsonNode account, int decimals) {
        /** 经典 SPL Mint 使用小端编码选项标志和供给量。 Classic SPL mint options and supply use little-endian encoding. */
        ByteBuffer mint = ByteBuffer.wrap(accountData(account, TOKEN_PROGRAM_ID, MINT_BYTES)).order(ByteOrder.LITTLE_ENDIAN);
        /** SPL 为可选的权限公钥使用 u32 标志，取值只能为 0 或 1。 SPL uses u32 option flags of 0 or 1 for optional authorities. */
        int mintAuthority = mint.getInt(MINT_AUTHORITY_OPTION_OFFSET);
        int freezeAuthority = mint.getInt(MINT_FREEZE_OPTION_OFFSET);
        if (mint.get(MINT_DECIMALS_OFFSET) != decimals || mint.get(MINT_INITIALIZED_OFFSET) != 1
                || (mintAuthority != 0 && mintAuthority != 1) || (freezeAuthority != 0 && freezeAuthority != 1)) {
            throw invalidAccount("mint decimals, initialization or configuration");
        }
        return mint;
    }

    /**
     * 验证账户是指定程序拥有的非可执行账户，再读取预期长度的原始 Base64 数据。
     * Validates that the account is non-executable and owned by the expected program before reading an exact-size base64 payload.
     *
     * @param account RPC 账户对象，缺失时为 JSON null。 RPC account object, or JSON null when absent.
     * @param owner 所有者程序公钥。 Expected program owner public key.
     * @param size 二进制布局字节数。 Binary layout length in bytes.
     * @return 已校验的二进制账户布局。 Validated binary account layout.
     */
    static byte[] accountData(JsonNode account, String owner, int size) {
        return accountData(account, owner, size, size);
    }

    /**
     * 解码指定程序拥有的固定大小或固定版本区间账户。
     * Decodes a program-owned account of a fixed size or supported version range.
     *
     * @param account RPC 账户对象。 RPC account object.
     * @param owner 账户所有者程序公钥。 Owning program public key.
     * @param minSize 最小允许长度，单位为字节。 Allowed minimum length in bytes.
     * @param maxSize 最大允许长度，单位为字节。 Allowed maximum length in bytes.
     * @return 已核验所有者和长度的原始字节。 Raw bytes with verified owner and length.
     */
    static byte[] accountData(JsonNode account, String owner, int minSize, int maxSize) {
        /** RPC 的执行状态和固定结构的 Base64 数据。 Executable flag and fixed-shape base64 payload from RPC. */
        JsonNode executable = account.path("executable");
        JsonNode tuple = account.path("data");
        if (!account.isObject() || !owner.equals(account.path("owner").textValue()) || !executable.isBoolean()
                || executable.asBoolean() || !tuple.isArray() || tuple.size() != 2
                || !"base64".equals(tuple.path(1).textValue()) || !tuple.path(0).isTextual()) {
            throw invalidAccount("program owner or account data");
        }

        /** 先限制编码长度，只有预期的固定布局才可解码。 Bound the encoded length before decoding the expected fixed layout. */
        String encoded = tuple.get(0).textValue();
        if (encoded.length() > Math.ceilDiv(maxSize, 3) * 4) {
            throw invalidAccount("account size");
        }
        try {
            /** 解码后再次核对布局长度，因为 Base64 末尾填充无法区分相邻长度。 Recheck decoded length because base64 padding can hide adjacent sizes. */
            byte[] bytes = Base64.getDecoder().decode(encoded);
            if (bytes.length < minSize || bytes.length > maxSize) {
                throw invalidAccount("account size");
            }
            return bytes;
        } catch (IllegalArgumentException ignored) {
            throw invalidAccount("base64 account data");
        }
    }

    /**
     * 保留 RPC 返回的 u64 上下文 slot，不做浮点转换。
     * Preserves the u64 RPC context slot without floating-point conversion.
     *
     * @param result RPC 方法的结果。 RPC method result.
     * @return 最终确认观测 slot。 Finalized observation slot.
     */
    private BigInteger contextSlot(JsonNode result) {
        /** JSON 中的整数 slot。 Slot as a JSON integer. */
        JsonNode slot = result.path("context").path("slot");
        if (!slot.isIntegralNumber()) {
            throw invalidAccount("context slot");
        }
        try {
            return UnsignedIntegerUtil.requireUint64(slot.bigIntegerValue());
        } catch (IllegalArgumentException ignored) {
            throw invalidAccount("context slot");
        }
    }

    /**
     * 检查 RPC 依序返回了每个请求地址的一个账户条目。
     * Checks that RPC returned one account entry per requested address in positional order.
     *
     * @param result RPC 方法的结果。 RPC method result.
     * @param size 请求所带账户的数量。 Number of requested accounts.
     * @return 包含账户数据或空值的数组。 Array of account data or absent entries.
     */
    private JsonNode accountValues(JsonNode result, int size) {
        /** 与请求数组对应的账户条目。 Positional entries corresponding to the request array. */
        JsonNode values = result.path("value");
        if (!values.isArray() || values.size() != size) {
            throw invalidAccount("account batch");
        }
        return values;
    }

    /**
     * 将已校验布局中的 32 字节公钥转为规范 Base58。
     * Encodes the 32-byte key from a validated layout as canonical Base58.
     *
     * @param data 账户数据。 Account bytes.
     * @param offset 公钥的起始字节偏移。 Key's starting byte offset.
     * @return 规范 Base58 公钥。 Canonical Base58 public key.
     */
    static String publicKeyAt(byte[] data, int offset) {
        return SolanaAddressUtil.encodePublicKey(Arrays.copyOfRange(data, offset, offset + PUBLIC_KEY_BYTES));
    }

    /**
     * 按小端读取 u64，保留高位为 1 的数值。
     * Reads a little-endian u64 while preserving the high bit.
     *
     * @param data 小端账户缓冲区。 Little-endian account buffer.
     * @param offset u64 的起始字节偏移。 Starting byte offset of the u64.
     * @return 对应的无符号整数。 Corresponding unsigned integer.
     */
    static BigInteger unsignedLongAt(ByteBuffer data, int offset) {
        return new BigInteger(Long.toUnsignedString(data.getLong(offset)));
    }

    /**
     * 返回只说明校验阶段的异常，避免把原始 RPC 内容写入日志。
     * Returns an error naming only the validation step, keeping raw RPC data out of logs.
     *
     * @param field 校验失败的内部描述。 Internal label for the failed check.
     * @return 可记录并重试的观测异常。 Observation error safe to log before retrying.
     */
    static IllegalStateException invalidAccount(String field) {
        return new IllegalStateException("Invalid Devnet vault snapshot " + field);
    }

    /**
     * 金库启动状态和现金托管的绑定。
     * Vault activation state and cash custody binding.
     *
     * @param custody 现金托管 SPL Token 账户。 Cash custody SPL Token account.
     * @param strategyActive 链上已启用策略的标识。 Whether the on-chain vault has activated strategy operations.
     * @param autoRecallEnabled 本次观测是否启用自动收回。 Whether automatic recall is enabled at the observed state.
     */
    private record VaultBinding(String custody, boolean strategyActive, boolean autoRecallEnabled) {
    }

    /**
     * 同一最终确认上下文中的估值数据。
     * Valuation inputs from the same finalized context.
     *
     * @param slot RPC 观测的链上 slot。 On-chain slot returned in the RPC context.
     * @param cashRaw 以结算 Mint 最小单位计的托管现金。 Custody cash in settlement mint base units.
     * @param totalSharesRaw 以份额 Mint 最小单位计的已发行份额。 Outstanding shares in share mint base units.
     * @param strategyAmountRaw 策略代币最小单位数量。 Strategy token amount in base units.
     * @param strategyValueRaw 策略价值，按计价 Mint 最小单位计，缺价时为空。 Strategy value in quote mint base units, null when the price is unavailable.
     * @param lendValueRaw 出借份额价值，按计价 Mint 最小单位计。 Lending share value in quote mint base units.
     * @param recallableRaw 可立即从借贷池收回的计价 Mint 最小单位数。 Quote mint base units currently recallable from the pool.
     * @param autoRecallEnabled 观测时链上是否允许赎回自动收回。 Whether on-chain redemption allowed automatic recall when observed.
     * @param lendingPositionOpen 金库出借份额余额是否大于零。 Whether the vault has a nonzero balance of supply shares.
     */
    record Observation(BigInteger slot, BigInteger cashRaw, BigInteger totalSharesRaw, BigInteger strategyAmountRaw,
                       BigInteger strategyValueRaw, BigInteger lendValueRaw, BigInteger recallableRaw,
                       boolean autoRecallEnabled, boolean lendingPositionOpen) {

        /** 纯现金金库的策略和出借数值都已知为零。 All strategy and lending amounts are known zeros for a cash-only vault. */
        Observation(BigInteger slot, BigInteger cashRaw, BigInteger totalSharesRaw) {
            this(slot, cashRaw, totalSharesRaw, BigInteger.ZERO, BigInteger.ZERO, BigInteger.ZERO, BigInteger.ZERO, false, false);
        }

        /**
         * 将三个资产来源按相同计价 Mint 汇总。
         * Adds the three asset components in units of the same quote mint.
         *
         * @return 计价 Mint 最小单位净值。持有策略代币且缺价时为空。 NAV in quote mint base units, null when held strategy tokens lack a usable price.
         */
        BigInteger navRaw() {
            if (strategyValueRaw == null) {
                return null;
            }
            /** 链上存赎报价将净值约束在 u64 最小单位范围内。 On-chain investor quotes constrain NAV to the u64 base-unit range. */
            BigInteger markedNav = cashRaw.add(strategyValueRaw).add(lendValueRaw);
            if (markedNav.bitLength() > Long.SIZE) {
                throw invalidAccount("strategy NAV overflow");
            }
            return markedNav;
        }
    }
}

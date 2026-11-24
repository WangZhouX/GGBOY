package io.ggboy.backend.api;

import io.ggboy.common.api.SolanaNetwork;
import io.ggboy.common.utils.SolanaAddressUtil;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * 已校验的交易活动筛选和单页条数，业务类型按去重后的固定顺序保存。
 * Validated activity filters and page size, with sorted and deduplicated event types.
 *
 * @param network 必填网络，支持 localnet 和 devnet。 Required network, either localnet or devnet.
 * @param wallet 按任一事件参与方筛选的可选钱包公钥。 Optional public key matching any event participant.
 * @param subjectAddress 可选金库或借贷市场状态账户公钥。 Optional vault or lending market state account public key.
 * @param signature 可选的完整 Solana 交易签名。 Optional complete Solana transaction signature.
 * @param types 匹配任一类型，空列表表示全部类型。 Matches any listed type. An empty list matches all types.
 * @param limit 每页最多返回 1 至 100 条事件。 Maximum events returned per page, from 1 to 100.
 * @param category 可选的业务分类，与精确类型筛选同时生效。 Optional category applied together with exact type filters.
 */
public record ActivityQuery(
        SolanaNetwork network, String wallet, String subjectAddress, String signature, List<String> types, int limit,
        Category category
) {

    /** 交易活动页的业务分类，未指定时查询全部活动。 Activity page categories. An omitted category includes all activities. */
    public enum Category {
        /** 金库模块中除策略管理之外的活动。 Vault module activities outside strategy management. */
        VAULT,
        /** 借贷模块活动。 Lending module activities. */
        LENDING,
        /** 金库模块中以 STRATEGY_ 标识的活动。 Vault module activities identified by STRATEGY_. */
        STRATEGY;

        /**
         * 解析分类参数，省略时查询全部活动。
         * Parses the optional wire category, with omission allowing all activities.
         *
         * @param value 原始分类参数，未提供时为空引用。 Raw category parameter, or null if omitted.
         * @return 已校验的分类，省略时为空引用。 Validated category, or null when omitted.
         * @throws IllegalArgumentException 提供了不支持的分类。 An unsupported category was supplied.
         */
        private static Category parse(String value) {
            return switch (value) {
                case null -> null;
                case "vault" -> VAULT;
                case "lending" -> LENDING;
                case "strategy" -> STRATEGY;
                default -> throw new IllegalArgumentException("Invalid activity category");
            };
        }
    }

    /** 省略 limit 时返回的最大事件数。 Maximum number of events when limit is omitted. */
    private static final int DEFAULT_LIMIT = 20;

    /** 单页允许返回的最大事件数。 Maximum number of events allowed on one page. */
    private static final int MAX_LIMIT = 100;

    /** 请求中最多接受的 type 参数个数，去重之前检查。 Maximum type values per request, checked before deduplication. */
    private static final int MAX_TYPE_VALUES = 32;

    /** 事件类型使用与事件表长度一致的稳定大写业务代码。 Stable uppercase event codes within the event column width. */
    private static final Pattern EVENT_TYPE = Pattern.compile("[A-Z][A-Z0-9_]{0,47}");

    /** 页长只接受十进制的 ASCII 数字，最多三位。 Page size uses at most three ASCII decimal digits. */
    private static final Pattern LIMIT_TEXT = Pattern.compile("[0-9]{1,3}");

    /**
     * 校验筛选范围，并固定类型集合的顺序以绑定续页游标。
     * Validates the query scope and normalizes the type set for cursor binding.
     *
     * @param network 已解析的查询网络。 Parsed query network.
     * @param wallet 可选的钱包公钥。 Optional wallet public key.
     * @param subjectAddress 可选的业务状态账户公钥。 Optional business state account public key.
     * @param signature 可选的完整交易签名。 Optional complete transaction signature.
     * @param types 按 OR 匹配的原始类型列表，空引用与空列表均无类型限制。 Raw OR-ed types, with null or empty meaning no restriction.
     * @param limit 单页请求的最大事件数。 Maximum number of requested events per page.
     * @param category 已解析的可选业务分类。 Parsed optional business category.
     * @throws IllegalArgumentException 公钥、签名、类型或页长无效。 A public key, signature, type, or page size is invalid.
     */
    public ActivityQuery {
        Objects.requireNonNull(network, "network");
        if (wallet != null) {
            SolanaAddressUtil.requirePublicKey(wallet, "wallet");
        }
        if (subjectAddress != null) {
            SolanaAddressUtil.requirePublicKey(subjectAddress, "subjectAddress");
        }
        if (signature != null) {
            SolanaAddressUtil.requireSignature(signature, "signature");
        }
        if (limit < 1 || limit > MAX_LIMIT) {
            throw new IllegalArgumentException("limit must be between 1 and " + MAX_LIMIT);
        }

        // 类型筛选与输入顺序和重复次数无关。游标摘要与 Mapper 共享同一份规范列表。
        // Type matching is independent of order and duplicates. The cursor and mapper share one normalized list.
        types = normalizeTypes(types);
    }

    /**
     * 从 HTTP 参数构建已校验的查询，省略页长时使用默认值。
     * Builds a validated query from HTTP parameters, using the default page size if omitted.
     *
     * @param network 原始网络参数，必须为 localnet 或 devnet。 Raw network value, either localnet or devnet.
     * @param wallet 可选的钱包公钥文本。 Optional wallet public key text.
     * @param subjectAddress 可选的业务状态账户公钥文本。 Optional business state account public key text.
     * @param signature 可选的交易签名文本。 Optional transaction signature text.
     * @param types 重复传入的 type 参数，各自匹配一种事件类型。 Repeated type values, each matching one event type.
     * @param limit 原始的每页条数，空引用表示省略。 Raw page size, with null meaning omitted.
     * @return 可用于游标校验和数据查询的筛选范围。 Query scope ready for cursor validation and data retrieval.
     * @throws IllegalArgumentException 提供了不支持的网络或非法的筛选、页长参数。 The network, filters, or page size are invalid.
     */
    public static ActivityQuery parse(
            String network, String wallet, String subjectAddress, String signature, List<String> types, String limit
    ) {
        return parse(network, wallet, subjectAddress, signature, types, limit, null);
    }

    /**
     * 解析活动列表请求并校验可选业务分类。
     * Parses activity list parameters and validates the optional business category.
     *
     * @param network 原始网络参数，必须为 localnet 或 devnet。 Raw network value, either localnet or devnet.
     * @param wallet 可选的钱包公钥文本。 Optional wallet public key text.
     * @param subjectAddress 可选的业务状态账户公钥文本。 Optional business state account public key text.
     * @param signature 可选的完整交易签名文本。 Optional complete transaction signature text.
     * @param types 重复传入的精确事件类型。 Repeated exact event types.
     * @param limit 原始的每页条数，空引用表示省略。 Raw page size, or null if omitted.
     * @param category 可选的分类参数，省略时查询全部活动。 Optional category parameter, omitted for all activities.
     * @return 已校验的活动筛选条件。 Validated activity filters.
     * @throws IllegalArgumentException 筛选值或页长无效。 A filter value or page size is invalid.
     */
    public static ActivityQuery parse(
            String network, String wallet, String subjectAddress, String signature, List<String> types, String limit,
            String category
    ) {
        // 空字符串是显式无效页长。仅未提交 limit 时使用默认条数。
        // An explicit empty page size is invalid. Use the default only when limit is absent.
        if (limit != null && !LIMIT_TEXT.matcher(limit).matches()) {
            throw new IllegalArgumentException("limit must be a decimal page size");
        }
        return new ActivityQuery(
                SolanaNetwork.fromWireValue(network), wallet, subjectAddress, signature, types,
                limit == null ? DEFAULT_LIMIT : Integer.parseInt(limit), Category.parse(category)
        );
    }

    /**
     * 校验事件类型并转换成稳定排序的不可变集合。
     * Validates event types and returns an immutable list in a stable order.
     *
     * @param values 原始 type 参数列表，未提供时为空引用。 Raw type values, or null when absent.
     * @return 有序、无重复的事件类型列表。 Sorted, deduplicated list of event types.
     * @throws IllegalArgumentException 类型个数超限或存在格式错误的事件类型。 Too many types or a malformed event type.
     */
    private static List<String> normalizeTypes(List<String> values) {
        if (values == null) {
            return List.of();
        }
        // 去重前限制原始参数数量，保证解析和后续查询的规模。
        // Bound the raw input before deduplication to limit parsing and query size.
        if (values.size() > MAX_TYPE_VALUES) {
            throw new IllegalArgumentException("type accepts at most " + MAX_TYPE_VALUES + " values");
        }
        // 每个元素对应一个完整的稳定事件代码，禁止空项和分隔符。
        // Each element is one complete stable event code. Empty values and separators are invalid.
        for (String type : values) {
            if (type == null || !EVENT_TYPE.matcher(type).matches()) {
                throw new IllegalArgumentException("type must be an uppercase event code");
            }
        }
        return values.stream().distinct().sorted().toList();
    }
}

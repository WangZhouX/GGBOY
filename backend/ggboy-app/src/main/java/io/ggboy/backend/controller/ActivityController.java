package io.ggboy.backend.controller;

import io.ggboy.backend.api.ActivityCursor;
import io.ggboy.backend.api.ActivityQuery;
import io.ggboy.backend.api.ActivityResponse;
import io.ggboy.backend.service.ChainEventService;
import io.ggboy.common.api.ApiResponse;
import io.ggboy.common.api.CursorPage;
import io.ggboy.common.api.ErrorCode;
import io.ggboy.common.api.SolanaNetwork;
import io.ggboy.common.utils.SolanaAddressUtil;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.Parameters;
import io.swagger.v3.oas.annotations.enums.Explode;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.enums.ParameterStyle;
import io.swagger.v3.oas.annotations.media.ArraySchema;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import static io.ggboy.backend.api.ApiRequestExceptionHandler.errorResponse;

/**
 * 交易活动历史的 HTTP 控制器，涵盖事件参与方与代币变动。
 * HTTP controller for transaction activity, including event participants and token movements.
 */
@Tag(name = "交易活动", description = "查询交易记录、参与方和代币变动。 Query activity records, participants, and token movements.")
@RestController
@RequestMapping("/api/v1/activities")
public class ActivityController {

    /** 记录活动查询失败的服务端原因。 Records internal failures of activity queries. */
    private static final System.Logger LOGGER = System.getLogger(ActivityController.class.getName());

    /** 接受至多十个 ASCII 十进制数字，数值上限由 int 解析校验。 Accepts up to ten ASCII decimal digits, with the numeric upper bound enforced by int parsing. */
    private static final Pattern EVENT_INDEX_TEXT = Pattern.compile("[0-9]{1,10}");

    /** 分页读取事件或获取单条回执，并补全参与方和资产明细。 Pages events or fetches one receipt with full participants and asset details. */
    private final ChainEventService chainEventService;

    /**
     * 注入交易活动的查询服务。
     * Injects the activity query service.
     *
     * @param chainEventService 以链上业务事件为单位的查询入口。 Query entry point for individual on-chain business events.
     */
    public ActivityController(ChainEventService chainEventService) {
        this.chainEventService = chainEventService;
    }

    /**
     * 按网络和可选条件筛选已索引交易活动，以单个业务事件为单位返回游标分页。
     * Returns a cursor page of indexed activity events on one network using optional filters.
     *
     * <p>「交易活动」页（{@code /activity}，原型 {@code #activity}）的「活动记录」在进入页面或
     * 切换网络、分类及检索条件时加载首屏。加载更多时保持筛选并传回 {@code nextCursor}，无需连接钱包。
     * 页面使用 {@code type}、{@code blockTime}、{@code participants} 和 {@code assets} 展示动作、时间、
     * 参与角色和资产变动。通过 {@code signature} 与 {@code eventIndex} 打开该条记录的回执。
     * Activity Records on the Transaction Activity page ({@code /activity}, prototype {@code #activity})
     * loads the first page on entry or when the network, category, or search filters change.
     * Pass back {@code nextCursor} with the same filters to load more. A wallet connection is unnecessary.
     * The page renders the action, time, participant roles, and token movements from {@code type},
     * {@code blockTime}, {@code participants}, and {@code assets}. The receipt uses {@code signature}
     * and {@code eventIndex} to identify one record.
     *
     * <p>切到「借贷」时传 {@code category=lending}，展示已同步的抵押、借款、还款、取回抵押品和提取出借资金。
     * 列表按返回的 Mint 简称与交易精度显示实际资产金额，可用 {@code wallet} 筛选借款人或出借人。
     * The Lending filter sends {@code category=lending} to show indexed collateral deposits, borrows,
     * repayments, collateral withdrawals, and supply withdrawals. The list uses the registered mint symbol
     * and recorded precision for actual amounts and can filter by borrower or supplier with {@code wallet}.
     *
     * <p>策略金库页（{@code /vault}，原型 {@code #vault}）的「最近金库交易」在取得选中金库和已连接钱包后，
     * 传 {@code subjectAddress}、{@code wallet}、两种存赎事件类型及 {@code limit=4}，只取最新一页并展示时间和资产变动。
     * 切换钱包、金库或网络以及存赎确认后会刷新。链上已确认但尚未同步时，页面短时间重复查询。
     * Recent Vault Transactions on the Strategy Vault page ({@code /vault}, prototype {@code #vault}) loads the first
     * four indexed deposits or redemptions once a vault and connected wallet are available, then displays timestamps
     * and asset movements. It sends {@code subjectAddress}, {@code wallet}, both event types, and {@code limit=4}.
     * The view refreshes on wallet, vault, or network changes or transaction confirmation, then briefly polls if indexing lags.
     *
     * <p>策略管理页（{@code /strategy}，原型 {@code #strategy}）的「最近策略交易」在取得当前网络的选中金库后，
     * 按 {@code category=strategy} 和金库 PDA 的 {@code subjectAddress} 读取首屏，无需连接钱包。
     * 切换网络或金库、刷新页面或管理操作确认后重查。列表展示兑换、出借和收回的实际成交金额及回执入口。
     * Recent Strategy Transactions on Strategy Management ({@code /strategy}, prototype {@code #strategy})
     * loads the first page once a vault is selected on the current network. It uses {@code category=strategy}
     * and the vault PDA as {@code subjectAddress}, without a wallet connection.
     * Refetches on network or vault changes, refresh, and strategy transaction confirmation.
     * The list shows executed amounts and receipt links for swaps, allocations and recalls.
     *
     * @param parameters 查询参数。必填 {@code network}。可选 {@code wallet}、{@code subjectAddress}、
     *        {@code signature}、{@code category}、可重复的 {@code type}、默认 20 的 {@code limit} 和首屏省略的 {@code cursor}。
     *        Query parameters. Required {@code network}, optional {@code wallet}, {@code subjectAddress},
     *        {@code signature}, {@code category}, repeatable {@code type}, {@code limit} defaulting to 20, and {@code cursor}
     *        omitted on the first page.
     * @param locale 根据请求协商出的错误消息语言。 Error language negotiated from the request.
     * @return HTTP 200 的活动页。参数无效返回 400，查询失败返回 500。
     *        HTTP 200 with the activity page, HTTP 400 for invalid input, or HTTP 500 for a query failure.
     */
    @Operation(
            summary = "查询交易活动",
            description = "按网络和筛选条件分页查询已索引的链上事件，支持金库存赎、策略兑换、金库出借和收回、借款操作和出借资金提取。 "
                    + "Pages indexed on-chain events including vault deposits, redemptions, strategy swaps, vault allocations and recalls, borrowing actions, and supply withdrawals."
    )
    @Parameters({
            @Parameter(name = "network", in = ParameterIn.QUERY, required = true,
                    description = "查询的 Solana 网络。 Solana network to query.",
                    schema = @Schema(type = "string", allowableValues = {"localnet", "devnet"})),
            @Parameter(name = "wallet", in = ParameterIn.QUERY,
                    description = "按任一事件参与方的钱包公钥筛选。 Filter by the Base58 wallet key of any participant.",
                    schema = @Schema(type = "string")),
            @Parameter(name = "subjectAddress", in = ParameterIn.QUERY,
                    description = "按金库或借贷市场的状态账户公钥筛选。 Filter by the Base58 vault or lending market state account key.",
                    schema = @Schema(type = "string")),
            @Parameter(name = "signature", in = ParameterIn.QUERY,
                    description = "按完整 Solana 交易签名筛选。 Filter by the full Solana transaction signature.",
                    schema = @Schema(type = "string")),
            @Parameter(name = "category", in = ParameterIn.QUERY,
                    description = "筛选业务分类，省略时查询全部。vault 为金库，lending 为借贷，strategy 为策略管理。 "
                            + "Filter by business category. Omit to include all activities. Use vault, lending, or strategy.",
                    schema = @Schema(type = "string", allowableValues = {"vault", "lending", "strategy"})),
            @Parameter(name = "type", in = ParameterIn.QUERY, style = ParameterStyle.FORM, explode = Explode.TRUE,
                    description = "大写事件代码，可重复传入并匹配任一项，例如 type=VAULT_DEPOSIT&type=VAULT_REDEEM。 "
                            + "Repeat this query parameter with uppercase event codes to match any of the supplied types.",
                    array = @ArraySchema(maxItems = 32, schema = @Schema(type = "string", pattern = "[A-Z][A-Z0-9_]{0,47}"))),
            @Parameter(name = "limit", in = ParameterIn.QUERY,
                    description = "单页返回的最大事件数。 Maximum number of events per page.",
                    schema = @Schema(type = "integer", minimum = "1", maximum = "100", defaultValue = "20")),
            @Parameter(name = "cursor", in = ParameterIn.QUERY,
                    description = "保持筛选不变并传回上一页的 nextCursor，首屏省略。 "
                            + "Pass back nextCursor with the same filters, or omit for the first page.",
                    schema = @Schema(type = "string"))
    })
    @GetMapping
    public ResponseEntity<ApiResponse<CursorPage<ActivityResponse>>> listActivities(
            @Parameter(hidden = true)
            @RequestParam MultiValueMap<String, String> parameters,
            Locale locale
    ) {
        // 读取所有重复的 type 参数，先验证筛选和游标再查询数据库。
        // Keep every repeated type parameter and validate filters and cursor before reading the database.
        ActivityQuery query;
        ActivityCursor cursor;
        try {
            query = ActivityQuery.parse(
                    parameters.getFirst("network"),
                    parameters.getFirst("wallet"),
                    parameters.getFirst("subjectAddress"),
                    parameters.getFirst("signature"),
                    parameters.get("type"),
                    parameters.getFirst("limit"),
                    parameters.getFirst("category")
            );
            cursor = ActivityCursor.decode(query, parameters.getFirst("cursor"));
        } catch (IllegalArgumentException exception) {
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        }

        // 空结果是一个成功的分页响应。内部错误的详情仅用于服务端排查。
        // An empty result is a successful page. Keep internal failure details in server logs.
        try {
            return ResponseEntity.ok(ApiResponse.success(chainEventService.listActivities(query, cursor)));
        } catch (RuntimeException failure) {
            LOGGER.log(System.Logger.Level.ERROR, "Activity query failed", failure);
            return errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, locale);
        }
    }

    /**
     * 按网络、交易签名和事件序号查询单条已索引回执。
     * Loads one indexed receipt by network, transaction signature, and event index.
     *
     * <p>「交易活动」页（{@code /activity}，原型 {@code #activity}）的「活动记录」中点击「查看回执」
     * 或直接打开回执路径 {@code /activity/{signature}/events/{eventIndex}} 时调用。使用记录的
     * {@code network}、{@code signature} 和 {@code eventIndex}，无需连接钱包。
     * 回执使用交易 slot、区块时间、完整的参与方角色和资产变动展示该事件的结果。
     * 策略金库的「最近金库交易」和策略管理的「最近策略交易」复用该回执。
     * Activity Records on Transaction Activity ({@code /activity}, prototype {@code #activity}) calls this
     * endpoint when View Receipt is selected or the receipt route is opened directly. Use the record's
     * {@code network}, {@code signature}, and {@code eventIndex}. A wallet connection is unnecessary.
     * The receipt shows the transaction slot, block time, all participant roles, and asset movements.
     * Recent Vault Transactions and Recent Strategy Transactions reuse the same receipt route.
     *
     * <p>「借贷」活动中的出借提取回执展示出借人及资金池实际支付的代币金额、Mint 和精度。
     * A supply withdrawal receipt under Lending shows the supplier and the actual payout amount, token mint, and decimals.
     * 策略回执展示管理者、金库和实际换入换出或资金划转金额。
     * A strategy receipt shows the manager, vault and executed swap or allocation amounts.
     *
     * @param signature Base58 编码的 64 字节 Solana 交易主签名。 Base58-encoded 64-byte Solana primary transaction signature.
     * @param eventIndex 交易内从零开始的十进制事件序号，范围 0 至 2147483647。 Zero-based decimal event index from 0 through 2147483647.
     * @param network 必填网络标识，限 {@code localnet} 和 {@code devnet}。 Required network, either {@code localnet} or {@code devnet}.
     * @param locale 根据请求协商出的错误消息语言。 Error language negotiated from the request.
     * @return HTTP 200 的回执。参数无效、事件尚未索引或查询失败分别返回 400、404 或 500。
     *        HTTP 200 with the receipt, 400 for invalid input, 404 for an unindexed event, or 500 for a query failure.
     */
    @Operation(
            summary = "查看交易回执",
            description = "按网络、交易签名和事件序号查询一条已索引回执，含全部参与方和资产变动。"
                    + "未查到该事件时返回 404。 "
                    + "Fetches one indexed receipt with all participants and asset movements. An unindexed event returns 404."
    )
    @GetMapping("/{signature}/events/{eventIndex}")
    public ResponseEntity<ApiResponse<ActivityResponse>> getActivityReceipt(
            @Parameter(description = "Base58 编码的 64 字节交易主签名。 Base58-encoded 64-byte primary transaction signature.",
                    schema = @Schema(minLength = 64, maxLength = 88))
            @PathVariable("signature") String signature,
            @Parameter(description = "该笔交易内从零开始的事件序号。 Zero-based event index within the transaction.",
                    schema = @Schema(type = "integer", format = "int32", minimum = "0", maximum = "2147483647"))
            @PathVariable("eventIndex") String eventIndex,
            @Parameter(description = "该条回执所在的 Solana 网络。 Solana network containing the receipt.",
                    schema = @Schema(allowableValues = {"localnet", "devnet"}))
            @RequestParam("network") String network,
            Locale locale
    ) {
        // 校验后的网络限定签名和事件序号的查询范围。
        // The validated network scopes the signature and event-index lookup.
        SolanaNetwork solanaNetwork;
        // 零基事件序号将用于匹配交易中的单条记录。
        // The zero-based event index identifies an individual record within the transaction.
        int receiptEventIndex;
        try {
            solanaNetwork = SolanaNetwork.fromWireValue(network);
            SolanaAddressUtil.requireSignature(signature, "signature");
            // 只接受非负十进制数字，解析时拒绝超出 int 上限的值。
            // Accept only nonnegative decimal digits and reject int overflow while parsing.
            if (!EVENT_INDEX_TEXT.matcher(eventIndex).matches()) {
                return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
            }
            receiptEventIndex = Integer.parseInt(eventIndex);
        } catch (IllegalArgumentException exception) {
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        }

        // 无匹配事件映射为 404，查询异常只在服务端日志中记录内部原因。
        // Map a missing event to 404 and retain query failure details in server logs.
        try {
            return chainEventService.getActivityReceipt(solanaNetwork, signature, receiptEventIndex)
                    .map(receipt -> ResponseEntity.ok(ApiResponse.success(receipt)))
                    .orElseGet(() -> errorResponse(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, locale));
        } catch (RuntimeException failure) {
            LOGGER.log(System.Logger.Level.ERROR, "Activity receipt query failed", failure);
            return errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, locale);
        }
    }
}

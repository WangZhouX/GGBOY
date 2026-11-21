package io.ggboy.backend.controller;

import io.ggboy.backend.api.LendingLiquidationPageResponse;
import io.ggboy.backend.api.LendingMarketListResponse;
import io.ggboy.backend.api.LiquidationCursor;
import io.ggboy.backend.api.LendingPositionResponse;
import io.ggboy.backend.service.LendingLiquidationService;
import io.ggboy.backend.service.LendingMarketService;
import io.ggboy.common.api.ApiResponse;
import io.ggboy.common.api.ErrorCode;
import io.ggboy.common.api.SolanaNetwork;
import io.ggboy.common.utils.SolanaAddressUtil;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.Locale;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import static io.ggboy.backend.api.ApiRequestExceptionHandler.errorResponse;

/**
 * 借贷市场的 HTTP 控制器，包含资金池、钱包仓位和清算候选查询。
 * HTTP controller for lending pool, wallet position and liquidation candidate queries.
 */
@Tag(name = "借贷市场", description = "查询资金池现况、借款与出借仓位、清算候选。 Query pool overviews, borrowing and supplying positions, and liquidation candidates.")
@RestController
@RequestMapping("/api/v1/lending-markets")
public class LendingMarketController {

    /** 记录内部市场查询失败，供服务端排查。 Records internal market query failures for server-side diagnosis. */
    private static final System.Logger LOGGER = System.getLogger(LendingMarketController.class.getName());

    /** 组装市场概况和钱包仓位的查询服务。 Query service for pool overviews and wallet positions. */
    private final LendingMarketService lendingMarketService;

    /** 按市场读取同批清算候选的查询服务。 Query service for candidates evaluated together in one market. */
    private final LendingLiquidationService liquidationService;

    /**
     * 注入借贷市场查询服务。
     * Injects the lending market query service.
     *
     * @param lendingMarketService 市场概况和钱包仓位的业务入口。 Entry point for pool overviews and wallet positions.
     * @param liquidationService 清算候选分页的业务入口。 Entry point for liquidation candidate pagination.
     */
    public LendingMarketController(
            LendingMarketService lendingMarketService,
            LendingLiquidationService liquidationService
    ) {
        this.lendingMarketService = lendingMarketService;
        this.liquidationService = liquidationService;
    }

    /**
     * 查询指定网络的市场目录及每个市场的最新快照。
     * Lists registered lending markets and the latest snapshot of each market on the requested network.
     *
     * <p>预计用于借贷市场「市场概况」页（原型 {@code #lend}）的「资金池现况」。页面进入、刷新或切换网络时
     * 调用，无需连接钱包。显示当前市场的 {@code latestSnapshot} 中的 {@code cashRaw}、
     * {@code totalDebtRaw}、{@code utilizationBps}、{@code borrowRateBps}、{@code supplyRateBps}。
     * 用 {@code debtAsset.decimals} 换算金额，用基点换算百分比。空快照表示尚未采集。
     * Planned for Pool Overview on the lending Market Overview page (prototype {@code #lend}). Fetch on entry,
     * refresh, or network change without requiring a connected wallet. Render the selected market's
     * {@code latestSnapshot} using {@code cashRaw}, {@code totalDebtRaw}, {@code utilizationBps},
     * {@code borrowRateBps}, and {@code supplyRateBps}. Format amounts with {@code debtAsset.decimals}
     * and convert basis points to percentages. A null snapshot means the pool has not been observed.
     *
     * @param network 必填，使用 {@code localnet} 或 {@code devnet}。
     *        Required network identifier, either {@code localnet} or {@code devnet}.
     * @param locale 请求协商出的错误文案语言。 Error language negotiated for the request.
     * @return 成功时返回 HTTP 200。网络无效返回 HTTP 400，查询失败返回 HTTP 500。
     *        HTTP 200 on success, HTTP 400 for an invalid network, or HTTP 500 for an internal query failure.
     */
    @Operation(
            summary = "查询资金池现况",
            description = "返回指定网络的市场目录、资产精度和最新资金池快照。 "
                    + "Lists markets, asset precision, and each pool's latest snapshot for the requested network."
    )
    @GetMapping
    public ResponseEntity<ApiResponse<LendingMarketListResponse>> listMarkets(
            @Parameter(description = "查询的 Solana 网络。 Solana network to query.",
                    schema = @Schema(allowableValues = {"localnet", "devnet"}))
            @RequestParam("network") String network,
            Locale locale
    ) {
        // 解析后的网络限定市场登记、Mint 和快照的数据范围。
        // Scope the market registration, mint, and snapshot reads to the parsed network.
        SolanaNetwork solanaNetwork;
        try {
            solanaNetwork = SolanaNetwork.fromWireValue(network);
        } catch (IllegalArgumentException exception) {
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        }

        // 没有市场时仍返回成功的空列表，查询异常的详情留在服务端日志。
        // Return a successful empty list when the network has no markets. Keep failure details in server logs.
        try {
            return ResponseEntity.ok(ApiResponse.success(lendingMarketService.listMarkets(solanaNetwork)));
        } catch (RuntimeException failure) {
            LOGGER.log(System.Logger.Level.ERROR, "Lending market query failed", failure);
            return errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, locale);
        }
    }

    /**
     * 查询一个市场中指定钱包最新采集的借款及出借仓位。
     * Returns the latest observed borrowing and supplying position for one market and wallet.
     *
     * <p>预计用于「我的借款」（原型 {@code #lend/borrow}）的「借款仓位」和「额度与清算条件」。
     * 用 {@code collateralRaw}、{@code debtRaw}、{@code healthFactor} 和 {@code isLiquidatable} 展示仓位，
     * 用 {@code maxBorrowRaw}、{@code maxCollateralWithdrawRaw} 及 {@code marketRisk} 展示额度和风险条件。
     * Planned for Borrowing Position and Borrowing Limits and Liquidation Conditions on My Borrowing
     * (prototype {@code #lend/borrow}). Use {@code collateralRaw}, {@code debtRaw}, {@code healthFactor},
     * and {@code isLiquidatable} to show the position, and {@code maxBorrowRaw}, {@code maxCollateralWithdrawRaw},
     * and {@code marketRisk} for limits and risk parameters.
     *
     * <p>「我的出借」（原型 {@code #lend/supply}）的「个人出借资金」使用 {@code supplySharesRaw}、
     * {@code suppliedValueRaw}、{@code maxSupplyWithdrawRaw} 和 {@code maxSupplyWithdrawSharesRaw}。
     * 钱包可用余额另由前端通过 RPC 读取。
     * Personal Supplied Funds on My Supply (prototype {@code #lend/supply}) uses {@code supplySharesRaw},
     * {@code suppliedValueRaw}, {@code maxSupplyWithdrawRaw}, and {@code maxSupplyWithdrawSharesRaw}.
     * Fetch the wallet's available token balance separately through RPC.
     *
     * <p>两页均在取得选中市场和已连接钱包的公钥后调用，切换市场、钱包或网络及相关交易确认后重查。
     * 用观测 slot 和时间提示同步状态。空快照表示钱包尚未采集，空额度表示当前不可估算。
     * On both pages, query once the selected market and connected wallet keys are available. Refetch on changes
     * to the market, wallet or network and after a related transaction confirms. Display the observation slot and
     * time for sync status. A null snapshot means unobserved. A null limit means no current estimate.
     *
     * @param address 市场状态账户的 32 字节 Base58 公钥。 Base58 market state public key decoding to 32 bytes.
     * @param wallet 仓位持有人的 32 字节 Base58 公钥。 Base58 position-owner public key decoding to 32 bytes.
     * @param network 与页面所选部署一致的小写网络标识，支持 {@code localnet} 和 {@code devnet}。
     *        Lowercase network matching the page's deployment, either {@code localnet} or {@code devnet}.
     * @param locale 请求协商出的错误文案语言。 Error language negotiated for the request.
     * @return 已登记市场返回 HTTP 200。参数无效、市场未登记或查询失败时返回 400、404 或 500。
     *        HTTP 200 for a registered market, 400 for invalid input, 404 for an unregistered market, or 500 on query failure.
     */
    @Operation(
            summary = "查询借款与出借仓位",
            description = "返回指定钱包的最新抵押、债务、健康度、出借份额及可估算额度。 "
                    + "Returns the wallet's latest collateral, debt, health, supply shares, and available limit estimates."
    )
    @GetMapping("/{address}/positions/{wallet}")
    public ResponseEntity<ApiResponse<LendingPositionResponse>> getLendingPosition(
            @Parameter(description = "选中的借贷市场状态账户公钥。 Base58 public key of the selected lending market state account.")
            @PathVariable("address") String address,
            @Parameter(description = "仓位持有人的钱包公钥。 Base58 public key of the position owner.")
            @PathVariable("wallet") String wallet,
            @Parameter(description = "查询的 Solana 网络。 Solana network to query.",
                    schema = @Schema(allowableValues = {"localnet", "devnet"}))
            @RequestParam("network") String network,
            Locale locale
    ) {
        // 先校验网络和 Solana 公钥，避免把不合法的键交给数据库。
        // Validate the network and both Solana public keys before sending keys to the database.
        SolanaNetwork solanaNetwork;
        try {
            solanaNetwork = SolanaNetwork.fromWireValue(network);
            SolanaAddressUtil.requirePublicKey(address, "address");
            SolanaAddressUtil.requirePublicKey(wallet, "wallet");
        } catch (IllegalArgumentException exception) {
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        }

        // 市场未登记映射为 404。已登记但钱包未采集时，Service 返回带空快照的正常数据。
        // An unregistered market maps to 404. A registered market with no wallet observation returns a normal payload.
        try {
            return lendingMarketService.getLendingPosition(solanaNetwork, address, wallet)
                    .map(position -> ResponseEntity.ok(ApiResponse.success(position)))
                    .orElseGet(() -> errorResponse(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, locale));
        } catch (RuntimeException failure) {
            LOGGER.log(System.Logger.Level.ERROR, "Lending position query failed", failure);
            return errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, locale);
        }
    }

    /**
     * 查询一个市场在同一评估上下文中可展示的清算候选。
     * Lists liquidation candidates for one market under a single evaluation context.
     *
     * <p>预计用于「清算市场」（原型 {@code #lend/liquidations}）中接替「演示借款仓位」的候选列表。
     * 选中市场后即可公开查询，无需连接钱包。进入页面、刷新、切换网络或市场、清算确认后加载首屏。
     * 续页原样传回 {@code nextCursor}。评估上下文变更导致游标无效时，重新加载首屏。
     * Planned for the candidate list replacing Demo Borrower Position on the Liquidation Market page
     * (prototype {@code #lend/liquidations}). Once a market is selected, fetch without a wallet connection.
     * Load the first page on page entry, refresh, network or market change, or liquidation confirmation.
     * Pass back {@code nextCursor} to load more, and restart from the first page if the evaluation context changes.
     *
     * <p>用 {@code availability} 区分同步中、过期、缺价和就绪。候选行展示 {@code walletAddress}、
     * {@code collateralRaw}、{@code debtRaw}、{@code healthFactor} 及观测时间。行情信息取顶层的
     * {@code oracleAddress}、{@code collateralPrice} 和 {@code oraclePublishedAt}。
     * 连接清算人钱包后通过实时 RPC 预览代偿金额和可领取的抵押品。
     * Use {@code availability} to distinguish syncing, stale, price unavailable and ready states.
     * Rows show {@code walletAddress}, {@code collateralRaw}, {@code debtRaw}, {@code healthFactor}, and
     * observation time. Use the top-level {@code oracleAddress}, {@code collateralPrice}, and
     * {@code oraclePublishedAt} for quote data. Preview repayment and seized collateral using live RPC
     * once a liquidator wallet is connected.
     *
     * @param address 市场状态账户的 32 字节 Base58 公钥。 Base58 public key of the market state account, decoding to 32 bytes.
     * @param network 必填网络标识，限 {@code localnet} 和 {@code devnet}。 Required network, either {@code localnet} or {@code devnet}.
     * @param limit 可选的每页条数，默认 20，范围 1 至 100。 Optional page size from 1 to 100, defaulting to 20.
     * @param cursor 此市场前一页返回的游标，首屏省略。 Cursor from the previous page of this market, omitted on first load.
     * @param locale 请求协商出的错误文案语言。 Error language negotiated for the request.
     * @return HTTP 200 的候选页或数据不可用状态。请求、市场或查询失败分别返回 HTTP 400、404 或 500。
     *        HTTP 200 for a candidate page or unavailable data, 400 for invalid input, 404 for an unknown market, or 500 on query failure.
     */
    @Operation(
            summary = "查询可清算仓位",
            description = "按健康度分页查询同批候选。数据过期、缺价或仍在同步时返回状态和空列表。 "
                    + "Pages through candidates by health factor. Stale data, unavailable prices, and pending observations return a status and an empty list."
    )
    @GetMapping("/{address}/liquidations")
    public ResponseEntity<ApiResponse<LendingLiquidationPageResponse>> listLiquidations(
            @Parameter(description = "选中的借贷市场状态账户公钥。 Base58 public key of the selected lending market state account.")
            @PathVariable("address") String address,
            @Parameter(description = "查询的 Solana 网络。 Solana network to query.",
                    schema = @Schema(allowableValues = {"localnet", "devnet"}))
            @RequestParam("network") String network,
            @Parameter(description = "单页返回的最大条数。 Maximum number of items per page.",
                    schema = @Schema(type = "integer", minimum = "1", maximum = "100", defaultValue = "20"))
            @RequestParam(name = "limit", required = false) String limit,
            @Parameter(description = "续页传回上一页的 nextCursor，首屏省略。 "
                    + "Pass back nextCursor from the previous page, or omit for the first page.")
            @RequestParam(name = "cursor", required = false) String cursor,
            Locale locale
    ) {
        // 类型化网络限制市场查询和游标的作用域。
        // The typed network scopes the market lookup and cursor.
        SolanaNetwork solanaNetwork;
        // 单页最多返回的仓位条数，省略时使用 20。
        // Maximum positions to return on the page, defaulting to 20 when omitted.
        int pageSize;
        // 绑定网络和市场的续页边界，首屏为空。
        // Market- and network-scoped continuation boundary, null for the first page.
        LiquidationCursor continuation;
        try {
            solanaNetwork = SolanaNetwork.fromWireValue(network);
            SolanaAddressUtil.requirePublicKey(address, "address");
            pageSize = limit == null ? 20 : Integer.parseInt(limit);
            if (pageSize < 1 || pageSize > 100) {
                return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
            }
            continuation = LiquidationCursor.decode(cursor, solanaNetwork, address);
        } catch (IllegalArgumentException exception) {
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        }

        // 格式正确但对应旧评估的游标需要重查首屏。服务内部查询失败用统一 500，并记录原因。
        // A valid cursor for an older evaluation requires a new first page. Log internal failures and return the shared 500.
        try {
            return liquidationService.listLiquidations(solanaNetwork, address, pageSize, continuation)
                    .map(page -> ResponseEntity.ok(ApiResponse.success(page)))
                    .orElseGet(() -> errorResponse(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, locale));
        } catch (LiquidationCursor.ObservationChangedException exception) {
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        } catch (RuntimeException failure) {
            LOGGER.log(System.Logger.Level.ERROR, "Lending liquidation query failed", failure);
            return errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, locale);
        }
    }
}

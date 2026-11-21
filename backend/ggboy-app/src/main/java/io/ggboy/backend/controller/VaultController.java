package io.ggboy.backend.controller;

import io.ggboy.backend.api.VaultHistoryCursor;
import io.ggboy.backend.api.VaultHistorySnapshotResponse;
import io.ggboy.backend.api.VaultListResponse;
import io.ggboy.backend.api.VaultPositionResponse;
import io.ggboy.backend.service.VaultService;
import io.ggboy.common.api.ApiResponse;
import io.ggboy.common.api.CursorPage;
import io.ggboy.common.api.ErrorCode;
import io.ggboy.common.api.SolanaNetwork;
import io.ggboy.common.utils.SolanaAddressUtil;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.math.BigInteger;
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
 * 策略金库的 HTTP 查询控制器，涵盖净值、流动性和钱包份额。
 * HTTP query controller for strategy vault NAV, liquidity and wallet shares.
 */
@Tag(name = "策略金库", description = "查询金库概况、历史净值、钱包份额与赎回额度。 Query vault overviews, NAV history, wallet shares and redemption limits.")
@RestController
@RequestMapping("/api/v1/vaults")
public class VaultController {

    /** 记录内部查询失败原因，便于服务端排查。 Records internal query failures for server-side diagnosis. */
    private static final System.Logger LOGGER = System.getLogger(VaultController.class.getName());

    /**
     * 负责组装金库目录、历史快照和钱包持仓的查询服务。
     * Query service for vault registrations, snapshot history and wallet positions.
     */
    private final VaultService vaultService;

    /**
     * 注入金库查询服务。
     * Injects the vault query service.
     *
     * @param vaultService 金库目录、快照和钱包持仓的业务入口。 Business entry point for vault registrations, snapshots and positions.
     */
    public VaultController(VaultService vaultService) {
        this.vaultService = vaultService;
    }

    /**
     * 查询指定网络的金库目录和最新快照。此列表是公开只读接口。
     * Lists registered vaults and their latest snapshots for the requested network. This is a public read-only endpoint.
     *
     * <p>预计前端用途为策略金库页（原型 {@code #vault}）的「金库资产与每份净值」和「即时赎回资金来源」。
     * 页面打开、刷新或切换网络时调用，无需连接钱包。响应供页面展示总净值、每份净值、闲置现金、
     * 策略与出借估值、以及金库当前可用的赎回资金。
     * Planned frontend use is the Strategy Vault page (prototype {@code #vault}), in the
     * Vault Assets and NAV per Share and Immediate Redemption Funding sections.
     * Call on page entry, refresh, or network change without requiring a connected wallet.
     * The response supports total NAV, NAV per share, idle cash, strategy and lending valuations,
     * and the vault's currently available redemption funding.
     *
     * @param network 必填，使用 {@code localnet} 或 {@code devnet}。
     *        Required network identifier, either {@code localnet} or {@code devnet}.
     * @param locale 本次请求协商出的错误消息语言。
     *        Error message language negotiated for the request.
     * @return 查询成功返回 HTTP 200 和统一响应。网络无效时返回 HTTP 400，查询失败时返回 HTTP 500。
     *        HTTP 200 on success, HTTP 400 for an invalid network, or HTTP 500 for an internal query failure.
     */
    @Operation(
            summary = "查询策略金库概况",
            description = "返回指定网络的金库及其最新快照，用于查看净值和即时赎回资金。 "
                    + "Lists vaults and their latest snapshots for NAV and immediate redemption funding."
    )
    @GetMapping
    public ResponseEntity<ApiResponse<VaultListResponse>> listVaults(
            @Parameter(description = "查询的 Solana 网络。 Solana network to query.",
                    schema = @Schema(allowableValues = {"localnet", "devnet"}))
            @RequestParam("network") String network,
            Locale locale
    ) {
        // 解析后的网络用于限定服务查询范围。
        // The parsed network scopes the service query.
        SolanaNetwork solanaNetwork;
        try {
            solanaNetwork = SolanaNetwork.fromWireValue(network);
        } catch (IllegalArgumentException exception) {
            // 仅将网络解析失败映射为请求错误，并与缺参响应使用相同的语言和缓存头。
            // Map only network parsing failures to request errors and use the same language and cache headers as missing parameters.
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        }

        // 成功响应使用服务组装出的列表，包括没有金库时的空列表。
        // The success response uses the list assembled by the service, including an empty list when no vaults are registered.
        try {
            return ResponseEntity.ok(ApiResponse.success(vaultService.listVaults(solanaNetwork)));
        } catch (RuntimeException failure) {
            return queryFailure(failure, locale);
        }
    }

    /**
     * 按数值 slot 倒序分页查询已登记金库的历史快照。
     * Pages through a registered vault's snapshot history in descending numeric slot order.
     *
     * <p>预计用于策略金库页（原型 {@code #vault}）的「每份净值走势」。页面取得选中金库地址后加载首屏，
     * 切换金库或网络时重查。图表需要更早的点时传入 {@code nextCursor}，无需连接钱包。按 {@code observedAt}
     * 的时间正序绘图，用 {@code navRaw} 与 {@code totalSharesRaw} 按各自 Mint 精度换算每份净值。
     * 缺少净值或总份额为零时保留图表缺口。
     * Planned for the NAV per Share History chart on the Strategy Vault page (prototype {@code #vault}).
     * Fetch the first page once a vault is selected and refetch when the vault or network changes. Use
     * {@code nextCursor} for older chart points. A wallet connection is unnecessary. Plot {@code observedAt}
     * chronologically and calculate NAV per share from {@code navRaw} and {@code totalSharesRaw} using their
     * mint decimals. Leave a gap when NAV is unavailable or outstanding shares are zero.
     *
     * @param address 金库状态账户的 32 字节 Base58 公钥。 Base58 public key of the vault state account, decoding to 32 bytes.
     * @param network 当前环境，限 {@code localnet} 或 {@code devnet}。 Current environment, either {@code localnet} or {@code devnet}.
     * @param limit 本页条数，未提供时为 20，允许 1 至 100。 Optional page size from 1 to 100, defaulting to 20.
     * @param cursor 同一金库和网络的上一页返回的游标。首次请求省略。 Cursor from the previous page for this vault and
     *        network. Omit for the first page.
     * @param locale 根据请求协商出的错误消息语言。 Error message language negotiated for the request.
     * @return HTTP 200 返回历史页。参数无效、金库未登记或查询失败分别返回 HTTP 400、404 或 500。
     *        HTTP 200 with a history page, or HTTP 400 for invalid input, 404 for an unregistered vault,
     *        or 500 for an internal query failure.
     */
    @Operation(
            summary = "查询每份净值历史",
            description = "按观测 slot 倒序分页返回历史快照，用于绘制每份净值走势。 "
                    + "Pages through snapshots newest first for the NAV per share chart."
    )
    @GetMapping("/{address}/snapshots")
    public ResponseEntity<ApiResponse<CursorPage<VaultHistorySnapshotResponse>>> listVaultSnapshots(
            @Parameter(description = "选中的金库状态账户公钥。 Base58 public key of the selected vault state account.")
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
        // 解析网络及每页条数，游标解码为下一页的排他 slot 上界。首次请求没有上界。
        // Parse network and page size, and decode the cursor to an exclusive slot bound. The first page has no bound.
        SolanaNetwork solanaNetwork;
        int pageSize;
        BigInteger beforeSlot;
        try {
            solanaNetwork = SolanaNetwork.fromWireValue(network);
            SolanaAddressUtil.requirePublicKey(address, "address");
            // 只有省略 limit 才应用默认值。空字符串或超出取值范围视为输入错误。
            // Apply the default only to an omitted limit. A blank or out-of-range value is invalid.
            pageSize = limit == null ? 20 : Integer.parseInt(limit);
            if (pageSize < 1 || pageSize > 100) {
                return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
            }
            beforeSlot = VaultHistoryCursor.decode(cursor, solanaNetwork, address);
        } catch (IllegalArgumentException exception) {
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        }

        // 空 Optional 代表金库未登记。已登记金库没有匹配快照时仍返回空页。
        // Empty Optional means the vault is unregistered. A registered vault without matching snapshots returns an empty page.
        try {
            return vaultService.listVaultSnapshots(solanaNetwork, address, beforeSlot, pageSize)
                    .map(page -> ResponseEntity.ok(ApiResponse.success(page)))
                    .orElseGet(() -> errorResponse(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, locale));
        } catch (RuntimeException failure) {
            return queryFailure(failure, locale);
        }
    }

    /**
     * 查询指定网络、金库和钱包的最新持仓。
     * Reads the latest position for the requested network, vault and wallet.
     *
     * <p>预计用于策略金库页（原型 {@code #vault}）的「我的金库份额」区域。页面取得当前金库地址和已连接钱包的
     * 公钥后调用，钱包、金库或网络切换以及存入或赎回确认后重查。用 {@code sharesRaw} 显示「持有份额」，
     * {@code positionValueRaw} 显示「份额估值」，{@code redeemableRaw} 显示「现在可赎回」。
     * {@code maxRedeemSharesRaw} 可为「赎回份额」表单提供快照中的份额上限。
     * Planned for the Strategy Vault page (prototype {@code #vault}), in the My Vault Shares section.
     * Call once the page has the selected vault address and connected wallet public key. Refetch on wallet, vault
     * or network change and after a deposit or redemption confirms. Render Shares Held from {@code sharesRaw},
     * Position Value from {@code positionValueRaw} and Redeemable Now from {@code redeemableRaw}.
     * The Redeem Shares form can use {@code maxRedeemSharesRaw} as its snapshot-based share limit.
     *
     * @param address 选中金库的 Base58 公钥，解码为 32 字节。 Selected vault's Base58 public key, decoded to 32 bytes.
     * @param wallet 已连接钱包的 Base58 公钥，解码为 32 字节。 Connected wallet's Base58 public key, decoded to 32 bytes.
     * @param network 与前端当前环境一致的网络，使用 {@code localnet} 或 {@code devnet}。
     *        Network matching the frontend environment, either {@code localnet} or {@code devnet}.
     * @param locale 本次请求协商出的错误消息语言。 Error message language negotiated for the request.
     * @return 已登记金库返回 HTTP 200。无钱包快照时数据中的 {@code snapshot} 为空。输入无效时返回 400，
     *        金库在该网络未登记时返回 404，查询失败时返回 500。
     *        HTTP 200 for a registered vault with a null {@code snapshot} if the wallet is unobserved.
     *        HTTP 400 for invalid inputs, 404 for an unregistered vault on the requested network, or 500 for an internal query failure.
     */
    @Operation(
            summary = "查询我的金库份额",
            description = "返回指定钱包在所选金库的最新份额、估值及可赎回额度。 "
                    + "Returns the selected wallet's latest shares, valuation, and redemption limit in the vault."
    )
    @GetMapping("/{address}/positions/{wallet}")
    public ResponseEntity<ApiResponse<VaultPositionResponse>> getVaultPosition(
            @Parameter(description = "选中的金库状态账户公钥。 Base58 public key of the selected vault state account.")
            @PathVariable("address") String address,
            @Parameter(description = "仓位持有人的钱包公钥。 Base58 public key of the position owner.")
            @PathVariable("wallet") String wallet,
            @Parameter(description = "查询的 Solana 网络。 Solana network to query.",
                    schema = @Schema(allowableValues = {"localnet", "devnet"}))
            @RequestParam("network") String network,
            Locale locale
    ) {
        // 已解析的网络及两个已通过 32 字节公钥校验的路径参数共同限定查询。
        // Scope the lookup with the parsed network and both path parameters validated as 32-byte public keys.
        SolanaNetwork solanaNetwork;
        try {
            solanaNetwork = SolanaNetwork.fromWireValue(network);
            SolanaAddressUtil.requirePublicKey(address, "address");
            SolanaAddressUtil.requirePublicKey(wallet, "wallet");
        } catch (IllegalArgumentException exception) {
            return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
        }

        // 服务层仅在金库未登记时返回空 Optional，未采集的持仓仍有独立的 200 响应。
        // The service returns an empty Optional only when the vault is unregistered. An unobserved position has its own 200 payload.
        try {
            return vaultService.getVaultPosition(solanaNetwork, address, wallet)
                    .map(position -> ResponseEntity.ok(ApiResponse.success(position)))
                    .orElseGet(() -> errorResponse(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, locale));
        } catch (RuntimeException failure) {
            return queryFailure(failure, locale);
        }
    }

    /**
     * 记录内部查询异常，并向客户端返回协商语言下的通用 HTTP 500。
     * Logs the internal query exception and returns a generic localized HTTP 500 to the client.
     *
     * @param failure 服务层调用抛出的异常。 Exception raised by the service call.
     * @param locale 本次请求协商出的错误消息语言。 Negotiated error message language.
     * @param <T> 成功响应的数据类型。 Success payload type.
     * @return 包含 {@code INTERNAL_ERROR} 和对应文案的统一响应。 Shared response with {@code INTERNAL_ERROR} and its message.
     */
    private static <T> ResponseEntity<ApiResponse<T>> queryFailure(RuntimeException failure, Locale locale) {
        LOGGER.log(System.Logger.Level.ERROR, "Vault query failed", failure);
        return errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, locale);
    }
}

package io.ggboy.common.api;

import java.util.Locale;

/**
 * 业务 API 使用的稳定错误码，枚举名称构成前后端契约。
 * Stable business API error codes whose enum names form the client-server contract.
 */
public enum ErrorCode {

    /** 请求参数或请求体不符合接口约定。 Request parameters or body violate the API contract. */
    INVALID_REQUEST("请求参数无效。", "The request is invalid."),

    /** 请求的资源不存在。 The requested resource does not exist. */
    NOT_FOUND("请求的资源不存在。", "The requested resource was not found."),

    /** 服务端无法完成请求。 The server could not complete the request. */
    INTERNAL_ERROR("服务端无法完成请求。", "The request could not be completed.");

    /** 中文请求使用的简体中文提示。 Simplified Chinese message for requests in Chinese. */
    private final String chineseMessage;

    /** 英文请求和语言回退使用的英文提示。 English message for English requests and language fallback. */
    private final String englishMessage;

    /**
     * 为同一个稳定错误码登记中英文公开提示。
     * Registers Chinese and English public messages for the same stable error code.
     *
     * @param chineseMessage 中文请求收到的简体中文提示。 Simplified Chinese message for Chinese requests.
     * @param englishMessage 英文请求或默认情况下使用的提示。 English message for English requests or fallback.
     */
    ErrorCode(String chineseMessage, String englishMessage) {
        this.chineseMessage = chineseMessage;
        this.englishMessage = englishMessage;
    }

    /**
     * 读取该错误码的公开消息。
     * Retrieves the public message for this error code.
     *
     * @return 客户端可见的消息。 Client-facing message.
     */
    public String publicMessage() {
        return englishMessage;
    }

    /**
     * 按请求语言读取公开提示。所有中文地区和书写系统共用简体文案。
     * Returns a message for the request language. All Chinese regions and scripts share the Simplified Chinese wording.
     *
     * @param locale 请求选择的语言，可为空。 Request locale, which may be null.
     * @return 中文语言标签使用中文提示，其余语言或未指定语言时使用英文。 Chinese for a Chinese locale, English otherwise.
     */
    public String publicMessage(Locale locale) {
        // 匹配主语言，使 zh、zh-CN 和 zh-Hant 等标签映射到同一份中文文案。
        // Match the primary language so zh, zh-CN and zh-Hant all select the Chinese translation.
        if (locale != null && Locale.CHINESE.getLanguage().equals(locale.getLanguage())) {
            return chineseMessage;
        }
        return englishMessage;
    }
}

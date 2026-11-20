package io.ggboy.common.api;

import java.util.Locale;
import java.util.Objects;

/**
 * 可返回给客户端的错误码与固定消息，由同一错误码派生以保持一致。
 * Client-facing error code and fixed message, derived from a single code for consistency.
 */
public final class ApiError {

    /** 对应的公开错误分类。 Public error category for this failure. */
    private final ErrorCode code;

    /** 创建本次响应时选定的公开提示。 Public message selected for this response at creation time. */
    private final String message;

    /**
     * 创建使用默认英文提示的错误详情。
     * Creates error details with the default English message.
     *
     * @param code 已声明的公开错误码。 Declared public error code.
     * @throws NullPointerException 错误码为空。 The error code is null.
     */
    public ApiError(ErrorCode code) {
        this(code, Locale.ENGLISH);
    }

    /**
     * 创建指定语言的错误详情。异常详情留给服务端日志。
     * Creates error details for a request locale. Internal exception details belong in server logs.
     *
     * @param code 已声明的公开错误码。 Declared public error code.
     * @param locale 请求语言，未指定时使用英文。 Request locale, falling back to English if absent.
     * @throws NullPointerException 错误码为空。 The error code is null.
     */
    public ApiError(ErrorCode code, Locale locale) {
        this.code = Objects.requireNonNull(code, "code");
        // 把语言选择保存在本次响应中，避免后续请求改变已经选好的文案。
        // Capture the translation in this response so later requests cannot change the selected message.
        this.message = code.publicMessage(locale);
    }

    /**
     * 返回客户端可据以选择处理方式的稳定错误码。
     * Returns the stable error code clients use to select a handling strategy.
     *
     * @return 公开错误码。 Public error code.
     */
    public ErrorCode getCode() {
        return code;
    }

    /**
     * 返回为本次请求选择的公开消息。
     * Returns the public message selected for this request.
     *
     * @return 与错误码和请求语言对应的提示。 Message for the error code and request language.
     */
    public String getMessage() {
        return message;
    }
}

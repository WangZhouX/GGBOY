package io.ggboy.common.api;

import java.util.Locale;

/**
 * GGBOY 业务 API 的响应，成功时携带数据，失败时携带错误。
 * Response from a GGBOY business API, carrying data on success and an error on failure.
 *
 * @param <T> 成功响应的数据类型。 Type of the success payload.
 * @param data 业务数据，失败时为空。 Business payload, null on failure.
 * @param error 客户端可见的错误，成功时为空。 Client-facing error, null on success.
 */
public record ApiResponse<T>(T data, ApiError error) {

    /**
     * 校验成功和失败互斥。空列表也属于有效的成功数据。
     * Ensures that success and failure are mutually exclusive. An empty list is valid data.
     *
     * @param data 成功响应的数据。 Payload for a successful response.
     * @param error 失败响应的公开错误。 Public error for a failed response.
     * @throws IllegalArgumentException 数据和错误同时为空或同时存在。 Both components are absent or both are present.
     */
    public ApiResponse {
        // 只有一项有值时，客户端才能从同一个响应结构明确区分成功和失败。
        // Exactly one populated field lets clients distinguish success from failure in the same response shape.
        if ((data == null) == (error == null)) {
            throw new IllegalArgumentException("Exactly one of data and error must be present");
        }
    }

    /**
     * 创建携带业务数据的成功响应。
     * Creates a successful response containing business data.
     *
     * @param <T> 数据类型。 Payload type.
     * @param data 要返回的非空数据。 Non-null payload to return.
     * @return 成功响应。 Successful response.
     * @throws IllegalArgumentException 数据为空。 The payload is null.
     */
    public static <T> ApiResponse<T> success(T data) {
        return new ApiResponse<>(data, null);
    }

    /**
     * 使用默认英文提示创建失败响应。
     * Creates a failure with the default English message.
     *
     * @param <T> 对应成功响应的数据类型。 Payload type of the corresponding success response.
     * @param code 用于客户端处理的错误码。 Error code for client handling.
     * @return 仅含公开错误的失败响应。 Failed response containing the public error.
     * @throws NullPointerException 错误码为空。 The error code is null.
     */
    public static <T> ApiResponse<T> failure(ErrorCode code) {
        return failure(code, Locale.ENGLISH);
    }

    /**
     * 使用请求语言创建失败响应，错误标识在各语言之间保持一致。
     * Creates a failure in the request language with the same error identifier across languages.
     *
     * @param <T> 对应成功响应的数据类型。 Payload type of the corresponding success response.
     * @param code 客户端可以据以处理错误的稳定错误码。 Stable error code for client handling.
     * @param locale 请求语言，未指定或不受支持时使用英文。 Request locale, falling back to English if absent or unsupported.
     * @return 携带错误码和本地化提示的失败响应。 Failure containing the code and its localized message.
     * @throws NullPointerException 错误码为空。 The error code is null.
     */
    public static <T> ApiResponse<T> failure(ErrorCode code, Locale locale) {
        return new ApiResponse<>(null, new ApiError(code, locale));
    }
}

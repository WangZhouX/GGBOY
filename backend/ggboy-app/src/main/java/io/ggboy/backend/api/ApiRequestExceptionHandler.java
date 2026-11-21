package io.ggboy.backend.api;

import io.ggboy.backend.GgboyBackendApplication;
import io.ggboy.common.api.ApiResponse;
import io.ggboy.common.api.ErrorCode;
import java.util.Locale;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * 将 GGBOY 业务控制器的请求输入错误转换为公共 API 响应。
 * Maps request input errors from GGBOY business controllers to the shared API response.
 */
@RestControllerAdvice(basePackageClasses = GgboyBackendApplication.class)
public class ApiRequestExceptionHandler {

    /**
     * 对缺失参数、类型转换失败、参数校验失败或不可读的请求体返回 HTTP 400。
     * Returns HTTP 400 for missing parameters, type mismatches, invalid arguments or unreadable bodies.
     *
     * @param locale 本次请求协商出的消息语言。 Message language negotiated for this request.
     * @return 带有稳定错误码、对应语言提示及语言响应头的 HTTP 400 响应。 HTTP 400 with the stable code, localized message and language headers.
     */
    @ExceptionHandler({
            MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class,
            MethodArgumentNotValidException.class,
            HttpMessageNotReadableException.class
    })
    public ResponseEntity<ApiResponse<Void>> invalidRequest(Locale locale) {
        return errorResponse(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REQUEST, locale);
    }

    /**
     * 用协商语言组装统一错误响应，供参数绑定处理器和业务控制器共用。
     * Builds the same localized error response for request binding handlers and business controllers.
     *
     * @param status 错误对应的 HTTP 状态。 HTTP status for this error.
     * @param code 稳定的公开业务错误码。 Stable public business error code.
     * @param locale 请求协商出的错误消息语言。 Error language negotiated for the request.
     * @param <T> 接口成功时的数据类型。 Type of the endpoint's success payload.
     * @return 含公开文案、错误码和语言响应头的错误响应。 Error response with a public message, code, and language headers.
     */
    public static <T> ResponseEntity<ApiResponse<T>> errorResponse(HttpStatus status, ErrorCode code, Locale locale) {
        // 同一 URL 的错误表示随请求语言变化，向客户端及缓存声明实际语言和协商维度。
        // Report the selected language and tell caches that this URL's representation varies by language.
        return ResponseEntity.status(status)
                .header(HttpHeaders.CONTENT_LANGUAGE, locale.toLanguageTag())
                .varyBy(HttpHeaders.ACCEPT_LANGUAGE)
                .body(ApiResponse.failure(code, locale));
    }
}

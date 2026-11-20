package io.ggboy.common.api;

import java.util.List;
import java.util.Locale;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 验证业务 API 的公开响应契约。 Verifies the public response contract of the business APIs. */
class ApiResponseTest {

    /** 空集合表示查询成功且没有匹配项。 An empty collection represents a successful query with no matches. */
    @Test
    void emptyListIsSuccessfulData() {
        // 模拟没有匹配记录的活动页数据。 Simulate an activity page with no matching records.
        var response = ApiResponse.success(List.of());
        assertEquals(List.of(), response.data());
        assertNull(response.error());
    }

    /** 每个响应必须在业务数据和公开错误中恰好提供一项。 Each response must provide exactly one of business data or a public error. */
    @Test
    void exactlyOneOfDataAndErrorIsRequired() {
        assertThrows(IllegalArgumentException.class, () -> new ApiResponse<>(null, null));
        assertThrows(IllegalArgumentException.class,
                () -> new ApiResponse<>("data", new ApiError(ErrorCode.INVALID_REQUEST)));
    }

    /** 失败响应返回稳定错误码与对应的公开消息。 A failure returns a stable code and its public message. */
    @Test
    void failureContainsOnlyThePublicError() {
        // 构造请求无效时客户端收到的失败响应。 Build the failure sent to clients for an invalid request.
        var response = ApiResponse.failure(ErrorCode.INVALID_REQUEST);
        assertNull(response.data());
        assertEquals(ErrorCode.INVALID_REQUEST, response.error().getCode());
        assertEquals("The request is invalid.", response.error().getMessage());
    }

    /**
     * 检验每个错误码的两种公开提示及错误码本身。
     * Verifies both translations and the stable identifier for each error code.
     *
     * @param code 正在验证的公共错误码。 Public error code under test.
     * @param chinese 期望的简体中文提示。 Expected Simplified Chinese message.
     * @param english 期望的英文提示。 Expected English message.
     */
    @ParameterizedTest
    @CsvSource({
            "INVALID_REQUEST,请求参数无效。,The request is invalid.",
            "NOT_FOUND,请求的资源不存在。,The requested resource was not found.",
            "INTERNAL_ERROR,服务端无法完成请求。,The request could not be completed."
    })
    void translationsAreScopedToEachErrorResponse(ErrorCode code, String chinese, String english) {
        // 依次构造两个语言不同的响应，再检查两者，验证一个请求不会影响另一个。
        // Create responses for different languages before reading them to verify that one request cannot affect another.
        var chineseError = ApiResponse.failure(code, Locale.SIMPLIFIED_CHINESE).error();
        // 英美地区使用同一份英文文案。 English-speaking regions share the same English wording.
        var englishError = ApiResponse.failure(code, Locale.US).error();
        assertEquals(code, chineseError.getCode());
        assertEquals(code, englishError.getCode());
        assertEquals(chinese, chineseError.getMessage());
        assertEquals(english, englishError.getMessage());
        assertEquals(english, new ApiError(code).getMessage());
        assertEquals(english, code.publicMessage());
    }

    /** 地区和书写系统均不改变中文选择。 Region and script subtags preserve selection of the Chinese translation. */
    @Test
    void chineseLanguageVariantsShareTheChineseMessage() {
        assertEquals("请求参数无效。", ErrorCode.INVALID_REQUEST.publicMessage(Locale.CHINESE));
        assertEquals("请求参数无效。", ErrorCode.INVALID_REQUEST.publicMessage(Locale.forLanguageTag("zh-Hant-TW")));
    }

    /** 不受支持或缺失的语言使用默认英文。 Unsupported or missing locales fall back to English. */
    @Test
    void unsupportedAndMissingLocalesUseEnglish() {
        assertEquals("The requested resource was not found.", ApiResponse.failure(ErrorCode.NOT_FOUND, Locale.FRENCH).error().getMessage());
        assertEquals("The requested resource was not found.", ApiResponse.failure(ErrorCode.NOT_FOUND, null).error().getMessage());
    }
}

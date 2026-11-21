package io.ggboy.backend.api;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 使用真实 HTTP 请求验证错误语言协商。 Verifies error language negotiation through real HTTP requests. */
class ApiErrorLanguageTest {

    /**
     * 在同一服务进程依次请求不同语言，验证语言选择以及缺失或不支持的语言的回退行为。
     * Requests different languages from one server to verify selection and fallback for missing or unsupported languages.
     *
     * @throws IOException 发生网络错误。 A network error occurs.
     * @throws InterruptedException 等待 HTTP 响应时线程被中断。 The thread is interrupted while waiting for a response.
     */
    @Test
    void negotiatesEachErrorUsingTheRequestHeader() throws IOException, InterruptedException {
        // 仅启用测试端点，在临时环回端口加载真实 MVC 配置，跳过与错误响应无关的数据库启动流程。
        // Enable the test endpoint on an ephemeral loopback port with real MVC wiring and skip database startup.
        try (var context = SpringApplication.run(HttpTestConfiguration.class,
                "--spring.profiles.active=error-language-test", "--server.address=127.0.0.1", "--server.port=0",
                "--spring.autoconfigure.exclude=org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration,"
                        + "org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration");
             var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
            // 省略必填参数，让每次请求都经过生产的 HTTP 400 处理器。
            // Omit the required parameter so each request passes through the production HTTP 400 handler.
            var endpoint = URI.create("http://127.0.0.1:" + context.getEnvironment().getRequiredProperty("local.server.port")
                    + "/__test/error-language");
            assertError(client, endpoint, "zh-CN", "zh", "请求参数无效。");
            assertError(client, endpoint, "en-US", "en", "The request is invalid.");
            assertError(client, endpoint, "fr, en;q=0.3, zh;q=0.8", "zh", "请求参数无效。");
            assertError(client, endpoint, "fr-FR", "en", "The request is invalid.");
            assertError(client, endpoint, null, "en", "The request is invalid.");
        }
    }

    /**
     * 检查请求的状态、协商响应头和公开错误字段。
     * Checks the status, negotiation headers and public error fields of a request.
     *
     * @param client 本测试共享的 HTTP 客户端。 HTTP client shared within this test.
     * @param endpoint 会触发参数校验错误的本地地址。 Local endpoint that triggers a binding error.
     * @param preference 语言偏好，空引用表示不发送语言头。 Language preference, or null to omit the header.
     * @param language 期望的错误消息语言标签。 Expected language tag of the error message.
     * @param message 期望的公开译文。 Expected public translation.
     * @throws IOException 发生网络错误。 A network error occurs.
     * @throws InterruptedException 等待 HTTP 响应时线程被中断。 The thread is interrupted while waiting for the response.
     */
    private static void assertError(HttpClient client, URI endpoint, String preference, String language, String message)
            throws IOException, InterruptedException {
        // 直接发送请求头，以便由 Servlet 容器按质量权重解析语言顺序。
        // Send the header on the wire so the servlet container parses languages in quality-weight order.
        var request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(10));
        if (preference != null) {
            request.header("Accept-Language", preference);
        }
        // 明确按 UTF-8 解码响应，以便逐字验证中文消息。
        // Decode explicitly as UTF-8 to verify the Chinese message character by character.
        var response = client.send(request.GET().build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        assertEquals(400, response.statusCode());
        assertEquals(language, response.headers().firstValue("Content-Language").orElseThrow());
        assertTrue(response.headers().allValues("Vary").stream()
                .flatMap(value -> java.util.Arrays.stream(value.split(",")))
                .anyMatch(value -> value.strip().equalsIgnoreCase("Accept-Language")));
        // 分别验证稳定代码和译文，允许 JSON 字段顺序变化。
        // Assert code and message independently of JSON property order.
        var error = JsonMapper.shared().readTree(response.body()).get("error");
        assertEquals("INVALID_REQUEST", error.get("code").asString());
        assertEquals(message, error.get("message").asString());
    }

    /**
     * 引入生产的语言和错误配置以及测试控制器，在隔离的上下文中运行 MVC。
     * Imports the production locale and error configurations with the probe controller in an isolated MVC context.
     */
    @EnableAutoConfiguration
    @Import({ApiLocaleConfiguration.class, ApiRequestExceptionHandler.class, RequiredParameterController.class})
    static class HttpTestConfiguration {
    }

    /** 仅在此测试的 profile 中注册请求入口。 Registers the probe endpoint only in this test's profile. */
    @RestController
    @Profile("error-language-test")
    static class RequiredParameterController {

        /**
         * 声明必填参数，供绑定阶段在执行方法前产生错误。
         * Declares a required parameter so binding can fail before the method runs.
         *
         * @param network 请求的网络标识。 Requested network identifier.
         * @return 绑定成功的网络标识。 Network identifier after successful binding.
         */
        @GetMapping("/__test/error-language")
        String requireNetwork(@RequestParam("network") String network) {
            return network;
        }
    }
}

package io.ggboy.backend.api;

import java.util.List;
import java.util.Locale;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.i18n.AcceptHeaderLocaleResolver;

/**
 * 为业务错误消息配置 HTTP 请求的语言协商。
 * Configures HTTP request language negotiation for business API error messages.
 */
@Configuration(proxyBeanMethods = false)
public class ApiLocaleConfiguration {

    /**
     * 从 Accept-Language 中选取客户端优先级最高的受支持语言。
     * Selects the client's highest-priority supported language from Accept-Language.
     *
     * @return 支持中文、英文且默认使用英文的解析器。 Resolver supporting Chinese and English with an English fallback.
     */
    @Bean
    public AcceptHeaderLocaleResolver localeResolver() {
        // 使用 Spring MVC 的请求头解析器，让每个请求携带自己的语言偏好。
        // The Spring MVC header resolver reads each request's own language preferences.
        var resolver = new AcceptHeaderLocaleResolver();
        // 注册不含地区的语言，使 zh-CN、zh-Hans 和 en-US 等标签能匹配对应译文。
        // Language-only entries match regional and script tags such as zh-CN, zh-Hans and en-US.
        resolver.setSupportedLocales(List.of(Locale.CHINESE, Locale.ENGLISH));
        // 未发送语言或无法匹配时沿用原有英文消息，与服务器的默认语言无关。
        // Preserve the original English response for missing or unsupported preferences on any host.
        resolver.setDefaultLocale(Locale.ENGLISH);
        return resolver;
    }
}

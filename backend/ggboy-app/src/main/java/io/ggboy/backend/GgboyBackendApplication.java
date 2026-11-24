package io.ggboy.backend;

import io.swagger.v3.oas.annotations.OpenAPIDefinition;
import io.swagger.v3.oas.annotations.info.Info;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * GGBOY 后端应用的启动入口。
 * Starts the GGBOY backend application.
 *
 * <p>各个索引任务单独由配置启用。 The configuration enables each scheduled indexer independently.
 */
@SpringBootApplication
@EnableScheduling
@OpenAPIDefinition(info = @Info(
        title = "GGBOY 后端 API",
        version = "v1",
        description = "策略金库、借贷市场和交易活动的查询接口。"
))
public class GgboyBackendApplication {

    /**
     * 创建 Spring 上下文并启动 Web 服务。
     * Creates the Spring context and starts the web server.
     *
     * @param args Spring Boot 命令行配置参数。 Spring Boot configuration arguments.
     */
    public static void main(String[] args) {
        SpringApplication.run(GgboyBackendApplication.class, args);
    }
}

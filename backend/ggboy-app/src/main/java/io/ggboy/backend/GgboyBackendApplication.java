package io.ggboy.backend;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * GGBOY 后端应用的启动入口。
 * Starts the GGBOY backend application.
 */
@SpringBootApplication
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

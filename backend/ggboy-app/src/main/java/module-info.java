/**
 * 装配 GGBOY 的 Web、数据库和索引服务。
 * Wires GGBOY's web, database and indexing services.
 */
module io.ggboy.app {
    requires io.ggboy.common;
    requires io.ggboy.core;
    // 运行时框架也会加载 JDBC、XML 和 instrumentation 等标准模块。
    // Runtime frameworks also load standard modules such as JDBC, XML and instrumentation.
    requires java.se;
    requires org.mybatis;
    requires com.baomidou.mybatis.plus.core;
    requires com.baomidou.mybatis.plus.annotation;
    requires spring.boot;
    requires spring.boot.autoconfigure;
    requires spring.context;
    requires spring.web;
    requires spring.webmvc;

    // Spring 通过反射构造启动配置和 HTTP 异常处理器。
    // Spring reflectively constructs the application configuration and HTTP exception handlers.
    opens io.ggboy.backend;
    opens io.ggboy.backend.api;

    // 仅向持久化框架开放 DO，由其读取列注解并调用 record 的构造方法。
    // Open DO packages to the persistence frameworks for column inspection and record construction.
    opens io.ggboy.backend.entity to org.mybatis, com.baomidou.mybatis.plus.core;
}

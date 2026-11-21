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
    // 金库快照和交易批次使用 MyBatis-Plus Page 和 PostgreSQL 分页方言。
    // Vault snapshots and transaction batches use MyBatis-Plus Page and its PostgreSQL pagination dialect.
    requires com.baomidou.mybatis.plus.extension;
    requires com.baomidou.mybatis.plus.spring;
    // 控制器声明由 springdoc 读取的接口名称、分组及请求参数。
    // Controllers declare API names, groups and request parameters read by springdoc.
    requires io.swagger.v3.oas.annotations;
    requires spring.boot;
    requires spring.boot.autoconfigure;
    // 服务实例与事务代理使用 Spring 的反射、Bean 和 AOP 模块。
    // Service construction and transactional proxies use Spring's reflection, bean and AOP modules.
    requires spring.core;
    requires spring.beans;
    requires spring.aop;
    requires spring.context;
    // 金库和活动查询用只读事务保持多表读取的一致性。
    // Vault and activity queries use read-only transactions for consistent reads across tables.
    requires spring.tx;
    requires spring.web;
    requires spring.webmvc;

    // Spring 通过反射构造启动配置和 HTTP 异常处理器。
    // Spring reflectively constructs the application configuration and HTTP exception handlers.
    opens io.ggboy.backend;
    opens io.ggboy.backend.api;

    // Spring 创建控制器实例，MVC 通过反射读取请求映射并调用处理方法。
    // Spring instantiates controllers and MVC reads request mappings and invokes handlers reflectively.
    opens io.ggboy.backend.controller to spring.core, spring.beans, spring.web, spring.webmvc;

    // Mapper 接口供 MyBatis 代理与位于 classpath 的 Spring 集成组件访问。
    // Allow MyBatis proxies and the classpath-based Spring integration to access mapper interfaces.
    opens io.ggboy.backend.mapper;

    // Spring 使用反射创建服务实例和事务代理。
    // Spring uses reflection to construct service instances and transactional proxies.
    // 显式打开服务接口，供接口事务代理反射调用。
    // Open the service interfaces for reflective invocation by transaction proxies.
    opens io.ggboy.backend.service to spring.core, spring.aop;
    opens io.ggboy.backend.service.impl to spring.core, spring.beans, spring.aop;

    // 仅向持久化框架开放 DO，由其读取列注解并调用 record 的构造方法。
    // Open DO packages to the persistence frameworks for column inspection and record construction.
    opens io.ggboy.backend.entity to org.mybatis, com.baomidou.mybatis.plus.core;
}

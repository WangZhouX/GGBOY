/**
 * 基础类型与无框架依赖的公用函数。
 * Shared types and utilities without framework dependencies.
 */
module io.ggboy.common {
    // 请求与响应类型供各业务接口共享。
    // Business endpoints share the request and response types in this package.
    exports io.ggboy.common.api;
    // 核心模块与应用层复用相同的无符号数值边界。
    // The core and application modules share the same unsigned numeric bounds.
    exports io.ggboy.common.utils;
}

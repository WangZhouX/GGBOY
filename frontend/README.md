# GGBOY 前端

使用 React、TypeScript、Vite、React Router、TanStack Query 和 i18next。当前骨架包含响应式导航、借贷子路由、交易回执路由、中英文切换、网络选择和公共 HTTP 请求层。[策略金库页](src/pages/vault/README.md)已接入公开概况、钱包份额查询和每份净值走势，页面顶部可通过 [Phantom](src/solana/README.md) 连接钱包。

## 本地开发

使用 Node.js 22.12+（22.x）或 Node.js 24+，在本目录运行：

```sh
npm ci
npm run dev
```

打开终端显示的本地地址。可以切换中英文、选择 Localnet 或 Devnet，再依次打开金库、借贷和交易活动入口。

## 源码结构与阅读顺序

```text
src/
├── main.tsx     React 挂载入口
├── app/        应用装配、路由、全站布局、国际化和全局样式
├── pages/      每条业务路由对应的页面，按业务分目录
├── features/   业务专用组件、查询和交互
├── shared/     公共 UI、HTTP 客户端、接口类型和网络导航
└── solana/     钱包、RPC 和交易接入边界
```

1. [main.tsx](src/main.tsx) 将 React 挂到 HTML 的 #root 节点。
2. [App.tsx](src/app/App.tsx) 装配全站 Provider。[AppRoutes.tsx](src/app/AppRoutes.tsx) 把 URL 对到具体页面。
3. [页面索引](src/pages/README.md) 列出资产总览、策略金库、借贷、策略管理、交易活动与回执的入口。
4. [业务模块](src/features/README.md) 放同一业务复用的部分，例如借贷子导航。页面决定组合哪些业务组件。
5. [公共模块](src/shared/README.md) 提供 API、组件和站内链接。接业务查询时，在查询键中包含网络、资源地址及查询个人仓位所需的钱包地址。

## 后端接口

Vite 开发和预览服务器都把相对路径 `/api` 转发给 Spring Boot。前端和后端都在 WSL 运行时，在本目录的 `.env.local` 配置：

```dotenv
GGBOY_API_PROXY_TARGET=http://127.0.0.1:8080
```

地址由 Vite 进程访问。浏览器打开前端地址，继续向同源的 `/api` 发请求。Vite 直接在 Windows 运行、后端仍在 WSL 时，可把代理目标改为 Windows 能访问的 WSL 地址和后端端口。修改 `.env.local` 后重启 Vite。这个文件由 Git 忽略，未配置时默认使用 `http://127.0.0.1:8080`。

部署静态产物时，将同源 `/api` 交给后端代理，并为页面路由配置回退到 `index.html`。

请求按当前界面语言设置 `Accept-Language`。前端按稳定的 `error.code` 决定错误处理，按 `error.message` 显示后端文案。参见[公共响应契约](../backend/ggboy-common/src/main/java/io/ggboy/common/api/README.md)。

接口类型保存在 [schema.d.ts](src/shared/api/schema.d.ts)，来源是后端的 OpenAPI JSON。正常构建使用版本库中的类型。后端 Swagger 在默认端口运行时，用下面的命令刷新类型：

```sh
npm run api:types
```

## 构建验证

```sh
npm run typecheck
npm run build
npm run preview
```

`build` 先做 TypeScript 检查，再将静态产物输出到 `dist/`，并复制 `public/` 中的站点图标。`preview` 用本地服务预览该产物。源码模块关系见 [src](src/README.md)，钱包和交易接入边界见 [solana](src/solana/README.md)。

[项目架构](../README.md) · [后端](../backend/README.md) · [链上程序](../onchain/README.md)

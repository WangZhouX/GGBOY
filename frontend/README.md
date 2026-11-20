# GGBOY 前端

使用 React、TypeScript 和 Vite 构建界面。页面按资产总览、策略金库、借贷市场、策略管理和交易活动组织。

前端通过 Solana RPC 和 Anchor IDL 读取账户、构造并预览交易，由用户在 Phantom 中签名。界面从后端查询历史记录和净值快照，余额、份额和债务以链上状态为准。

接入后端业务 API 时，每次请求都从当前界面语言设置 `Accept-Language`。例如选择中文后发送 `Accept-Language: zh-CN`，选择英文后发送 `Accept-Language: en`。前端展示服务端返回的 `error.message`，用稳定的 `error.code` 决定如何处理错误。详见[公共响应契约](../backend/ggboy-common/src/main/java/io/ggboy/common/api/README.md)。

## 本地开发

使用 Node.js 22.12+（22.x）或 Node.js 24+，在本目录运行：

```sh
npm ci
npm run dev
```

打开终端显示的本地地址，应看到 GGBOY 入口页。页面可独立运行，依赖 React DOM；钱包、Solana RPC 和后端接口将在业务开发阶段接入。

## 构建验证

```sh
npm run typecheck
npm run build
npm run preview
```

`build` 先执行 TypeScript 类型检查，再将前端静态产物输出到 `dist/`。`preview` 使用本地服务预览该产物。

## 目录与入口

- `index.html` 提供 HTML 入口和 React 挂载点。
- [src/](src/README.md) 包含 React 入口组件、全局样式和后续业务模块。
- `vite.config.ts` 配置 React 插件，`tsconfig.json` 记录类型检查选项。

[项目架构](../README.md) · [后端](../backend/README.md) · [链上程序](../onchain/README.md)

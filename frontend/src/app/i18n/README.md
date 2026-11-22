# 国际化

[i18n.ts](i18n.ts) 组装 i18next，加载 [messages.ts](messages.ts) 中的简体中文和英文。应用入口等待语言资源准备好后再挂载 React。切换语言时同步 HTML 的 lang 属性和浏览器偏好。

页面和业务组件通过 useTranslation 读取文案。HTTP 请求可以通过 [API 客户端](../../shared/api/README.md)的语言回调复用当前选择。

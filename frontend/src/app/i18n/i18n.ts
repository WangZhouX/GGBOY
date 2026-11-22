import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { messages } from './messages';
import { readPreference, writePreference } from '../../shared/preferences';

/** 与后端语言协商一致的语言值。 Language tags compatible with backend negotiation. */
export const languages = ['zh-CN', 'en'] as const;

/** 由翻译选择器和 API 请求共用的语言类型。 Language type shared by the selector and API requests. */
export type Language = (typeof languages)[number];

/** 浏览器语言偏好存储键。 Storage key for the browser's language preference. */
const languagePreferenceKey = 'ggboy.language';

/**
 * 缩小任意语言字符串到当前站点支持的值。
 * Narrow a language string to one of the languages available in the app.
 *
 * @param value 浏览器偏好或翻译库解析出的语言。 Language returned by preferences or the translation library.
 * @returns 可用于翻译和请求标头的语言标记。 Language tag suitable for translations and request headers.
 */
export function resolveLanguage(value: string | null | undefined): Language {
  return value === 'en' ? 'en' : 'zh-CN';
}

/** 独立的 GGBOY 翻译实例。 Translation instance owned by GGBOY. */
export const i18n = createInstance();

// 在初始化与切换时同步文档语言和用户偏好。
// Keep the document language and user preference in sync on initialization and on switches.
i18n.on('languageChanged', (language: string) => {
  /** 写入文档及存储前先收敛到应用实际支持的标签。 Normalize the tag before updating the document and storage. */
  const selectedLanguage = resolveLanguage(language);
  document.documentElement.lang = selectedLanguage;
  writePreference(languagePreferenceKey, selectedLanguage);
});

/** 入口页面等待此 Promise 完成后挂载 React。 The entry waits for this Promise before mounting React. */
export const i18nReady = i18n.use(initReactI18next).init({
  resources: messages,
  lng: resolveLanguage(readPreference(languagePreferenceKey)),
  supportedLngs: languages,
  fallbackLng: 'zh-CN',
  interpolation: {
    // 交给 React 对渲染文本做转义，避免翻译中的变量被转义两次。
    // Let React escape rendered text to avoid double escaping interpolated values.
    escapeValue: false,
  },
});

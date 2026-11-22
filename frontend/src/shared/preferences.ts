/**
 * 从当前浏览器读取一项非敏感界面偏好。
 * Read a single nonsensitive interface preference from the browser.
 *
 * @param key 偏好在当前站点下的存储键。 Storage key within this site's origin.
 * @returns 已保存的值，存储被限制或尚未设置时为空。 Stored value, or null if unavailable or unset.
 */
export function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // 部分浏览器策略会禁止本地存储，界面仍可使用默认值或 URL。
    // Browser policies may block local storage, so the UI can still use defaults or the URL.
    return null;
  }
}

/**
 * 保存一项非敏感界面偏好，页面能够在浏览器禁用存储时继续运行。
 * Store a nonsensitive interface preference while keeping the UI usable if storage is disabled.
 *
 * @param key 偏好在当前站点下的存储键。 Storage key within this site's origin.
 * @param value 需要记住的语言或网络选择。 Language or network selection to remember.
 */
export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 持久化是便利功能，失败时仍由当前页面的状态提供选择。
    // Persistence is a convenience. The current page state still holds the selection.
  }
}

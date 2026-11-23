import { Buffer } from 'buffer';

// SPL Token 的部分浏览器编解码直接使用 Buffer，全站启动时提供浏览器实现。
// Some SPL Token browser codecs use Buffer directly, so expose the browser implementation at app startup.
if (typeof globalThis.Buffer === 'undefined') {
  Object.defineProperty(globalThis, 'Buffer', { value: Buffer, writable: true, configurable: true });
}

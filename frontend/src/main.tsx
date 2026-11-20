import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * HTML 入口中用于挂载 React 应用的节点。
 * Mount node declared by the HTML entry point.
 */
const rootElement = document.getElementById('root');

// 在挂载点缺失时立即暴露页面配置错误。
// Fail early when the HTML entry is missing its mount node.
if (!rootElement) {
  throw new Error('GGBOY mount node #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

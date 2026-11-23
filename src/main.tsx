// src/main.tsx — 应用入口：挂载 React、注入控制台自测函数与全局样式

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './ui/App';
import { runCameraSelfTest } from './camera/selfTest';
import { useCameraStore } from './store/useCameraStore';
import './styles.css';

(window as unknown as { __cameraSelfTest: typeof runCameraSelfTest }).__cameraSelfTest = runCameraSelfTest;
// 调试入口：README 中承诺的 window.__cameraStore 之前一直没真正挂载，控制台/脚本无法读写状态。
(window as unknown as { __cameraStore: typeof useCameraStore }).__cameraStore = useCameraStore;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

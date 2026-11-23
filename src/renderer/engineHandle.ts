// src/renderer/engineHandle.ts — 引擎句柄（让任意 UI 组件都能调用引擎方法，而不必依赖 window 全局）

import type { CameraEngine } from './CameraEngine';

let current: CameraEngine | null = null;

export function setEngineHandle(engine: CameraEngine | null): void {
  current = engine;
}

export function getEngine(): CameraEngine | null {
  return current;
}

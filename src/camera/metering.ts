// src/camera/metering.ts — 测光逻辑：从直方图/像素统计推导场景 EV 与建议曝光

import { shutterForEV, relativeLuminance, clamp } from './physics';
import type { MeteringMode, MeteringResult } from '../types/camera';

export interface LuminanceRegion {
  // 亮度采样网格：width×height 的线性亮度数组（0..∞），由渲染管线提供
  width: number;
  height: number;
  data: Float32Array;
}

/** 18% 灰标定：测光目标线性亮度（中灰） */
const MID_GREY = 0.18;

function regionLuminance(grid: LuminanceRegion, mode: MeteringMode, point?: { x: number; y: number }): number {
  const { width: w, height: h, data } = grid;
  let sum = 0;
  let count = 0;
  const sample = (x: number, y: number, weight = 1) => {
    const px = clamp(Math.floor(x), 0, w - 1);
    const py = clamp(Math.floor(y), 0, h - 1);
    sum += data[py * w + px] * weight;
    count += weight;
  };
  if (mode === 'spot') {
    // 点测光：中心 2% 区域（或指定焦点）
    const cx = point ? point.x * w : w / 2;
    const cy = point ? point.y * h : h / 2;
    const r = Math.max(1, Math.round(Math.min(w, h) * 0.07));
    for (let y = Math.floor(cy - r); y <= cy + r; y += 2)
      for (let x = Math.floor(cx - r); x <= cx + r; x += 2) sample(x, y);
  } else if (mode === 'center') {
    // 中央重点：加权中心 60% 区域
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        const dx = (x / w - 0.5) * 2;
        const dy = (y / h - 0.5) * 2;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.75) sample(x, y, 1.5 - d);
      }
  } else {
    // 评价测光：全画面加权，略偏中心
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        const dx = x / w - 0.5;
        const dy = y / h - 0.5;
        sample(x, y, 1 - 0.5 * Math.sqrt(dx * dx + dy * dy));
      }
  }
  return count > 0 ? sum / count : MID_GREY;
}

/**
 * 根据测光亮度计算场景 EV：
 *   18% 灰映射：L = 2^EV · MID_GREY  →  EV = log2(L / MID_GREY)
 * L 为未施加曝光增益的“场景亮度”（渲染管线提供）。
 */
export function meterScene(
  grid: LuminanceRegion,
  mode: MeteringMode,
  aperture: number,
  iso: number,
  focusPoint?: { x: number; y: number },
): MeteringResult {
  const luminance = Math.max(1e-6, regionLuminance(grid, mode, focusPoint));
  const sceneEV = Math.log2(luminance / MID_GREY);
  const suggestedShutter = shutterForEV(sceneEV, aperture, iso);
  return { ev: sceneEV, suggestedShutter, luminance };
}

export { relativeLuminance };

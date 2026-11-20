// src/camera/whiteBalance.ts — 色温 ↔ RGB 的近似模型（黑体轨迹查表 + 线性插值）
// 两个函数职责严格分离：
//   kelvinToRGB    = 光源自身的颜色（用于场景灯光，低色温偏橙、高色温偏蓝）
//   whiteBalanceGain = 相机为还原该光源到 D65 白点而施加的增益（低色温需要加强蓝通道）

const KELVIN_TABLE: Array<[number, number, number]> = [
  // [K, G, B] — R 归一化为 1 的简化黑体轨迹（Lowell/MIT 色温查表）
  [1000, 0.026, 0.000], [1500, 0.227, 0.000], [2000, 0.419, 0.000],
  [2500, 0.563, 0.048], [3000, 0.655, 0.152], [3500, 0.721, 0.255],
  [4000, 0.767, 0.350], [4500, 0.800, 0.439], [5000, 0.826, 0.520],
  [5500, 0.849, 0.593], [6000, 0.868, 0.659], [6500, 0.884, 0.719],
  [7000, 0.898, 0.772], [7500, 0.909, 0.819], [8000, 0.919, 0.860],
  [8500, 0.927, 0.896], [9000, 0.934, 0.928], [10000, 0.943, 0.974],
  [12000, 0.962, 1.000],
];
const D65: [number, number] = [0.884, 0.719]; // 6500K 参考白点

function interpolate(kelvin: number): [number, number] {
  const t = Math.min(12000, Math.max(1000, kelvin));
  let i = 0;
  while (i < KELVIN_TABLE.length - 2 && KELVIN_TABLE[i + 1][0] < t) i++;
  const a = KELVIN_TABLE[i];
  const b = KELVIN_TABLE[i + 1];
  const f = (t - a[0]) / (b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** 光源色：色温 K → RGB（归一化到 D65 白点，G 通道相对量）。低色温偏橙，高色温偏蓝。 */
export function kelvinToRGB(kelvin: number): [number, number, number] {
  const [g, b] = interpolate(kelvin);
  return [1, g / D65[0], b / D65[1]];
}

/** 相机白平衡增益：把当前光源还原到 D65 所需乘性 RGB 增益（归一化到 G=1）。
 * 低色温光源偏橙 → 蓝增益高；高色温偏蓝 → 红相对高。 */
export function whiteBalanceGain(kelvin: number, tint: number): [number, number, number] {
  const [r, g, b] = kelvinToRGB(kelvin);
  const gainR = 1 / Math.max(r, 0.01);
  const gainG = 1 / Math.max(g, 0.01);
  const gainB = 1 / Math.max(b, 0.01);
  const tr = tintToGain(tint);
  return [gainR / gainG * tr[0], 1 * tr[1], gainB / gainG * tr[2]];
}

/** 色调偏移：tint<0 偏绿（G 增益↑），tint>0 偏品红（R/B 增益↓）。 */
function tintToGain(tint: number): [number, number, number] {
  const t = Math.min(1, Math.max(-1, tint / 100));
  if (t < 0) return [1, 1 - t * 0.2, 1];
  return [1 - t * 0.12, 1, 1 - t * 0.12];
}

export const WB_PRESET_TEMP: Record<string, number> = {
  daylight: 5500, cloudy: 6500, tungsten: 3200, fluorescent: 4000, custom: 5500,
};

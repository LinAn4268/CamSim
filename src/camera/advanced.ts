// src/camera/advanced.ts — P1 进阶相机物理的纯函数模型（ND / 闪光 / 防抖 / 果冻效应 / 包围曝光 / HDR）
// 所有函数无副作用、不依赖 DOM；仅复用 physics.ts 的 clamp / log2 基础工具。

import type { CameraSettings, DriveMode, FlashSync, ShutterType } from '../types/camera';
import { clamp, log2 } from './physics';

/**
 * ND 滤镜透光率：T = 2^(−ndStops)。
 * 每加一档 ND，到达传感器的光减半。
 */
export function ndTransmission(ndStops: number): number {
  return Math.pow(2, -ndStops);
}

/**
 * ND 滤镜下的等效曝光时间：t_eff = t · 2^ndStops。
 * 减光 ndStops 档，需要延长同样档数的快门来补偿。
 */
export function effectiveShutter(shutter: number, ndStops: number): number {
  return shutter * Math.pow(2, ndStops);
}

/**
 * 闪光的相对曝光 EV 贡献：
 *   EV_f = P − 2·log2(d) + log2(ISO/100) − 2·log2(N)
 * 其中 P=闪光输出 EV，d=距离（平方反比衰减），N=光圈。
 * 距离下限保护为 0.1m，ISO / 光圈下限保护为正数以避免 log 非有限值。
 */
export function flashExposureEV(flashPowerEV: number, distanceM: number, iso: number, aperture: number): number {
  const d = Math.max(distanceM, 0.1);
  return flashPowerEV - 2 * log2(d) + log2(Math.max(iso, 1) / 100) - 2 * log2(Math.max(aperture, 0.1));
}

/**
 * 闪光同步方式的中文说明。慢于 1/250s 时追加拖影提示。
 */
export function flashSyncDescription(sync: FlashSync, shutter: number): string {
  let text = sync === 'front'
    ? '前帘同步：闪光在曝光开始触发'
    : '后帘同步：闪光在曝光结束触发，运动主体拖影在前';
  if (shutter > 1 / 250) text += '（慢速快门，拖影明显）';
  return text;
}

/**
 * 机身防抖（IBIS）的典型补偿档数：关闭为 0，开启为 4 档。
 */
export function stabilizerStops(enabled: boolean): number {
  return enabled ? 4 : 0;
}

/**
 * 防抖折算后的“等效手持快门”：t_eff = t / 2^N。
 * 安全快门基准为 1/(focal·crop)，开启防抖后放宽 2^N 倍（N 档），
 * 即相机表现得像用了更快的快门一样稳定。此处返回折算后的有效快门秒数。
 */
export function effectiveHandheldShutter(
  shutter: number, focalLength: number, crop: number, stabilization: boolean,
): number {
  // 安全快门基准 1/(focal·crop) 由 isHandheldSafe 使用；此处仅折算快门本身的防抖增益。
  void focalLength;
  void crop;
  return shutter / Math.pow(2, stabilizerStops(stabilization));
}

/**
 * 手持是否安全：shutter ≥ 安全快门 / 2^N，
 * 安全快门 = 1/(focal·crop)，N 为防抖补偿档数。
 */
export function isHandheldSafe(shutter: number, focalLength: number, crop: number, stabilization: boolean): boolean {
  const safe = 1 / (focalLength * crop);
  return shutter >= safe / Math.pow(2, stabilizerStops(stabilization));
}

/**
 * 果冻效应（滚动快门畸变）强度，返回 0..1。
 * 机械快门为全局曝光，恒为 0；电子快门在曝光短于传感器读出时畸变显著：
 *   s = clamp(1 − t / (2·readout), 0, 1)
 * 长曝光（>2×readout）趋近 0，高速快门（<readout）趋近 1。
 */
export function jellyEffectStrength(
  shutterType: ShutterType, shutter: number, sensorReadoutSeconds = 0.04,
): number {
  if (shutterType === 'mechanical') return 0;
  return clamp(1 - shutter / (sensorReadoutSeconds * 2), 0, 1);
}

/**
 * 包围曝光的对称 EV 偏移序列。count 限制为奇数 3..7（偶数向上取奇数），
 * stepEV 限制为 1..3 的整数。例：(3,1)→[-1,0,1]；(5,2)→[-4,-2,0,2,4]。
 */
export function bracketEVs(count: number, stepEV: number): number[] {
  let n = Math.round(clamp(count, 3, 7));
  if (n % 2 === 0) n += 1;
  const step = Math.round(clamp(stepEV, 1, 3));
  const half = (n - 1) / 2;
  const out: number[] = [];
  for (let i = -half; i <= half; i++) out.push(i * step);
  return out;
}

/**
 * HDR 合成中单像素的权重：以中间调为中心的高斯窗，压低死黑 / 死白。
 *   w = exp(−(log2(max(p,1e−4)·2^ev))² / 2)，裁剪到 0..1。
 * 非有限输入返回 0，保证结果确定且有限。
 */
export function hdrMergeWeight(pixelLinear: number, evOffset: number): number {
  if (!Number.isFinite(pixelLinear) || !Number.isFinite(evOffset)) return 0;
  const x = log2(Math.max(pixelLinear, 1e-4) * Math.pow(2, evOffset));
  return clamp(Math.exp(-(x * x) / 2), 0, 1);
}

/**
 * 多曝光线性 RGB 数据合成为单幅 HDR 线性数组。
 * 逐像素以 hdrMergeWeight 为权重，对 data_i / 2^ev_i 做加权平均；
 * 权重和为 0 时该像素取 0。输入为空返回空数组。所有数组长度需一致。
 */
export function mergeHDR(exposures: Array<{ data: Float32Array; evOffset: number }>): Float32Array {
  if (exposures.length === 0) return new Float32Array(0);
  const length = exposures[0].data.length;
  const result = new Float32Array(length);
  for (let p = 0; p < length; p++) {
    let weightSum = 0;
    let valueSum = 0;
    for (const exp of exposures) {
      const pixel = exp.data[p];
      const w = hdrMergeWeight(pixel, exp.evOffset);
      weightSum += w;
      valueSum += (pixel / Math.pow(2, exp.evOffset)) * w;
    }
    result[p] = weightSum > 0 ? valueSum / weightSum : 0;
  }
  return result;
}

/** 斑马纹过曝警告的亮度阈值（线性亮度高于此值显示斑马纹）。 */
export function zebraThreshold(): number {
  return 0.95;
}

/** 驱动模式的中文标签。 */
export function formatDriveMode(mode: DriveMode): string {
  switch (mode) {
    case 'single': return '单张';
    case 'burst': return '连拍';
    case 'timer': return '定时';
    default: return mode;
  }
}

/** P1 进阶参数的默认值集合（供状态初始化使用）。 */
export const DEFAULT_ADVANCED: Pick<
  CameraSettings,
  | 'shutterType' | 'driveMode' | 'burstFrames' | 'timerSeconds'
  | 'bracketingEnabled' | 'bracketFrames' | 'bracketStepEV' | 'hdrEnabled'
  | 'flashEnabled' | 'flashPowerEV' | 'flashSync' | 'stabilization'
  | 'zebra' | 'guides' | 'level' | 'filmSim' | 'lutEnabled' | 'lutName'
> = {
  shutterType: 'mechanical',
  driveMode: 'single',
  burstFrames: 5,
  timerSeconds: 2,
  bracketingEnabled: false,
  bracketFrames: 3,
  bracketStepEV: 1,
  hdrEnabled: false,
  flashEnabled: false,
  flashPowerEV: 0,
  flashSync: 'front',
  stabilization: false,
  zebra: false,
  guides: true,
  level: false,
  filmSim: 'standard',
  lutEnabled: false,
  lutName: 'None',
};

/** 自测项：名称、是否通过、细节说明。 */
export interface AdvancedCheck { name: string; pass: boolean; detail: string }

/**
 * 进阶物理纯函数自测（无 DOM），返回逐项检查结果。
 */
export function runAdvancedSelfTest(): AdvancedCheck[] {
  const checks: AdvancedCheck[] = [];
  const ok = (name: string, cond: boolean, detail: string) => checks.push({ name, pass: cond, detail });

  ok('ND 透光率 3 档=1/8', Math.abs(ndTransmission(3) - 0.125) < 1e-12, `${ndTransmission(3)}`);
  ok('ND 等效快门 2 档×4', Math.abs(effectiveShutter(0.01, 2) - 0.04) < 1e-12, `${effectiveShutter(0.01, 2)}`);
  ok('防抖档数 0/4', stabilizerStops(false) === 0 && stabilizerStops(true) === 4,
    `off=${stabilizerStops(false)}, on=${stabilizerStops(true)}`);

  ok('机械快门无果冻', jellyEffectStrength('mechanical', 1 / 8000) === 0, 'mechanical=0');
  const fastElec = jellyEffectStrength('electronic', 1 / 8000);
  ok('高速电子快门果冻>0', fastElec > 0 && fastElec <= 1, `strength=${fastElec.toFixed(4)}`);

  const b3 = bracketEVs(3, 1);
  ok('包围 3 张对称', b3.length === 3 && b3[0] === -1 && b3[2] === 1, JSON.stringify(b3));
  const b5 = bracketEVs(5, 2);
  ok('包围 5 张步进 2 对称', b5.length === 5 && b5[0] === -4 && b5[4] === 4, JSON.stringify(b5));

  const wFinite = [hdrMergeWeight(0, 0), hdrMergeWeight(1, 1), hdrMergeWeight(-5, 2), hdrMergeWeight(NaN, 0)]
    .every(Number.isFinite);
  ok('HDR 权重有限', wFinite, 'all finite');

  const merged = mergeHDR([{ data: new Float32Array([0.5, 0.25]), evOffset: 0 }]);
  ok('HDR 长度一致', merged.length === 2, `len=${merged.length}`);
  ok('HDR 单曝光保真', Math.abs(merged[0] - 0.5) < 1e-6 && Math.abs(merged[1] - 0.25) < 1e-6,
    `[${merged[0]}, ${merged[1]}]`);
  ok('HDR 空输入', mergeHDR([]).length === 0, 'len=0');

  ok('斑马阈值 0.95', zebraThreshold() === 0.95, `${zebraThreshold()}`);

  const syncFront = flashSyncDescription('front', 1 / 500);
  const syncSlow = flashSyncDescription('rear', 1 / 30);
  ok('闪光同步文案', syncFront === '前帘同步：闪光在曝光开始触发' && syncSlow.includes('慢速快门'), syncSlow);

  ok('驱动模式标签', formatDriveMode('single') === '单张' && formatDriveMode('burst') === '连拍'
    && formatDriveMode('timer') === '定时', '单张/连拍/定时');
  ok('等效手持快门', effectiveHandheldShutter(1 / 60, 50, 1, true) === (1 / 60) / 16, '1/60 → /16');
  ok('手持安全判断', !isHandheldSafe(1 / 60, 50, 1, false) && isHandheldSafe(1 / 30, 50, 1, false)
    && isHandheldSafe(1 / 60, 50, 1, true), '1/60@50mm unsafe; 1/30 safe; 1/60+IS safe');

  return checks;
}

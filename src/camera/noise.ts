// src/camera/noise.ts — 传感器噪声模型（纯函数）
//
// 为什么单独抽出来：
//   噪声参数原本硬编码在 FRAG_NOISE 的 GLSL 里，改一个系数只能靠肉眼看截图，
//   也无法被 vitest 覆盖。这里把「σ 随 ISO 怎么变」变成可计算的函数，
//   由 CameraEngine 每帧把两个系数送进着色器（uShotK / uReadK），
//   GLSL 只保留逐像素的 sqrt(lum) 形状，模型本身则被单测锁死。

/** 散粒噪声系数：σ_shot = √(亮度) × 该系数 × √(ISO/100) × 传感器缩放 */
export const SHOT_NOISE_K = 0.003;

/** 读出噪声系数：σ_read = 该系数 × (ISO/100) × 传感器缩放（增益之后，主导暗部） */
export const READ_NOISE_K = 0.000025;

/** ISO 相对基准（100）的增益 */
export function isoGain(iso: number): number {
  if (!Number.isFinite(iso)) return 1;
  return Math.max(iso, 50) / 100;
}

/**
 * 散粒噪声标准差。
 * 光电子数 N 的涨落 σ_N = √N；乘回增益 g 后 σ = √N·g，显示亮度 c = N·g，
 * 于是 σ = √(c·g) —— 亮部更脏，且相对噪声 ∝ √g ∝ √ISO。
 */
export function shotNoiseSigma(luminance: number, iso: number, sensorScale = 1): number {
  const g = isoGain(iso);
  return Math.sqrt(Math.max(luminance, 0)) * SHOT_NOISE_K * Math.sqrt(g) * safeScale(sensorScale);
}

/** 读出噪声标准差（与信号无关，只在增益之后线性放大，ISO 越高暗部越脏）。 */
export function readNoiseSigma(iso: number, sensorScale = 1): number {
  return READ_NOISE_K * isoGain(iso) * safeScale(sensorScale);
}

/** 总噪声标准差。 */
export function noiseSigma(luminance: number, iso: number, sensorScale = 1): number {
  return shotNoiseSigma(luminance, iso, sensorScale) + readNoiseSigma(iso, sensorScale);
}

/**
 * 相对噪声（σ / 亮度）——最直观的"脏不脏"指标。
 * 亮度为 0 时没有可用的相对量，返回无穷大（表示全黑区域信噪比为零）。
 */
export function relativeNoise(luminance: number, iso: number, sensorScale = 1): number {
  if (luminance <= 0) return Infinity;
  return noiseSigma(luminance, iso, sensorScale) / luminance;
}

/** 传进 GLSL 的逐像素系数：σ = √(lum) * shotK + readK。 */
export interface NoiseCoefficients {
  /** 对应 uShotK */
  shotK: number;
  /** 对应 uReadK */
  readK: number;
}

/** 计算某一组相机参数下的着色器系数（引擎每帧调用一次）。 */
export function noiseCoefficients(iso: number, sensorScale = 1): NoiseCoefficients {
  const scale = safeScale(sensorScale);
  const g = isoGain(iso);
  return { shotK: SHOT_NOISE_K * Math.sqrt(g) * scale, readK: READ_NOISE_K * g * scale };
}

function safeScale(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export interface NoiseCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/** 噪声模型的物理自洽性自测。 */
export function runNoiseSelfTest(): NoiseCheck[] {
  const checks: NoiseCheck[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  // 1. ISO 翻倍，散粒噪声 ×√2（这是本模块存在的核心理由）
  const a = shotNoiseSigma(0.18, 400);
  const b = shotNoiseSigma(0.18, 800);
  add('ISO 翻倍 → 散粒噪声 ×√2', Math.abs(b / a - Math.SQRT2) < 1e-6,
    `${a.toFixed(6)} → ${b.toFixed(6)}，比值 ${(b / a).toFixed(4)}`);

  // 2. 老 bug 回归：相对噪声必须随 √ISO，而不是随 ISO 线性增长
  const rel100 = relativeNoise(0.18, 100);
  const rel6400 = relativeNoise(0.18, 6400);
  const ratio = rel6400 / rel100;
  // 纯散粒噪声理论比值 = √64 = 8；读出噪声的加入让实测略高于 8（约 9.1）。
  // 若退化成线性，比值会是 64，因此上限只需远低于 64。
  add('ISO ×64 → 相对噪声约 ×8（√ 关系）', ratio > 6 && ratio < 12,
    `相对噪声 ${(rel100 * 100).toFixed(2)}% → ${(rel6400 * 100).toFixed(2)}%，比值 ${ratio.toFixed(2)}`);

  // 3. 暗部相对噪声显著高于亮部（读出噪声 + 散粒噪声共同作用）
  add('暗部比亮部更脏', relativeNoise(0.02, 6400) > relativeNoise(0.6, 6400) * 2,
    `0.02 → ${(relativeNoise(0.02, 6400) * 100).toFixed(1)}%，0.6 → ${(relativeNoise(0.6, 6400) * 100).toFixed(1)}%`);

  // 4. 传感器越小越脏
  add('小传感器噪声更大', noiseSigma(0.18, 1600, 1.7) > noiseSigma(0.18, 1600, 1),
    `M4/3 ${noiseSigma(0.18, 1600, 1.7).toFixed(5)} > 全画幅 ${noiseSigma(0.18, 1600, 1).toFixed(5)}`);

  // 5. 单调性：ISO 越高噪声越大
  let mono = true;
  let prev = -1;
  for (const iso of [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200]) {
    const s = noiseSigma(0.18, iso);
    if (s <= prev) mono = false;
    prev = s;
  }
  add('噪声随 ISO 单调递增', mono, `100→51200 逐档递增`);

  // 6. 零亮度只有读出噪声、不出现负值或 NaN
  const dark = noiseSigma(0, 25600);
  add('全黑仅有读出噪声', Number.isFinite(dark) && dark > 0 && shotNoiseSigma(0, 25600) === 0,
    `σ(0, ISO25600) = ${dark.toExponential(3)}`);

  // 7. 系数与直接计算一致（着色器走的是系数路径，必须同值）
  const coef = noiseCoefficients(3200, 1.526);
  const direct = noiseSigma(0.42, 3200, 1.526);
  const viaCoef = Math.sqrt(0.42) * coef.shotK + coef.readK;
  add('系数路径与直接计算一致', Math.abs(viaCoef - direct) < 1e-12,
    `${viaCoef.toExponential(6)} vs ${direct.toExponential(6)}`);

  // 8. 非法输入被兜底（0/负数/NaN 传感器缩放、非法 ISO）
  const bad = noiseCoefficients(Number.NaN, Number.NaN);
  add('非法输入兜底', Number.isFinite(bad.shotK) && Number.isFinite(bad.readK) && bad.shotK > 0,
    `shotK=${bad.shotK.toExponential(3)}, readK=${bad.readK.toExponential(3)}`);

  return checks;
}

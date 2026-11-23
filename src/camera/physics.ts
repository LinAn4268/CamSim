// src/camera/physics.ts — 曝光与光学的纯函数模型（关键公式集中在此，便于单测）
// 参考：ISO 2720 / EV 定义、薄透镜成像、弥散圆（CoC）景深理论。

/** 标准整档光圈序列（f-number） */
export const APERTURE_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22] as const;
/** 标准整档快门序列（秒） */
export const SHUTTER_STOPS = [
  1 / 8000, 1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60,
  1 / 30, 1 / 15, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 15, 30,
] as const;
/** 标准整档 ISO 序列 */
export const ISO_STOPS = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200] as const;
/** 全画幅 sensor 宽度与高度（mm） */
export const SENSOR = { width: 36, height: 24 } as const;
/** 容许弥散圆直径 c（mm），全画幅常用 0.03mm */
export const COC_LIMIT = 0.03;

export const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));
export const log2 = (x: number) => Math.log(x) / Math.LN2;

/**
 * 曝光值 EV（ISO100 基准）：
 *   EV = log2(N² / t) - log2(ISO/100)
 * 其中 N=光圈，t=快门秒数，ISO=感光度。
 * 该值表示“达到正确曝光所需的场景亮度”，与测光得到的场景 EV 比较可得曝光偏差。
 */
export function exposureValue(aperture: number, shutter: number, iso: number): number {
  return log2((aperture * aperture) / shutter) - log2(iso / 100);
}

/**
 * 线性曝光增益 G：到达传感器的相对曝光量（任意标定常数 K=1 时）。
 *   G = t · (ISO/100) / N² · 2^(曝光补偿)
 * 注意：增大光圈（N 减小）→ G 增大；延长快门 → G 线性增大；提高 ISO → G 线性增大。
 */
export function exposureGain(aperture: number, shutter: number, iso: number, comp = 0): number {
  return (shutter * (iso / 100) / (aperture * aperture)) * Math.pow(2, comp);
}

/** 安全快门：传统经验 1/焦距（全画幅等效），返回秒数。 */
export function safeShutter(focalLengthMm: number): number {
  return 1 / focalLengthMm;
}

/** 等效焦距（裁切系数）：APS-C 1.5，M4/3 2 —— P2 传感器切换预留。 */
export function equivalentFocal(focalLengthMm: number, crop = 1): number {
  return focalLengthMm * crop;
}

/** 超焦距 H = f²/(N·c) + f（单位：mm） */
export function hyperfocal(focalMm: number, aperture: number, coc = COC_LIMIT): number {
  return (focalMm * focalMm) / (aperture * coc) + focalMm;
}

/** 景深计算结果（单位：m） */
export interface DepthOfField {
  near: number;
  far: number;
  hyperfocal: number;
  total: number;
}

/**
 * 景深（薄透镜 + 容许弥散圆）：
 *   H = f²/(N·c) + f,  s=对焦距离(mm), c=容许弥散圆
 *   Dn = s·(H−f) / (H + s − 2f)
 *   Df = s·(H−f) / (H − s)        （s < H 时；s≥H 时远景深=∞）
 */
export function depthOfField(focalMm: number, aperture: number, focusDistanceM: number, coc = COC_LIMIT): DepthOfField {
  const f = focalMm;                 // mm
  const s = focusDistanceM * 1000;   // mm
  const H = hyperfocal(f, aperture, coc);
  if (s >= H) return { near: (s * (H - f) / (H + s - 2 * f)) / 1000, far: Infinity, hyperfocal: H / 1000, total: Infinity };
  const near = (s * (H - f) / (H + s - 2 * f)) / 1000;
  const far = (s * (H - f) / (H - s)) / 1000;
  return { near, far, hyperfocal: H / 1000, total: far - near };
}

/**
 * 弥散圆直径 c（mm）——用于渲染景深模糊半径：
 *   c = A · |s − s0| · f² / (N · s0 · (s − f))
 * A=实际物距(mm), s0=对焦距离(mm)。返回 mm。
 */
export function circleOfConfusion(
  focalMm: number, aperture: number, focusDistanceM: number, objectDistanceM: number,
): number {
  const f = focalMm;
  const s0 = Math.max(focusDistanceM * 1000, f + 1);
  const A = Math.max(objectDistanceM * 1000, f + 1);
  const numerator = Math.abs(A - s0) * f * f;
  const denominator = aperture * s0 * Math.max(A - f, 1);
  return numerator / denominator;
}

/** 视角（水平方向，度）：2·atan(sensorWidth / (2f)) */
export function fieldOfView(focalMm: number, sensorWidth = SENSOR.width): number {
  return 2 * Math.atan(sensorWidth / (2 * focalMm)) * 180 / Math.PI;
}

/** 衍射极限模糊直径（μm）：瑞利判据 2.44·λ·N，λ 取 0.55μm 绿光。返回像素等效（近似）。 */
export function diffractionBlur(aperture: number, wavelengthUm = 0.55): number {
  return 2.44 * wavelengthUm * aperture; // μm（相对量，渲染中再归一化）
}

/** 曝光偏差（eV）= 实际参数 EV − 测光场景 EV − 曝光补偿；正值=过曝 */
export function exposureDelta(actualEV: number, meteredEV: number, comp = 0): number {
  return actualEV - meteredEV - comp;
}

/**
 * 曝光标定常数：把曝光增益换算到测试场景的线性亮度尺度上。
 * 渲染（CameraEngine）与测光（meterScene）必须使用同一个值，
 * 否则测光 EV 与实际 EV 相差 log2(K) 档，曝光刻度会整体偏移。
 */
export const EXPOSURE_CALIBRATION = 1000;

/** 将线性 EV 映射到建议快门（给定光圈与 ISO）：t = N² / (ISO/100 · 2^EV) */
export function shutterForEV(ev: number, aperture: number, iso: number): number {
  return (aperture * aperture) / ((iso / 100) * Math.pow(2, ev));
}

/** RGB → 相对亮度（Rec.709 线性） */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

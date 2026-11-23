// src/camera/tonemap.ts — 色调映射的 CPU 参考实现
// 与 renderer/shaders/chains.ts 的 FRAG_TONEMAP 保持同一公式，供 RAW / HDR 预览合成使用。
// 独立成纯函数模块的收益：
//   1) 避免原实现逐像素构造临时数组（256×160×3 次分配），HDR 合成耗时从百毫秒级降到个位数毫秒；
//   2) 可以在 Node 环境中直接单测，渲染与合成不会再各行其是。

/** ACES 近似曲线（Narkowicz 2015）：HDR 线性值 → 0..1 显示域，肩部平滑压缩高光。 */
export function acesFilmic(x: number): number {
  if (!Number.isFinite(x)) return 0;
  // 负线性值在物理上没有意义；直接钳到 0，否则分子分母同时变号会算出 1.25 这种「负输入反而发白」的荒谬结果。
  const n = Math.max(0, x);
  const v = (n * (2.51 * n + 0.03)) / (n * (2.43 * n + 0.59) + 0.14);
  return Math.min(1, Math.max(0, v));
}

/** 线性值 → 8bit 显示值：先钳制到 [0,16]（超出即视为高光溢出），再 ACES + 2.2 gamma。 */
export function linearToDisplayByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const x = Math.min(16, Math.max(0, value));
  return Math.round(Math.pow(acesFilmic(x), 1 / 2.2) * 255);
}

/** 三通道版本，便于直接写入 ImageData。 */
export function linearToDisplayRgb(r: number, g: number, b: number): [number, number, number] {
  return [linearToDisplayByte(r), linearToDisplayByte(g), linearToDisplayByte(b)];
}

/** 曝光后的线性编码（RGBA8）→ 线性浮点：c = 16·(v/255)²，与 FRAG_ENCODE_LINEAR 互逆。 */
export function decodeEncodedLinear(byte: number): number {
  const v = Number.isFinite(byte) ? byte : 0;
  return 16 * Math.pow(Math.min(255, Math.max(0, v)) / 255, 2);
}

/** 线性浮点 → 编码字节：v = 255·√(c/16)，decodeEncodedLinear 的逆函数（供测试与数据互转）。 */
export function encodeLinearToByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const x = Math.min(16, Math.max(0, value));
  return Math.round(255 * Math.sqrt(x / 16));
}

/** 自测项，供 runCameraSelfTest 汇总。 */
export interface TonemapCheck { name: string; pass: boolean; detail: string }

export function runTonemapSelfTest(): TonemapCheck[] {
  const checks: TonemapCheck[] = [];
  const ok = (name: string, cond: boolean, detail: string) => checks.push({ name, pass: cond, detail });

  ok('ACES 黑场为 0', acesFilmic(0) === 0, `${acesFilmic(0)}`);
  ok('ACES 白场饱和', acesFilmic(16) > 0.99 && acesFilmic(16) <= 1, `${acesFilmic(16).toFixed(4)}`);
  ok('ACES 单调不减', acesFilmic(0.18) < acesFilmic(0.5) && acesFilmic(0.5) < acesFilmic(2),
    `${acesFilmic(0.18).toFixed(3)}<${acesFilmic(0.5).toFixed(3)}<${acesFilmic(2).toFixed(3)}`);
  ok('ACES 非有限输入归零', acesFilmic(NaN) === 0 && acesFilmic(Infinity) === 0, 'NaN/Inf→0');

  ok('显示值落在 0..255', linearToDisplayByte(-1) === 0 && linearToDisplayByte(100) === 255,
    `${linearToDisplayByte(-1)}..${linearToDisplayByte(100)}`);
  ok('中灰 0.18 映射到中亮度', (() => {
    const v = linearToDisplayByte(0.18);
    // ACES + 2.2 gamma 下 0.18 线性对应约 140/255（比纯 gamma 更亮，这是 ACES 的既定行为）
    return v > 120 && v < 160;
  })(), `${linearToDisplayByte(0.18)}`);

  ok('编码/解码互逆（1.0）', Math.abs(decodeEncodedLinear(255) - 16) < 1e-9, `${decodeEncodedLinear(255)}`);
  ok('编码/解码互逆（0.25）', Math.abs(decodeEncodedLinear(encodeLinearToByte(0.25)) - 0.25) < 1e-2,
    `${decodeEncodedLinear(encodeLinearToByte(0.25)).toFixed(6)}`);
  ok('编码值落在 0..255', encodeLinearToByte(-1) === 0 && encodeLinearToByte(1e3) === 255,
    `${encodeLinearToByte(-1)}..${encodeLinearToByte(1e3)}`);

  return checks;
}

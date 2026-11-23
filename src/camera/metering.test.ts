// src/camera/metering.test.ts — 测光模型单测（场景 EV / 三种测光区域 / 中灰映射）
import { describe, it, expect } from 'vitest';
import { meterScene, relativeLuminance } from './metering';
import { shutterForEV } from './physics';

/** 构造 width×height 的亮度网格，可用回调按坐标填值 */
function grid(width: number, height: number, fn: (x: number, y: number) => number) {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data[y * width + x] = fn(x, y);
  return { width, height, data };
}

const uniform = (v: number) => grid(20, 20, () => v);

describe('metering / meterScene', () => {
  it('18% 中灰场景 → EV≈0', () => {
    const r = meterScene(uniform(0.18), 'evaluative', 5.6, 100);
    expect(r.ev).toBeCloseTo(0, 6);
    expect(r.luminance).toBeCloseTo(0.18, 6);
  });

  it('亮度每翻倍，场景 EV +1', () => {
    const dark = meterScene(uniform(0.09), 'evaluative', 5.6, 100);
    const bright = meterScene(uniform(0.36), 'evaluative', 5.6, 100);
    expect(bright.ev - dark.ev).toBeCloseTo(2, 6);
  });

  it('建议在亮场景下更快（更短）的快门', () => {
    const dark = meterScene(uniform(0.09), 'evaluative', 5.6, 100);
    const bright = meterScene(uniform(0.72), 'evaluative', 5.6, 100);
    expect(bright.suggestedShutter).toBeLessThan(dark.suggestedShutter);
    // 建议快门与 shutterForEV 公式一致
    expect(dark.suggestedShutter).toBeCloseTo(shutterForEV(dark.ev, 5.6, 100), 9);
  });

  it('亮度下限保护：全黑网格不产生 -Infinity 或 NaN', () => {
    const r = meterScene(uniform(0), 'evaluative', 5.6, 100);
    expect(Number.isFinite(r.ev)).toBe(true);
    expect(r.luminance).toBeGreaterThan(0);
  });

  it('点测光：指定亮区时读数高于指定暗区', () => {
    // 左半屏很暗，右半屏很亮
    const split = grid(20, 20, (x) => (x < 10 ? 0.02 : 2.0));
    const onDark = meterScene(split, 'spot', 5.6, 100, { x: 0.25, y: 0.5 });
    const onBright = meterScene(split, 'spot', 5.6, 100, { x: 0.75, y: 0.5 });
    expect(onBright.luminance).toBeGreaterThan(onDark.luminance);
    expect(onBright.ev).toBeGreaterThan(onDark.ev);
  });

  it('中央重点 vs 评价测光：中心亮、边缘暗时读数不同', () => {
    // 中心 8×8 亮，四周暗
    const centerBright = grid(20, 20, (x, y) =>
      x >= 6 && x < 14 && y >= 6 && y < 14 ? 4 : 0.05);
    const center = meterScene(centerBright, 'center', 5.6, 100);
    const evaluative = meterScene(centerBright, 'evaluative', 5.6, 100);
    expect(center.luminance).toBeGreaterThan(evaluative.luminance);
  });

  it('三种模式在均匀场景下读数一致', () => {
    const g = uniform(0.5);
    const spot = meterScene(g, 'spot', 5.6, 100);
    const center = meterScene(g, 'center', 5.6, 100);
    const evalv = meterScene(g, 'evaluative', 5.6, 100);
    expect(spot.luminance).toBeCloseTo(center.luminance, 6);
    expect(center.luminance).toBeCloseTo(evalv.luminance, 6);
  });

  it('相对亮度使用 Rec.709 权重并透出', () => {
    expect(relativeLuminance(1, 0, 0)).toBeCloseTo(0.2126, 6);
    expect(relativeLuminance(0, 1, 0)).toBeCloseTo(0.7152, 6);
    expect(relativeLuminance(0, 0, 1)).toBeCloseTo(0.0722, 6);
    expect(relativeLuminance(1, 1, 1)).toBeCloseTo(1, 6);
  });

  it('标定常数：与渲染共用同一增益，避免测光 EV 整体偏移', () => {
    const g = uniform(0.18);
    const base = meterScene(g, 'evaluative', 5.6, 400);
    expect(base.ev).toBeCloseTo(0, 6);
    // 亮度乘 K，EV 应恰好上移 log2(K)
    const calibrated = meterScene(g, 'evaluative', 5.6, 400, undefined, 1000);
    expect(calibrated.ev - base.ev).toBeCloseTo(Math.log2(1000), 6);
    // 建议快门相应变快：同一场景下标定后快门更短
    expect(calibrated.suggestedShutter).toBeLessThan(base.suggestedShutter);
    // 非法标定（0/负数）回退为 1，不产生 NaN
    const bad = meterScene(g, 'evaluative', 5.6, 400, undefined, 0);
    expect(Number.isFinite(bad.ev)).toBe(true);
    expect(bad.ev).toBeCloseTo(base.ev, 6);
  });
});

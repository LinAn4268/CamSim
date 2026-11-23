import { describe, it, expect } from 'vitest';
import {
  ndTransmission, effectiveShutter, flashExposureEV, stabilizerStops,
  effectiveHandheldShutter, isHandheldSafe, handheldSafeShutterLimit, jellyEffectStrength,
  bracketEVs, hdrMergeWeight, mergeHDR, zebraThreshold, runAdvancedSelfTest,
} from './advanced';

describe('advanced (P1 physics)', () => {
  it('自测套件全通过', () => {
    const r = runAdvancedSelfTest();
    expect(r.filter((c) => !c.pass)).toEqual([]);
    expect(r.length).toBeGreaterThanOrEqual(8);
  });

  it('ND 透光率与等效快门', () => {
    expect(ndTransmission(3)).toBeCloseTo(0.125, 12);
    expect(effectiveShutter(0.01, 2)).toBeCloseTo(0.04, 12);
  });

  it('闪光 EV 平方反比', () => {
    const near = flashExposureEV(0, 2, 100, 5.6);
    const far = flashExposureEV(0, 4, 100, 5.6);
    expect(near - far).toBeCloseTo(2, 10); // 距离翻倍，EV 减 2
  });

  it('防抖放宽安全快门 4 档', () => {
    expect(stabilizerStops(true)).toBe(4);
    expect(effectiveHandheldShutter(1 / 60, 50, 1, true)).toBeCloseTo(1 / 960, 12);
    // 50mm 安全界限 1/50s：1/60 更快 → 安全；1/30 更慢 → 不安全
    expect(isHandheldSafe(1 / 60, 50, 1, false)).toBe(true);
    expect(isHandheldSafe(1 / 30, 50, 1, false)).toBe(false);
    // 防抖 4 档把界限放宽到 1/3.125s，1/30 变安全
    expect(isHandheldSafe(1 / 30, 50, 1, true)).toBe(true);
  });

  it('手持安全界限随焦距收紧、随裁切收紧、随防抖放宽', () => {
    const limit50 = handheldSafeShutterLimit(50, 1, false);
    const limit200 = handheldSafeShutterLimit(200, 1, false);
    expect(limit50).toBeCloseTo(1 / 50, 12);
    expect(limit200).toBeCloseTo(1 / 200, 12);
    expect(limit200).toBeLessThan(limit50);
    // 长焦必须用更快快门才算安全：200mm 用 1/100 不安全，1/250 才安全
    expect(isHandheldSafe(1 / 100, 200, 1, false)).toBe(false);
    expect(isHandheldSafe(1 / 250, 200, 1, false)).toBe(true);
    // 裁切系数等效放大焦距
    expect(handheldSafeShutterLimit(50, 2, false)).toBeCloseTo(1 / 100, 12);
    // 防抖放宽 16 倍
    expect(handheldSafeShutterLimit(200, 1, true)).toBeCloseTo(16 / 200, 12);
    // 非法输入不产生 Infinity/NaN
    expect(Number.isFinite(handheldSafeShutterLimit(0, 0, false))).toBe(true);
    expect(Number.isFinite(handheldSafeShutterLimit(50, -1, false))).toBe(true);
  });

  it('果冻效应机械 0 / 电子 >0', () => {
    expect(jellyEffectStrength('mechanical', 1 / 8000)).toBe(0);
    expect(jellyEffectStrength('electronic', 1 / 8000)).toBeGreaterThan(0);
  });

  it('包围 EV 对称', () => {
    expect(bracketEVs(3, 1)).toEqual([-1, 0, 1]);
    expect(bracketEVs(5, 2)).toEqual([-4, -2, 0, 2, 4]);
  });

  it('HDR 权重与合成', () => {
    expect(hdrMergeWeight(NaN, 0)).toBe(0);
    const merged = mergeHDR([
      { data: new Float32Array([0.25, 0.5]), evOffset: -1 },
      { data: new Float32Array([0.5, 0.25]), evOffset: 1 },
    ]);
    expect(merged.length).toBe(2);
    expect(Array.from(merged).every(Number.isFinite)).toBe(true);
  });

  it('斑马阈值', () => expect(zebraThreshold()).toBe(0.95));
});

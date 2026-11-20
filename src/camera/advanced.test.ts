import { describe, it, expect } from 'vitest';
import {
  ndTransmission, effectiveShutter, flashExposureEV, stabilizerStops,
  effectiveHandheldShutter, isHandheldSafe, jellyEffectStrength,
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
    expect(isHandheldSafe(1 / 60, 50, 1, true)).toBe(true);
    expect(isHandheldSafe(1 / 60, 50, 1, false)).toBe(false);
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

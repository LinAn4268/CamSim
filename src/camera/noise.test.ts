// src/camera/noise.test.ts — 传感器噪声模型

import { describe, it, expect } from 'vitest';
import {
  SHOT_NOISE_K,
  READ_NOISE_K,
  isoGain,
  shotNoiseSigma,
  readNoiseSigma,
  noiseSigma,
  relativeNoise,
  noiseCoefficients,
  runNoiseSelfTest,
} from './noise';

describe('noise / 散粒噪声与读出噪声', () => {
  it('isoGain 以 ISO100 为基准，非法输入兜底', () => {
    expect(isoGain(100)).toBeCloseTo(1, 10);
    expect(isoGain(400)).toBeCloseTo(4, 10);
    expect(isoGain(25600)).toBeCloseTo(256, 10);
    expect(isoGain(50)).toBeCloseTo(0.5, 10);
    expect(isoGain(10)).toBeCloseTo(0.5, 10); // 下限钳到 50
    expect(isoGain(Number.NaN)).toBe(1);
  });

  it('散粒噪声 ∝ √信号：信号 ×4 则 σ ×2', () => {
    const a = shotNoiseSigma(0.1, 400);
    const b = shotNoiseSigma(0.4, 400);
    expect(b / a).toBeCloseTo(2, 10);
  });

  it('散粒噪声 ∝ √ISO：ISO ×4 则 σ ×2', () => {
    const a = shotNoiseSigma(0.18, 400);
    const b = shotNoiseSigma(0.18, 1600);
    expect(b / a).toBeCloseTo(2, 10);
  });

  it('读出噪声与信号无关，∝ ISO', () => {
    expect(readNoiseSigma(400)).toBeCloseTo(readNoiseSigma(400), 12);
    expect(readNoiseSigma(800) / readNoiseSigma(400)).toBeCloseTo(2, 10);
    expect(readNoiseSigma(1600)).toBeCloseTo(READ_NOISE_K * 16, 12);
  });

  it('总噪声 = 散粒 + 读出', () => {
    const total = noiseSigma(0.18, 3200);
    expect(total).toBeCloseTo(shotNoiseSigma(0.18, 3200) + readNoiseSigma(3200), 12);
  });

  it('全黑场景只剩读出噪声（无负值、无 NaN）', () => {
    expect(shotNoiseSigma(0, 25600)).toBe(0);
    expect(noiseSigma(0, 25600)).toBeGreaterThan(0);
    expect(Number.isFinite(noiseSigma(0, 25600))).toBe(true);
    expect(shotNoiseSigma(-1, 400)).toBe(0); // 负亮度钳到 0
  });

  it('相对噪声随 √ISO 增长，而非随 ISO 线性（老 bug 回归）', () => {
    const r100 = relativeNoise(0.18, 100);
    const r6400 = relativeNoise(0.18, 6400); // ISO ×64
    const ratio = r6400 / r100;
    // 纯散粒噪声理论比值 √64 = 8；读出噪声使其略高（约 9.1）。
    // 若退化成线性，比值会是 64 —— 必须远离这个数量级。
    expect(ratio).toBeGreaterThan(6);
    expect(ratio).toBeLessThan(12);
    expect(ratio).toBeLessThan(20);
  });

  it('高 ISO 相对噪声保持在可观但可用的范围', () => {
    // 这是截图评审发现的缺陷：ISO6400 曾出现 84.7% 相对噪声（画面被淹没）
    expect(relativeNoise(0.18, 6400)).toBeLessThan(0.25);
    expect(relativeNoise(0.18, 25600)).toBeLessThan(0.6);
    // 但同时必须明显高于低 ISO，不能"优化掉了噪点"
    expect(relativeNoise(0.18, 6400)).toBeGreaterThan(relativeNoise(0.18, 100) * 3);
  });

  it('暗部相对噪声高于亮部', () => {
    expect(relativeNoise(0.02, 6400)).toBeGreaterThan(relativeNoise(0.6, 6400));
    expect(relativeNoise(0, 100)).toBe(Infinity);
  });

  it('传感器缩放：小底更脏，非法值回退 1', () => {
    expect(noiseSigma(0.18, 1600, 1.7)).toBeGreaterThan(noiseSigma(0.18, 1600, 1));
    const bad = noiseCoefficients(1600, Number.NaN);
    const normal = noiseCoefficients(1600, 1);
    expect(bad.shotK).toBeCloseTo(normal.shotK, 12);
    expect(bad.readK).toBeCloseTo(normal.readK, 12);
    expect(noiseCoefficients(1600, 0).shotK).toBeCloseTo(normal.shotK, 12);
    expect(noiseCoefficients(1600, -1).shotK).toBeCloseTo(normal.shotK, 12);
  });

  it('系数路径与直接计算完全一致（引擎送进着色器的就是这套）', () => {
    for (const iso of [100, 400, 1600, 6400, 25600]) {
      for (const scale of [1, 1.35, 1.7]) {
        const c = noiseCoefficients(iso, scale);
        const direct = noiseSigma(0.42, iso, scale);
        expect(Math.sqrt(0.42) * c.shotK + c.readK).toBeCloseTo(direct, 12);
      }
    }
  });

  it('噪声随 ISO 单调递增', () => {
    let prev = -1;
    for (const iso of [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200]) {
      const s = noiseSigma(0.18, iso);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('系数常量与着色器默认值保持同源', () => {
    expect(SHOT_NOISE_K).toBe(0.003);
    expect(READ_NOISE_K).toBe(0.000025);
  });

  it('自测项全部通过', () => {
    const checks = runNoiseSelfTest();
    expect(checks.length).toBeGreaterThanOrEqual(8);
    for (const c of checks) expect(`${c.name}: ${c.detail} → ${c.pass}`).toContain('true');
  });
});

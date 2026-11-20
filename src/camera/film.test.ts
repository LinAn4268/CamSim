import { describe, it, expect } from 'vitest';
import {
  FILM_GRADES, filmGrade, applyGradeToRgb, parseCubeLUT, sampleCubeLUT,
  BUILTIN_LUTS, runFilmSelfTest,
} from './film';

describe('film (P1 color)', () => {
  it('自测套件全通过', () => {
    expect(runFilmSelfTest().filter((c) => !c.pass)).toEqual([]);
  });

  it('胶片档位齐全且 deep clone', () => {
    expect(Object.keys(FILM_GRADES)).toEqual(['standard', 'portrait', 'landscape', 'mono', 'log']);
    const a = filmGrade('portrait');
    const b = filmGrade('portrait');
    a.matrix[0] = 99;
    expect(b.matrix[0]).not.toBe(99);
  });

  it('standard 近似恒等', () => {
    const out = applyGradeToRgb([0.5, 0.5, 0.5], filmGrade('standard'));
    out.forEach((v) => expect(v).toBeCloseTo(0.5, 1));
  });

  it('mono 输出灰度（R≈G≈B）', () => {
    const out = applyGradeToRgb([0.8, 0.2, 0.4], filmGrade('mono'));
    expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-9);
    expect(Math.abs(out[1] - out[2])).toBeLessThan(1e-9);
  });

  it('解析内置 .cube', () => {
    const lut = parseCubeLUT(BUILTIN_LUTS.Neutral);
    expect(lut).not.toBeNull();
    expect(lut!.size).toBeGreaterThanOrEqual(2);
    expect(lut!.data.length).toBe(lut!.size ** 3 * 3);
    expect(lut!.data.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('LUT 三线性采样有限且在域内', () => {
    const lut = parseCubeLUT(BUILTIN_LUTS['Warm Film']);
    expect(lut).not.toBeNull();
    const rgb = sampleCubeLUT(lut!, 0.25, 0.5, 0.75);
    expect(rgb.length).toBe(3);
    rgb.forEach((v) => { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); });
  });

  it('非法 .cube 返回 null', () => {
    expect(parseCubeLUT('not a cube')).toBeNull();
  });
});

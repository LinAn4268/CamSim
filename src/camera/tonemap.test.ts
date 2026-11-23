// src/camera/tonemap.test.ts — CPU 端色调映射与线性编码解码的单元测试

import { describe, expect, it } from 'vitest';
import {
  acesFilmic, linearToDisplayByte, linearToDisplayRgb, decodeEncodedLinear,
  encodeLinearToByte, runTonemapSelfTest,
} from './tonemap';

describe('tonemap / ACES', () => {
  it('黑场为 0，高光饱和到 1', () => {
    expect(acesFilmic(0)).toBe(0);
    expect(acesFilmic(16)).toBeGreaterThan(0.99);
    expect(acesFilmic(16)).toBeLessThanOrEqual(1);
    expect(acesFilmic(1e6)).toBe(1);
  });

  it('单调递增（肩部压缩但不会反转）', () => {
    const samples = [0, 0.05, 0.18, 0.5, 1, 2, 4, 8, 16];
    for (let i = 1; i < samples.length; i++) {
      expect(acesFilmic(samples[i])).toBeGreaterThanOrEqual(acesFilmic(samples[i - 1]));
    }
  });

  it('非有限输入与负数安全归零', () => {
    expect(acesFilmic(NaN)).toBe(0);
    expect(acesFilmic(Infinity)).toBe(0);
    expect(acesFilmic(-1)).toBe(0);
  });
});

describe('tonemap / 显示值映射', () => {
  it('输出始终落在 0..255 的整数', () => {
    for (const v of [-5, 0, 0.001, 0.18, 1, 4, 16, 100]) {
      const b = linearToDisplayByte(v);
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });

  it('中灰 0.18 映射到中亮度区间', () => {
    const v = linearToDisplayByte(0.18);
    expect(v).toBeGreaterThan(120);
    expect(v).toBeLessThan(160);
  });

  it('三通道版本逐通道独立映射', () => {
    expect(linearToDisplayRgb(0, 0.18, 16)).toEqual([
      linearToDisplayByte(0), linearToDisplayByte(0.18), linearToDisplayByte(16),
    ]);
  });

  it('越界值被钳制而不是回绕', () => {
    expect(linearToDisplayByte(-3)).toBe(0);
    expect(linearToDisplayByte(1e6)).toBe(255);
    expect(linearToDisplayByte(NaN)).toBe(0);
  });
});

describe('tonemap / 线性编码', () => {
  it('c=16 编码为 255，c=0 编码为 0', () => {
    expect(encodeLinearToByte(16)).toBe(255);
    expect(encodeLinearToByte(0)).toBe(0);
  });

  it('编码与解码互逆（量化误差内）', () => {
    // 编码是 8bit sqrt 量化，最坏相对误差约 0.8%（c≈1 时），用整数量级容差校验
    for (const v of [0, 0.05, 0.25, 1, 4, 16]) {
      expect(decodeEncodedLinear(encodeLinearToByte(v))).toBeCloseTo(v, 1);
    }
  });

  it('解码结果单调且范围 0..16', () => {
    let prev = -1;
    for (let b = 0; b <= 255; b += 17) {
      const v = decodeEncodedLinear(b);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(16);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('非法字节值安全处理', () => {
    expect(decodeEncodedLinear(NaN)).toBe(0);
    expect(decodeEncodedLinear(-10)).toBe(0);
    expect(decodeEncodedLinear(999)).toBe(16);
  });
});

describe('tonemap / 自测汇总', () => {
  it('所有内置自测项通过', () => {
    const checks = runTonemapSelfTest();
    expect(checks.length).toBeGreaterThanOrEqual(8);
    expect(checks.filter((c) => !c.pass)).toEqual([]);
  });
});

// src/camera/physics.test.ts — 关键物理公式单元测试

import { describe, it, expect } from 'vitest';
import {
  exposureValue, exposureGain, depthOfField, circleOfConfusion, fieldOfView,
  hyperfocal, shutterForEV, diffractionBlur, APERTURE_STOPS, SHUTTER_STOPS, ISO_STOPS,
} from './physics';
import { whiteBalanceGain, kelvinToRGB } from './whiteBalance';

describe('曝光 EV 关系', () => {
  it('光圈精确收一档 EV +1', () => {
    expect(exposureValue(4, 1 / 125, 100) - exposureValue(2 * Math.SQRT2, 1 / 125, 100)).toBeCloseTo(1, 6);
  });
  it('标准档位 f/2.8→f/4 约一档', () => {
    expect(exposureValue(4, 1 / 125, 100) - exposureValue(2.8, 1 / 125, 100)).toBeCloseTo(1, 0);
  });
  it('ISO 提高一档 EV -1', () => {
    expect(exposureValue(4, 1 / 125, 200) - exposureValue(4, 1 / 125, 100)).toBeCloseTo(-1, 6);
  });
  it('快门变慢一档 EV -1（用标准整档 1/125→1/60 近似）', () => {
    expect(exposureValue(4, 1 / 60, 100) - exposureValue(4, 1 / 125, 100)).toBeCloseTo(-1, 0);
  });
  it('快门精确减半 EV -1', () => {
    expect(exposureValue(4, 1 / 60, 100) - exposureValue(4, 1 / 120, 100)).toBeCloseTo(-1, 6);
  });
  it('shutterForEV 与 exposureValue 互逆', () => {
    const t = shutterForEV(10, 5.6, 400);
    expect(exposureValue(5.6, t, 400)).toBeCloseTo(10, 6);
  });
});

describe('曝光增益', () => {
  it('f/2.8 进光量约为 f/4 的两倍（标准整档 f/2.8≡2√2）', () => {
    expect(exposureGain(2.8, 1 / 125, 100) / exposureGain(4, 1 / 125, 100)).toBeCloseTo(2, 1);
  });
  it('光圈精确收一档（√2 倍）进光减半', () => {
    expect(exposureGain(2 * Math.SQRT2, 1 / 125, 100) / exposureGain(4, 1 / 125, 100)).toBeCloseTo(2, 6);
  });
  it('曝光补偿 +1EV 增益翻倍', () => {
    expect(exposureGain(4, 1 / 125, 100, 1) / exposureGain(4, 1 / 125, 100, 0)).toBeCloseTo(2, 6);
  });
});

describe('景深', () => {
  it('大光圈景深浅', () => {
    expect(depthOfField(50, 1.8, 3).total).toBeLessThan(depthOfField(50, 11, 3).total);
  });
  it('长焦景深浅', () => {
    expect(depthOfField(200, 2.8, 5).total).toBeLessThan(depthOfField(50, 2.8, 5).total);
  });
  it('超焦距处远景深无穷', () => {
    const H = hyperfocal(35, 8);
    expect(depthOfField(35, 8, H / 1000).far).toBe(Infinity);
  });
  it('对焦距离越远景深越大', () => {
    expect(depthOfField(50, 4, 5).total).toBeGreaterThan(depthOfField(50, 4, 2).total);
  });
  it('离焦越远弥散圆越大', () => {
    expect(circleOfConfusion(50, 2.8, 3, 1)).toBeGreaterThan(circleOfConfusion(50, 2.8, 3, 2.5));
  });
});

describe('镜头', () => {
  it('焦距越长视角越窄', () => {
    expect(fieldOfView(200)).toBeLessThan(fieldOfView(24));
  });
  it('小光圈衍射更强', () => {
    expect(diffractionBlur(22)).toBeGreaterThan(diffractionBlur(2.8));
  });
  it('标准档位完整', () => {
    expect(APERTURE_STOPS.length).toBe(9);
    expect(SHUTTER_STOPS.length).toBe(19);
    expect(ISO_STOPS.length).toBe(10);
  });
});

describe('白平衡', () => {
  it('低色温光源偏橙（蓝<红）', () => {
    const light = kelvinToRGB(3200);
    expect(light[2]).toBeLessThan(light[0]);
  });
  it('高色温光源偏蓝（蓝通道更高）', () => {
    expect(kelvinToRGB(7500)[2]).toBeGreaterThan(kelvinToRGB(3200)[2]);
  });
  it('低色温需要更高蓝补偿增益', () => {
    const g = whiteBalanceGain(3200, 0);
    expect(g[2]).toBeGreaterThan(g[0]);
  });
  it('6500K 增益≈1', () => {
    const g = whiteBalanceGain(6500, 0);
    expect(g[0]).toBeCloseTo(1, 5);
    expect(g[2]).toBeCloseTo(1, 5);
  });
});

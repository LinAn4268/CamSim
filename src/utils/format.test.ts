// src/utils/format.test.ts — 显示格式化单测
import { describe, it, expect } from 'vitest';
import { formatShutterLabel, formatEv } from './format';

describe('formatShutterLabel', () => {
  it('慢门（≥1s）显示为秒数', () => {
    expect(formatShutterLabel(30)).toBe('30s');
    expect(formatShutterLabel(2)).toBe('2.0s');
    expect(formatShutterLabel(1.5)).toBe('1.5s');
  });

  it('快门（<1s）显示为分数形式', () => {
    expect(formatShutterLabel(1 / 125)).toBe('1/125');
    expect(formatShutterLabel(1 / 60)).toBe('1/60');
    expect(formatShutterLabel(1 / 8000)).toBe('1/8000');
  });
});

describe('formatEv', () => {
  it('正数带 + 号，负数带 - 号，保留两位小数', () => {
    expect(formatEv(0)).toBe('+0.00 EV');
    expect(formatEv(1.5)).toBe('+1.50 EV');
    expect(formatEv(-2.345)).toBe('-2.35 EV');
  });
});

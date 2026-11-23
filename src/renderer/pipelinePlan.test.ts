// src/renderer/pipelinePlan.test.ts — 后期链早退与自适应画质的单元测试

import { describe, expect, it } from 'vitest';
import {
  planPipeline, skippedPassCount, decideQuality, degradeTier,
  runPipelinePlanSelfTest, MOTION_MIN_LENGTH, JELLY_MIN_STRENGTH, SHAKE_MIN_PIXELS,
  DEGRADE_FPS, DEGRADE_SECONDS, RECOVER_FPS,
  type QualityTier,
} from './pipelinePlan';

describe('pipelinePlan / 早退判定', () => {
  it('静止机位三个零效果 pass 全部跳过', () => {
    const plan = planPipeline({ motionLength: 0, jellyStrength: 0, shakePixels: 0 });
    expect(plan).toEqual({ motion: false, jelly: false, stabilize: false, mask: false });
    expect(skippedPassCount(plan)).toBe(3);
  });

  it('运动 + 电子快门时全部启用（含遮罩）', () => {
    const plan = planPipeline({ motionLength: 0.02, jellyStrength: 0.9, shakePixels: 0.4 });
    expect(plan).toEqual({ motion: true, jelly: true, stabilize: true, mask: true });
    expect(skippedPassCount(plan)).toBe(0);
  });

  it('阈值边界：刚好达到阈值即启用，差一点则跳过', () => {
    expect(planPipeline({ motionLength: MOTION_MIN_LENGTH, jellyStrength: JELLY_MIN_STRENGTH, shakePixels: SHAKE_MIN_PIXELS }))
      .toEqual({ motion: true, jelly: true, stabilize: true, mask: true });
    expect(planPipeline({
      motionLength: MOTION_MIN_LENGTH * 0.99,
      jellyStrength: JELLY_MIN_STRENGTH * 0.99,
      shakePixels: SHAKE_MIN_PIXELS * 0.99,
    })).toEqual({ motion: false, jelly: false, stabilize: false, mask: false });
  });

  it('遮罩渲染始终跟随运动模糊', () => {
    for (const len of [0, MOTION_MIN_LENGTH / 2, MOTION_MIN_LENGTH, 1]) {
      const plan = planPipeline({ motionLength: len, jellyStrength: 0, shakePixels: 0 });
      expect(plan.mask).toBe(plan.motion);
    }
  });

  it('负位移不会误判（幅度参与判定）', () => {
    expect(planPipeline({ motionLength: -0.02, jellyStrength: 0, shakePixels: 0 }).motion).toBe(true);
  });

  it('NaN / Infinity 输入按不启用处理', () => {
    const plan = planPipeline({ motionLength: NaN, jellyStrength: Infinity, shakePixels: NaN });
    expect(plan).toEqual({ motion: false, jelly: false, stabilize: false, mask: false });
  });
});

describe('pipelinePlan / 自适应画质', () => {
  it('降级顺序 high → medium → low → low', () => {
    const tiers: QualityTier[] = ['high', 'medium', 'low'];
    expect(tiers.map(degradeTier)).toEqual(['medium', 'low', 'low']);
  });

  it('帧率达标时计数清零且不降级', () => {
    const d = decideQuality({ tier: 'high', fps: RECOVER_FPS, lowStreak: 5, elapsed: 0.5, canDegrade: true });
    expect(d).toEqual({ tier: 'high', lowStreak: 0, changed: false });
  });

  it('介于降级与恢复阈值之间时保持累计值', () => {
    const d = decideQuality({ tier: 'high', fps: DEGRADE_FPS, lowStreak: 1, elapsed: 0.5, canDegrade: true });
    expect(d.tier).toBe('high');
    expect(d.changed).toBe(false);
    expect(d.lowStreak).toBe(1);
  });

  it('累计达到 DEGRADE_SECONDS 才降一级并把计数清零', () => {
    const before = decideQuality({ tier: 'high', fps: 25, lowStreak: DEGRADE_SECONDS - 0.5, elapsed: 0.5, canDegrade: true });
    expect(before.changed).toBe(true);
    expect(before.tier).toBe('medium');
    expect(before.lowStreak).toBe(0);
    // 同样累计值但只差一点点时保持原画质并继续累计
    const notYet = decideQuality({ tier: 'high', fps: 25, lowStreak: DEGRADE_SECONDS - 0.6, elapsed: 0.5, canDegrade: true });
    expect(notYet.changed).toBe(false);
    expect(notYet.tier).toBe('high');
    expect(notYet.lowStreak).toBeCloseTo(DEGRADE_SECONDS - 0.1, 6);
  });

  it('已是最低画质时不再变化但继续累计', () => {
    const d = decideQuality({ tier: 'low', fps: 20, lowStreak: 10, elapsed: 0.5, canDegrade: true });
    expect(d.tier).toBe('low');
    expect(d.changed).toBe(false);
    expect(d.lowStreak).toBeCloseTo(10.5, 6);
  });

  it('禁止降级（手动指定画质 / 拍摄中）时完全不动作', () => {
    const d = decideQuality({ tier: 'high', fps: 10, lowStreak: 99, elapsed: 0.5, canDegrade: false });
    expect(d).toEqual({ tier: 'high', lowStreak: 0, changed: false });
  });

  it('非法帧率不触发降级', () => {
    for (const fps of [0, -1, NaN]) {
      expect(decideQuality({ tier: 'high', fps, lowStreak: 9, elapsed: 0.5, canDegrade: true })).toEqual(
        { tier: 'high', lowStreak: 0, changed: false },
      );
    }
  });
});

describe('pipelinePlan / 自测汇总', () => {
  it('所有内置自测项通过', () => {
    const checks = runPipelinePlanSelfTest();
    expect(checks.length).toBeGreaterThanOrEqual(11);
    expect(checks.filter((c) => !c.pass)).toEqual([]);
  });
});

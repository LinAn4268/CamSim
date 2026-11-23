// src/renderer/pipelinePlan.ts — 每帧决定后期链里哪些 pass 真正需要运行
// 背景：整条链固定 8 个全屏 pass，但多数 pass 在典型参数下是「零效果」的：
//   · 机械快门 → 果冻效应恒为 0；
//   · 快门快于 1/2000 → 屏幕位移 × 快门 < 半像素，运动模糊不可见（此时遮罩场景也不必渲染）；
//   · 手抖位移 < 0.01px → 防抖位移不可见。
// 跳过这些 pass 可以省掉整屏带宽与采样。判定逻辑抽成纯函数，便于单测且与 GLSL 内的早退阈值保持一致。

/** 与 FRAG_MOTION 中 `if (len < 0.0005)` 保持同一阈值（单位：UV）。 */
export const MOTION_MIN_LENGTH = 0.0005;
/** 与 FRAG_JELLY 中 `if (uStrength < 0.001)` 保持同一阈值。 */
export const JELLY_MIN_STRENGTH = 0.001;
/** 与 FRAG_STABILIZE 中 `if (uShake < 0.01)` 保持同一阈值（单位：像素）。 */
export const SHAKE_MIN_PIXELS = 0.01;

export interface PipelinePlan {
  /** 是否需要运动模糊 pass */
  motion: boolean;
  /** 是否需要果冻效应 pass */
  jelly: boolean;
  /** 是否需要防抖抖动 pass */
  stabilize: boolean;
  /** 是否需要额外渲染白色遮罩场景（只有运动模糊要用） */
  mask: boolean;
}

export interface PlanInput {
  /** 运动物体屏幕速度 × 快门时间，单位 UV */
  motionLength: number;
  /** jellyEffectStrength 的结果，0..1 */
  jellyStrength: number;
  /** 手抖位移，单位像素 */
  shakePixels: number;
}

/** 本帧的 pass 启用计划。任何非有限输入都按「不启用」处理，避免 NaN 传染到 uniform。 */
export function planPipeline(input: PlanInput): PipelinePlan {
  const motion = Number.isFinite(input.motionLength) && Math.abs(input.motionLength) >= MOTION_MIN_LENGTH;
  const jelly = Number.isFinite(input.jellyStrength) && input.jellyStrength >= JELLY_MIN_STRENGTH;
  const stabilize = Number.isFinite(input.shakePixels) && Math.abs(input.shakePixels) >= SHAKE_MIN_PIXELS;
  return { motion, jelly, stabilize, mask: motion };
}

/** 计划中被跳过的 pass 数量，用于状态栏与自测展示。 */
export function skippedPassCount(plan: PipelinePlan): number {
  let n = 0;
  if (!plan.motion) n++;
  if (!plan.jelly) n++;
  if (!plan.stabilize) n++;
  return n;
}

// ---------------------------------------------------------------------------
// 自适应画质：帧率长期偏低时逐级降级渲染分辨率（性能 / 移动端降级要求）
// ---------------------------------------------------------------------------

export type QualityTier = 'high' | 'medium' | 'low';

/** 触发降级的帧率阈值：低于此值视为「吃力」。 */
export const DEGRADE_FPS = 40;
/** 需要连续吃力的累计时长（秒），避免偶发卡顿就降画质。 */
export const DEGRADE_SECONDS = 2;
/** 帧率回到此值以上时清零累计计时。 */
export const RECOVER_FPS = 50;

/** 降一级画质；已是 low 则保持。 */
export function degradeTier(tier: QualityTier): QualityTier {
  if (tier === 'high') return 'medium';
  return 'low';
}

export interface QualityInput {
  tier: QualityTier;
  fps: number;
  /** 已累计的「低帧率」秒数 */
  lowStreak: number;
  /** 采样间隔（秒），通常是 0.5 */
  elapsed: number;
  /** 是否允许自动降级（拍摄中 / 手动指定画质时为 false） */
  canDegrade: boolean;
}

export interface QualityDecision {
  tier: QualityTier;
  lowStreak: number;
  changed: boolean;
}

/** 纯函数的画质决策：只降不升，需要连续 DEGRADE_SECONDS 秒低于 DEGRADE_FPS 才降一级。 */
export function decideQuality(input: QualityInput): QualityDecision {
  const fps = Number.isFinite(input.fps) ? input.fps : 0;
  if (!input.canDegrade || fps <= 0) return { tier: input.tier, lowStreak: 0, changed: false };
  if (fps >= RECOVER_FPS) return { tier: input.tier, lowStreak: 0, changed: false };
  if (fps >= DEGRADE_FPS) return { tier: input.tier, lowStreak: input.lowStreak, changed: false };
  const streak = input.lowStreak + input.elapsed;
  if (streak < DEGRADE_SECONDS || input.tier === 'low') {
    return { tier: input.tier, lowStreak: streak, changed: false };
  }
  return { tier: degradeTier(input.tier), lowStreak: 0, changed: true };
}

/** 自测项 */
export interface PipelineCheck { name: string; pass: boolean; detail: string }

export function runPipelinePlanSelfTest(): PipelineCheck[] {
  const checks: PipelineCheck[] = [];
  const ok = (name: string, cond: boolean, detail: string) => checks.push({ name, pass: cond, detail });

  const still = planPipeline({ motionLength: 0, jellyStrength: 0, shakePixels: 0 });
  ok('静止机位跳过三个 pass', !still.motion && !still.jelly && !still.stabilize, JSON.stringify(still));
  ok('静止时同时跳过遮罩渲染', still.mask === false, `mask=${still.mask}`);

  const moving = planPipeline({ motionLength: 0.02, jellyStrength: 0.9, shakePixels: 0.4 });
  ok('运动 + 电子快门全开', moving.motion && moving.jelly && moving.stabilize && moving.mask, JSON.stringify(moving));

  const fast = planPipeline({ motionLength: MOTION_MIN_LENGTH / 2, jellyStrength: 0, shakePixels: 0 });
  ok('亚像素位移不启用运动模糊', !fast.motion && !fast.mask, `len=${MOTION_MIN_LENGTH / 2}`);

  const nan = planPipeline({ motionLength: NaN, jellyStrength: NaN, shakePixels: NaN });
  ok('NaN 输入安全降级', !nan.motion && !nan.jelly && !nan.stabilize && !nan.mask, JSON.stringify(nan));

  ok('跳过计数', skippedPassCount(still) === 3 && skippedPassCount(moving) === 0,
    `${skippedPassCount(still)}/${skippedPassCount(moving)}`);

  // 画质决策
  const slow1 = decideQuality({ tier: 'high', fps: 30, lowStreak: 0, elapsed: 0.5, canDegrade: true });
  ok('单次低帧不降级', slow1.changed === false && slow1.tier === 'high', JSON.stringify(slow1));
  const slow4 = decideQuality({ tier: 'high', fps: 30, lowStreak: 1.5, elapsed: 0.5, canDegrade: true });
  ok('持续 2 秒低帧降一级', slow4.changed === true && slow4.tier === 'medium', JSON.stringify(slow4));
  const slowLow = decideQuality({ tier: 'low', fps: 20, lowStreak: 5, elapsed: 0.5, canDegrade: true });
  ok('low 不再下降', slowLow.changed === false && slowLow.tier === 'low', JSON.stringify(slowLow));
  const fast60 = decideQuality({ tier: 'medium', fps: 60, lowStreak: 3, elapsed: 0.5, canDegrade: true });
  ok('高帧率清零计数', fast60.lowStreak === 0 && !fast60.changed, JSON.stringify(fast60));
  const locked = decideQuality({ tier: 'high', fps: 10, lowStreak: 9, elapsed: 0.5, canDegrade: false });
  ok('禁止降级时保持不变', locked.tier === 'high' && !locked.changed, JSON.stringify(locked));

  return checks;
}

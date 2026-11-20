// src/camera/film.ts — 胶片模拟 / LUT 色彩变换（纯函数，产出供 GLSL 消费的参数）
// 设计原则：所有颜色变换都是可解释的显式公式（矩阵 + LGG + 对比度 + 饱和度），
// 不做黑盒。CPU 端 applyGradeToRgb 与 GLSL 调色 pass 一一对应，便于单测比对。

import type { FilmSimulation } from '../types/camera';

/**
 * 3×3 行主序颜色矩阵的定长元组（即需求中所写的 number[9] 记法）。
 * TypeScript 不支持 C 风格的 number[9] 数组语法，定长元组是等价且可编译的写法。
 * 索引：row*3 + col，即 [m00, m01, m02, m10, m11, m12, m20, m21, m22]。
 */
export type Matrix9 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

/** Rec.709 相对亮度权重，用于饱和度混合与灰度矩阵。 */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** 把任意数钳制到 [0,1]；NaN 归零以保证结果确定且有限。 */
function unit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * 一个胶片模拟档位的全部调色参数。
 * 这些字段可直接作为 uniform 传给 GLSL 的 post-tonemap 调色 pass。
 */
export interface FilmGrade {
  name: string;
  matrix: Matrix9; // 行主序 3×3，定长 9 个数（需求中的 number[9] 记法）
  contrast: number;   // 对比度，围绕中灰 0.5 缩放；1 = 不变
  saturation: number; // 饱和度，与亮度混合；1 = 不变，0 = 灰度
  lift: number;       // 抬黑：加性亮度偏移，应用于矩阵之后
  gamma: number;      // 显示伽马，指数取 1/gamma；>1 提亮中间调，<1 压暗
  gain: number;       // 增益：乘性亮度缩放，应用于 gamma 之后
  logMode: boolean;   // Log 标志：提示渲染器使用高动态范围显示变换
}

/** 单位矩阵（行主序 3×3）。 */
const IDENTITY: Matrix9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * 五种胶片模拟档位。矩阵均为行主序 3×3：
 * - standard：单位矩阵，不改变颜色。
 * - portrait：暖肤色，R×1.05 / B×0.96，略降对比与饱和，轻抬黑。
 * - landscape：草木与天空更鲜艳，G×1.06 / B×1.04，提高对比与饱和。
 * - mono：每行都是 Rec.709 亮度权重，三通道输出相同 → 灰度。
 * - log：低对比、高动态范围显示风格，压暗中间调并抬黑。
 */
export const FILM_GRADES: Record<FilmSimulation, FilmGrade> = {
  standard: {
    name: 'Standard',
    matrix: IDENTITY,
    contrast: 1.0,
    saturation: 1.0,
    lift: 0,
    gamma: 1,
    gain: 1,
    logMode: false,
  },
  portrait: {
    name: 'Portrait',
    matrix: [1.05, 0, 0, 0, 1, 0, 0, 0, 0.96],
    contrast: 0.95,
    saturation: 0.92,
    lift: 0.01,
    gamma: 1.02,
    gain: 1,
    logMode: false,
  },
  landscape: {
    name: 'Landscape',
    matrix: [1, 0, 0, 0, 1.06, 0, 0, 0, 1.04],
    contrast: 1.08,
    saturation: 1.18,
    lift: 0,
    gamma: 0.98,
    gain: 1,
    logMode: false,
  },
  mono: {
    name: 'Monochrome',
    matrix: [
      LUMA_R, LUMA_G, LUMA_B,
      LUMA_R, LUMA_G, LUMA_B,
      LUMA_R, LUMA_G, LUMA_B,
    ],
    saturation: 0,
    contrast: 1.12,
    lift: 0.01,
    gamma: 1,
    gain: 1,
    logMode: false,
  },
  log: {
    name: 'Log',
    matrix: IDENTITY,
    contrast: 0.8,
    saturation: 0.85,
    lift: 0.05,
    gamma: 0.6,
    gain: 0.9,
    logMode: true, // Log 风格：低对比、高动态范围显示
  },
};

/**
 * 取得某个胶片模拟的调色参数（浅拷贝，矩阵单独复制）。
 * 调用方修改返回值不会污染 FILM_GRADES 中的共享对象。
 */
export function filmGrade(sim: FilmSimulation): FilmGrade {
  const grade = FILM_GRADES[sim] ?? FILM_GRADES.standard;
  return { ...grade, matrix: [...grade.matrix] as Matrix9 };
}

/**
 * CPU 参考实现：把一个 RGB（各通道 0..1）按调色参数变换，返回同样范围的 RGB。
 * 步骤与 GLSL 调色 pass 保持一致：
 *   1) 行主序 3×3 矩阵乘：out = M · rgb；
 *   2) LGG：x = clamp(x + lift, 0, 1)；x = pow(x, 1/gamma)；x *= gain；
 *   3) 对比度围绕中灰 0.5：x = (x - 0.5) * contrast + 0.5；
 *   4) 与 Rec.709 亮度混合实现饱和度：y = luma + (x - luma) * saturation；
 *   5) 每通道钳制到 [0,1]。
 * 幂函数前先钳制到非负，避免负底数产生 NaN。
 */
export function applyGradeToRgb(
  rgb: [number, number, number],
  grade: FilmGrade,
): [number, number, number] {
  const m = grade.matrix;
  const r0 = Number.isFinite(rgb[0]) ? rgb[0] : 0;
  const g0 = Number.isFinite(rgb[1]) ? rgb[1] : 0;
  const b0 = Number.isFinite(rgb[2]) ? rgb[2] : 0;

  // 1) 矩阵（行主序）
  const mr = m[0] * r0 + m[1] * g0 + m[2] * b0;
  const mg = m[3] * r0 + m[4] * g0 + m[5] * b0;
  const mb = m[6] * r0 + m[7] * g0 + m[8] * b0;

  // 2) Lift / Gamma / Gain
  const invGamma = grade.gamma > 0 ? 1 / grade.gamma : 1;
  const lgg = (x: number): number => {
    const lifted = unit(x + grade.lift);
    return unit(Math.pow(lifted, invGamma) * grade.gain);
  };

  // 3) 对比度（围绕 0.5），结果随后再参与饱和度混合
  const contrast = (x: number): number => (x - 0.5) * grade.contrast + 0.5;
  const cr = contrast(lgg(mr));
  const cg = contrast(lgg(mg));
  const cb = contrast(lgg(mb));

  // 4) 饱和度：按 Rec.709 亮度向灰度靠拢（saturation=0）或远离（>1）
  const luma = LUMA_R * cr + LUMA_G * cg + LUMA_B * cb;
  const outR = luma + (cr - luma) * grade.saturation;
  const outG = luma + (cg - luma) * grade.saturation;
  const outB = luma + (cb - luma) * grade.saturation;

  // 5) 钳制输出，保证确定且有限
  return [unit(outR), unit(outG), unit(outB)];
}

/** 内置极简 .cube 文本：单位 3D LUT（2×2×2，输出=输入）。 */
const NEUTRAL_CUBE = `# Neutral — 单位 3D LUT（2×2×2），输出等于输入
TITLE "Neutral"
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

/** 内置暖色 .cube 文本：在单位 LUT 基础上，对非极端色号 R+0.04 / B-0.04 并钳制。 */
const WARM_CUBE = `# Warm Film — 中性 2×2×2 LUT，非极端色偏暖（R +0.04 / B -0.04，钳制到 0..1）
TITLE "Warm Film"
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 0.0 0.0
0.04 1.0 0.0
1.0 1.0 0.0
0.04 0.0 0.96
1.0 0.0 0.96
0.04 1.0 0.96
1.0 1.0 1.0
`;

/** 可直接喂给 parseCubeLUT 的内置 .cube 字符串。 */
export const BUILTIN_LUTS: Record<string, string> = {
  Neutral: NEUTRAL_CUBE,
  'Warm Film': WARM_CUBE,
};

/**
 * 解析最小 Adobe .cube 3D LUT 文本。
 * 支持：以 '#' 开头的注释、空行、TITLE "..."、LUT_3D_SIZE <int>，以及每行三个浮点数（RGB 顺序）。
 * 校验：size ∈ [2,64]、数据条数 === size³×3、每个值 ∈ [0,1]；任意不合法返回 null。
 * 对 DOMAIN_MIN / DOMAIN_MAX / LUT_1D_SIZE 等元数据行做宽松忽略。
 */
export function parseCubeLUT(
  text: string,
): { name: string; size: number; data: Float32Array } | null {
  if (typeof text !== 'string') return null;

  let name = '';
  let size = 0;
  const values: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    if (/^TITLE\b/i.test(line)) {
      const match = line.match(/^TITLE\s+"([^"]*)"$/i);
      if (!match) return null;
      name = match[1];
      continue;
    }
    if (/^LUT_3D_SIZE\b/i.test(line)) {
      const match = line.match(/^LUT_3D_SIZE\s+(\d+)$/i);
      if (!match) return null;
      size = Number.parseInt(match[1], 10);
      continue;
    }
    // 忽略非 3D 的元数据行；它们不是色值。
    if (/^(DOMAIN_MIN|DOMAIN_MAX|LUT_1D_SIZE|INTERPOLATION)\b/i.test(line)) continue;

    const parts = line.split(/\s+/);
    if (parts.length !== 3) return null;
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    values.push(r, g, b);
  }

  if (!Number.isInteger(size) || size < 2 || size > 64) return null;
  if (values.length !== size * size * size * 3) return null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < 0 || values[i] > 1) return null;
  }

  return { name, size, data: new Float32Array(values) };
}

/**
 * 在 3D LUT 中做三线性插值采样。
 * 输入 r/g/b 先钳制到 [0,1]；索引按 .cube 标准排列：r 变化最快，其次 g，最后 b。
 * 数据非法时退化为直通（返回钳制后的输入），保证结果确定且有限。
 */
export function sampleCubeLUT(
  lut: { size: number; data: Float32Array },
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const size = lut.size;
  const data = lut.data;
  const cr = unit(r);
  const cg = unit(g);
  const cb = unit(b);

  if (
    !Number.isInteger(size) || size < 2 || size > 64 ||
    !data || data.length < size * size * size * 3
  ) {
    return [cr, cg, cb];
  }

  const maxIndex = size - 1;
  const fr = cr * maxIndex;
  const fg = cg * maxIndex;
  const fb = cb * maxIndex;
  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, maxIndex);
  const g1 = Math.min(g0 + 1, maxIndex);
  const b1 = Math.min(b0 + 1, maxIndex);
  const tr = fr - r0;
  const tg = fg - g0;
  const tb = fb - b0;

  // 读取一个格点的一个通道；非有限值按 0 处理以保证确定性。
  const at = (ri: number, gi: number, bi: number, channel: number): number => {
    const index = ((bi * size + gi) * size + ri) * 3 + channel;
    const value = data[index];
    return Number.isFinite(value) ? value : 0;
  };

  const out: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    // 先沿 r 插值
    const c00 = at(r0, g0, b0, channel) + (at(r1, g0, b0, channel) - at(r0, g0, b0, channel)) * tr;
    const c10 = at(r0, g1, b0, channel) + (at(r1, g1, b0, channel) - at(r0, g1, b0, channel)) * tr;
    const c01 = at(r0, g0, b1, channel) + (at(r1, g0, b1, channel) - at(r0, g0, b1, channel)) * tr;
    const c11 = at(r0, g1, b1, channel) + (at(r1, g1, b1, channel) - at(r0, g1, b1, channel)) * tr;
    // 再沿 g 插值
    const c0 = c00 + (c10 - c00) * tg;
    const c1 = c01 + (c11 - c01) * tg;
    // 最后沿 b 插值
    out[channel] = unit(c0 + (c1 - c0) * tb);
  }
  return out;
}

interface FilmCheck { name: string; pass: boolean; detail: string }

/**
 * 纯函数自检：覆盖矩阵、LGG/对比度/饱和度、LUT 解析与三线性插值等关键路径。
 * 返回逐项结果，不产生任何副作用。
 */
export function runFilmSelfTest(): Array<{ name: string; pass: boolean; detail: string }> {
  const checks: FilmCheck[] = [];
  const ok = (name: string, condition: boolean, detail: string): void => {
    checks.push({ name, pass: condition, detail });
  };

  // 1) standard 为单位矩阵且参数全中性，直通不改色
  const std = FILM_GRADES.standard;
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const isIdentity = std.matrix.every((v, i) => v === identity[i]);
  const stdNeutralParams = std.contrast === 1 && std.saturation === 1 &&
    std.lift === 0 && std.gamma === 1 && std.gain === 1 && !std.logMode;
  const stdSample = applyGradeToRgb([0.25, 0.5, 0.75], std);
  ok(
    'standard 为单位矩阵且直通',
    isIdentity && stdNeutralParams &&
      stdSample.every((v, i) => Math.abs(v - [0.25, 0.5, 0.75][i]) < 1e-6),
    `matrix=${std.matrix.join(',')}; 输出=${stdSample.map((v) => v.toFixed(3)).join(',')}`,
  );

  // 2) mono 对任意样色三通道相等（灰度）
  const monoOut = applyGradeToRgb([0.3, 0.6, 0.2], FILM_GRADES.mono);
  ok(
    'mono 三通道相等',
    Math.abs(monoOut[0] - monoOut[1]) < 1e-6 && Math.abs(monoOut[1] - monoOut[2]) < 1e-6,
    `输出=${monoOut.map((v) => v.toFixed(4)).join(',')}`,
  );

  // 3) landscape 提升绿色通道
  const sample: [number, number, number] = [0.2, 0.5, 0.2];
  const stdGreen = applyGradeToRgb(sample, std)[1];
  const landGreen = applyGradeToRgb(sample, FILM_GRADES.landscape)[1];
  ok(
    'landscape 提升绿色',
    landGreen > stdGreen + 0.01,
    `standard G=${stdGreen.toFixed(3)} < landscape G=${landGreen.toFixed(3)}`,
  );

  // 4) logMode 标志：仅 log 档为真，且对比度最低
  const logFlag = FILM_GRADES.log.logMode &&
    !FILM_GRADES.standard.logMode && !FILM_GRADES.portrait.logMode &&
    !FILM_GRADES.landscape.logMode && !FILM_GRADES.mono.logMode;
  ok(
    'logMode 标志正确',
    logFlag && FILM_GRADES.log.contrast < FILM_GRADES.standard.contrast,
    `log.logMode=${FILM_GRADES.log.logMode}, contrast=${FILM_GRADES.log.contrast}`,
  );

  // 5) applyGradeToRgb 把越界输入钳制到 [0,1]
  const clamped = applyGradeToRgb([2, -1, 0.5], std);
  ok(
    'applyGradeToRgb 钳制到 [0,1]',
    clamped[0] === 1 && clamped[1] === 0 && Math.abs(clamped[2] - 0.5) < 1e-6,
    `输出=${clamped.join(',')}`,
  );

  // 6) parseCubeLUT 能解析内置 Neutral
  const neutral = parseCubeLUT(BUILTIN_LUTS.Neutral);
  const neutralOk = neutral !== null && neutral.name === 'Neutral' &&
    neutral.size === 2 && neutral.data.length === 24 &&
    neutral.data[0] === 0 && neutral.data[1] === 0 && neutral.data[2] === 0 &&
    neutral.data[3] === 1 && neutral.data[4] === 0 && neutral.data[5] === 0 &&
    neutral.data[21] === 1 && neutral.data[22] === 1 && neutral.data[23] === 1;
  ok(
    'parseCubeLUT 解析 Neutral',
    neutralOk,
    neutral ? `name=${neutral.name}, size=${neutral.size}, len=${neutral.data.length}` : '返回 null',
  );

  // 7) parseCubeLUT 拒绝非法输入（尺寸越界 / 数据条数不符 / 数值越界）
  const invalidCases = [
    'TITLE "bad"\nLUT_3D_SIZE 1\n0 0 0',
    'TITLE "bad"\nLUT_3D_SIZE 2\n0 0 0',
    'TITLE "bad"\nLUT_3D_SIZE 2\n' + Array.from({ length: 8 }, () => '0 0 1.5').join('\n'),
    'TITLE bad\nLUT_3D_SIZE 2\n',
    '',
  ];
  const rejectsInvalid = invalidCases.every((text) => parseCubeLUT(text) === null);
  ok('parseCubeLUT 拒绝非法输入', rejectsInvalid, `测试 ${invalidCases.length} 个非法样本，全部返回 null`);

  // 8) sampleCubeLUT 在单位 LUT 上近似返回输入
  if (neutral) {
    const sampled = sampleCubeLUT(neutral, 0.25, 0.75, 0.5);
    ok(
      'sampleCubeLUT 单位 LUT 近似直通',
      Math.abs(sampled[0] - 0.25) < 1e-6 &&
        Math.abs(sampled[1] - 0.75) < 1e-6 &&
        Math.abs(sampled[2] - 0.5) < 1e-6,
      `输入(0.25,0.75,0.5) → 输出(${sampled.map((v) => v.toFixed(4)).join(',')})`,
    );
  } else {
    ok('sampleCubeLUT 单位 LUT 近似直通', false, '前置条件失败：Neutral 解析为空');
  }

  // 9) filmGrade 返回防御性副本，改副本不污染共享档位
  const gradeA = filmGrade('portrait');
  const gradeB = filmGrade('portrait');
  gradeA.matrix[0] = 99;
  ok(
    'filmGrade 返回独立副本',
    gradeB.matrix[0] === 1.05 && FILM_GRADES.portrait.matrix[0] === 1.05,
    `副本 A[0]=${gradeA.matrix[0]}, 副本 B[0]=${gradeB.matrix[0]}`,
  );

  // 10) Warm Film LUT 在中灰处确实偏暖（R > G > B）
  const warm = parseCubeLUT(BUILTIN_LUTS['Warm Film']);
  if (warm) {
    const warmSample = sampleCubeLUT(warm, 0.5, 0.5, 0.5);
    ok(
      'Warm Film LUT 中灰偏暖',
      warmSample[0] > warmSample[1] && warmSample[1] > warmSample[2],
      `输出=(${warmSample.map((v) => v.toFixed(3)).join(',')})`,
    );
  } else {
    ok('Warm Film LUT 中灰偏暖', false, '前置条件失败：Warm Film 解析为空');
  }

  // 11) sampleCubeLUT 钳制越界输入并保持有限
  if (neutral) {
    const clampedLut = sampleCubeLUT(neutral, -1, 2, 0.5);
    ok(
      'sampleCubeLUT 钳制输入且结果有限',
      clampedLut.every(Number.isFinite) &&
        clampedLut[0] === 0 && clampedLut[1] === 1 && Math.abs(clampedLut[2] - 0.5) < 1e-6,
      `输入(-1,2,0.5) → 输出(${clampedLut.join(',')})`,
    );
  } else {
    ok('sampleCubeLUT 钳制输入且结果有限', false, '前置条件失败：Neutral 解析为空');
  }

  return checks;
}

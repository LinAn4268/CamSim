// src/camera/selfTest.ts — 浏览器控制台自测函数（window.__cameraSelfTest）

import {
  exposureValue, exposureGain, depthOfField, circleOfConfusion, fieldOfView, diffractionBlur,
  APERTURE_STOPS, ISO_STOPS, SHUTTER_STOPS,
} from './physics';
import { whiteBalanceGain, kelvinToRGB } from './whiteBalance';
import { runAdvancedSelfTest } from './advanced';
import { runOpticsSelfTest } from './optics';
import { runFilmSelfTest } from './film';
import { runTonemapSelfTest } from './tonemap';
import { runPipelinePlanSelfTest } from '../renderer/pipelinePlan';
import { runNoiseSelfTest } from './noise';

interface Check { name: string; pass: boolean; detail: string }

export function runCameraSelfTest(): { passed: number; total: number; checks: Check[] } {
  const checks: Check[] = [];
  const ok = (name: string, cond: boolean, detail: string) => checks.push({ name, pass: cond, detail });

  // EV 基本关系：光圈收小一档（f/2.8→f/4）EV 增加 1
  const ev28 = exposureValue(2.8, 1 / 125, 100);
  const ev4 = exposureValue(4, 1 / 125, 100);
  // f/2.8、f/4 是标准整档的取整标称值（精确档位应为 2√2、4），容差按标称值放宽
  ok('光圈收一档 EV≈+1', Math.abs((ev4 - ev28) - 1) < 0.08, `${ev28.toFixed(2)} → ${ev4.toFixed(2)}`);

  // 快门减半 EV+1
  const evA = exposureValue(4, 1 / 60, 100);
  const evB = exposureValue(4, 1 / 125, 100);
  // 1/60 → 1/125 约为 1.06 档（非精确整档，用理论值校验）
  const expectedShutterDelta = Math.log2((1 / 125) / (1 / 60)) * -1;
  ok('快门变快 EV 增加', Math.abs((evB - evA) - expectedShutterDelta) < 1e-6, `${evA.toFixed(2)} → ${evB.toFixed(2)} (+${expectedShutterDelta.toFixed(2)}EV)`);

  // ISO 提高一档 EV-1
  const iso100 = exposureValue(4, 1 / 125, 100);
  const iso200 = exposureValue(4, 1 / 125, 200);
  ok('ISO 高一档 EV-1', Math.abs((iso200 - iso100) + 1) < 1e-6, `${iso100.toFixed(2)} → ${iso200.toFixed(2)}`);

  // 曝光增益：大光圈进光更多
  const g28 = exposureGain(2.8, 1 / 125, 100);
  const g4 = exposureGain(4, 1 / 125, 100);
  ok('大光圈进光≈多一倍', Math.abs(g28 / g4 - 2) < 0.08, `${g28.toFixed(5)} / ${g4.toFixed(5)}`);

  // 景深：大光圈景深浅
  const dofWide = depthOfField(50, 1.8, 3);
  const dofNarrow = depthOfField(50, 11, 3);
  ok('大光圈景深浅', dofWide.total < dofNarrow.total, `f/1.8=${dofWide.total.toFixed(2)}m < f/11=${dofNarrow.total.toFixed(2)}m`);

  // 长焦景深浅
  const dof50 = depthOfField(50, 2.8, 5);
  const dof200 = depthOfField(200, 2.8, 5);
  ok('长焦景深浅', dof200.total < dof50.total, `50mm=${dof50.total.toFixed(2)}m, 200mm=${dof200.total.toFixed(2)}m`);

  // 弥散圆：离焦越远越大
  const cocNear = circleOfConfusion(50, 2.8, 3, 2.5);
  const cocFar = circleOfConfusion(50, 2.8, 3, 1.0);
  ok('离焦越远弥散越大', cocFar > cocNear, `${cocFar.toFixed(3)}mm > ${cocNear.toFixed(3)}mm`);

  // 视角：焦距越长视角越窄
  ok('长焦视角窄', fieldOfView(200) < fieldOfView(24), `${fieldOfView(200).toFixed(1)}° < ${fieldOfView(24).toFixed(1)}°`);

  // 衍射：光圈越小模糊越大
  ok('小光圈衍射强', diffractionBlur(16) > diffractionBlur(2.8), `f/16=${diffractionBlur(16).toFixed(2)}μm > f/2.8=${diffractionBlur(2.8).toFixed(2)}μm`);

  // WB：低色温光源偏橙（蓝<红），相机补偿蓝增益 > 红增益
  const light3200 = kelvinToRGB(3200);
  const light7500 = kelvinToRGB(7500);
  ok('低色温光源偏橙', light3200[2] < light3200[0], `R=1.00 B=${light3200[2].toFixed(2)}`);
  ok('高色温光源偏蓝', light7500[2] > light3200[2], `3200K B=${light3200[2].toFixed(2)}, 7500K B=${light7500[2].toFixed(2)}`);
  const wb3200 = whiteBalanceGain(3200, 0);
  const wb6500 = whiteBalanceGain(6500, 0);
  ok('低色温蓝补偿>红', wb3200[2] > wb3200[0], `R=${wb3200[0].toFixed(2)} B=${wb3200[2].toFixed(2)}`);
  ok('6500K 增益≈1', Math.abs(wb6500[0] - 1) < 1e-6 && Math.abs(wb6500[2] - 1) < 1e-6,
    `R=${wb6500[0].toFixed(3)} G=1.000 B=${wb6500[2].toFixed(3)}`);

  ok('标准档位齐全', APERTURE_STOPS.length === 9 && ISO_STOPS.length === 10 && SHUTTER_STOPS.length === 19,
    `N=${APERTURE_STOPS.length}, ISO=${ISO_STOPS.length}, t=${SHUTTER_STOPS.length}`);

  // P1 / P2 模块自测并入主自测
  for (const group of [runAdvancedSelfTest(), runOpticsSelfTest(), runFilmSelfTest()]) {
    for (const c of group) checks.push({ name: `[P1/P2] ${c.name}`, pass: c.pass, detail: c.detail });
  }
  // 渲染管线早退 / 色调映射 / 自适应画质
  for (const c of runTonemapSelfTest()) {
    checks.push({ name: `[渲染] ${c.name}`, pass: c.pass, detail: c.detail });
  }
  for (const c of runPipelinePlanSelfTest()) {
    checks.push({ name: `[管线] ${c.name}`, pass: c.pass, detail: c.detail });
  }
  for (const c of runNoiseSelfTest()) {
    checks.push({ name: `[噪声] ${c.name}`, pass: c.pass, detail: c.detail });
  }

  const passed = checks.filter(c => c.pass).length;
  console.groupCollapsed(`[相机自测] ${passed}/${checks.length} 通过`);
  checks.forEach(c => console.log(`${c.pass ? '✅' : '❌'} ${c.name} — ${c.detail}`));
  console.groupEnd();
  return { passed, total: checks.length, checks };
}

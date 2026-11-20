// src/camera/optics.ts — P2 传感器 / 镜头 / 预设的纯函数模型
// 依赖 physics.ts 中的基础光学公式，按传感器规格做归一化与换算。

import type {
  CameraSettings,
  FileFormat,
  LensId,
  SensorId,
} from '../types/camera';
import {
  clamp,
  COC_LIMIT,
  depthOfField,
  diffractionBlur,
  fieldOfView,
} from './physics';

// COC_LIMIT 在此保留导出别名，便于调用方从 optics 统一取用传感器无关的默认弥散圆。
export const DEFAULT_COC_LIMIT = COC_LIMIT;

/** 传感器规格：尺寸、裁切系数、容许弥散圆与相对噪点尺度。 */
export interface SensorProfile {
  id: SensorId;
  label: string;
  widthMm: number;
  heightMm: number;
  crop: number;
  cocMm: number;
  noiseScale: number;
}

/** 三种传感器规格表。传感器越小，裁切系数越大、噪点尺度越高。 */
export const SENSOR_PROFILES: Record<SensorId, SensorProfile> = {
  full: {
    id: 'full',
    label: '全画幅',
    widthMm: 36,
    heightMm: 24,
    crop: 1,
    cocMm: 0.03,
    noiseScale: 1.0,
  },
  'aps-c': {
    id: 'aps-c',
    label: 'APS-C',
    widthMm: 23.6,
    heightMm: 15.7,
    crop: 1.526,
    cocMm: 0.02,
    noiseScale: 1.35,
  },
  m43: {
    id: 'm43',
    label: 'M4/3',
    widthMm: 17.3,
    heightMm: 13,
    crop: 2.08,
    cocMm: 0.015,
    noiseScale: 1.7,
  },
};

/** 镜头规格：焦距范围与界面显示文本。 */
export interface LensProfile {
  id: LensId;
  label: string;
  minFocal: number;
  maxFocal: number;
  labelText: string;
}

/** 三种镜头规格表。 */
export const LENS_PROFILES: Record<LensId, LensProfile> = {
  wide: {
    id: 'wide',
    label: '广角',
    minFocal: 14,
    maxFocal: 35,
    labelText: '广角 14-35mm',
  },
  standard: {
    id: 'standard',
    label: '标准',
    minFocal: 24,
    maxFocal: 85,
    labelText: '标准 24-85mm',
  },
  tele: {
    id: 'tele',
    label: '长焦',
    minFocal: 70,
    maxFocal: 200,
    labelText: '长焦 70-200mm',
  },
};

/** 水平视角（度）：按传感器宽度调用 physics.fieldOfView。 */
export function sensorFieldOfView(focal: number, sensor: SensorId): number {
  const profile = SENSOR_PROFILES[sensor] ?? SENSOR_PROFILES.full;
  // physics.fieldOfView 的默认参数因 SENSOR as const 被推断为字面量类型 36，
  // 运行时仍使用传入的传感器宽度，这里仅为通过类型检查做窄化断言。
  return fieldOfView(focal, profile.widthMm as 36);
}

/** 景深：按传感器容许弥散圆调用 physics.depthOfField，原样返回结果。 */
export function sensorDepthOfField(
  focal: number,
  aperture: number,
  distanceM: number,
  sensor: SensorId,
) {
  const profile = SENSOR_PROFILES[sensor] ?? SENSOR_PROFILES.full;
  return depthOfField(focal, aperture, distanceM, profile.cocMm);
}

/** 相对噪点尺度（供噪点着色器 uniform uSensorScale 使用）。 */
export function sensorNoiseScale(sensor: SensorId): number {
  const profile = SENSOR_PROFILES[sensor] ?? SENSOR_PROFILES.full;
  return profile.noiseScale;
}

/** 相对衍射模糊（μm 等效）：按像素间距代理（裁切系数）缩放，并做有限值钳制。 */
export function diffractionBlurForSensor(aperture: number, sensor: SensorId): number {
  const profile = SENSOR_PROFILES[sensor] ?? SENSOR_PROFILES.full;
  const blur = diffractionBlur(aperture) * profile.crop;
  if (!Number.isFinite(blur)) return 0;
  return clamp(blur, 0, 1000);
}

/** 等效 f 值（视角归一化到全画幅）：aperture × 裁切系数，用于景深信息显示。 */
export function effectiveApertureForDoF(aperture: number, sensor: SensorId): number {
  const profile = SENSOR_PROFILES[sensor] ?? SENSOR_PROFILES.full;
  return aperture * profile.crop;
}

/** 相机预设：名称、设置快照与创建时间（ISO 8601）。 */
export interface CameraPreset {
  name: string;
  settings: CameraSettings;
  createdAt: string;
}

/** 将设置序列化为预设 JSON。 */
export function serializePreset(settings: CameraSettings, name: string): string {
  const preset: CameraPreset = {
    name,
    settings,
    createdAt: new Date().toISOString(),
  };
  return JSON.stringify(preset);
}

/** 反序列化预设；校验名称与关键数值字段，缺失字段用 fallback 补齐。失败返回 null。 */
export function deserializePreset(json: string, fallback: CameraSettings): CameraPreset | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name !== 'string') return null;
    const rawSettings = obj.settings;
    if (typeof rawSettings !== 'object' || rawSettings === null) return null;
    const s = rawSettings as Record<string, unknown>;
    if (
      typeof s.shutter !== 'number' || !Number.isFinite(s.shutter) ||
      typeof s.aperture !== 'number' || !Number.isFinite(s.aperture) ||
      typeof s.iso !== 'number' || !Number.isFinite(s.iso)
    ) return null;
    const settings = { ...fallback, ...s } as CameraSettings;
    const createdAt = typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString();
    return { name: obj.name, settings, createdAt };
  } catch {
    return null;
  }
}

/** 将焦距钳制到镜头变焦范围；未知镜头回退到 standard。 */
export function clampFocalToLens(focal: number, lens: LensId): number {
  const profile = LENS_PROFILES[lens] ?? LENS_PROFILES.standard;
  return clamp(focal, profile.minFocal, profile.maxFocal);
}

/** 文件格式的中文显示文本。 */
export function formatFileFormat(f: FileFormat): string {
  return f === 'raw' ? 'RAW（线性保留）' : 'JPEG（机内处理）';
}

/** 自检：返回一组 {name, pass, detail} 结果，覆盖传感器/镜头/预设关键行为。 */
export function runOpticsSelfTest(): Array<{ name: string; pass: boolean; detail: string }> {
  const results: Array<{ name: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  const { full, 'aps-c': aps, m43 } = SENSOR_PROFILES;

  check(
    '传感器宽度排序 full > aps-c > m43',
    full.widthMm > aps.widthMm && aps.widthMm > m43.widthMm,
    `${full.widthMm} > ${aps.widthMm} > ${m43.widthMm}`,
  );

  check(
    '裁切系数排序 full < aps-c < m43',
    full.crop < aps.crop && aps.crop < m43.crop,
    `${full.crop} < ${aps.crop} < ${m43.crop}`,
  );

  check(
    '噪点尺度排序 full < aps-c < m43',
    sensorNoiseScale('full') < sensorNoiseScale('aps-c') &&
      sensorNoiseScale('aps-c') < sensorNoiseScale('m43'),
    `${sensorNoiseScale('full')} < ${sensorNoiseScale('aps-c')} < ${sensorNoiseScale('m43')}`,
  );

  const fovFull = sensorFieldOfView(50, 'full');
  const fovM43 = sensorFieldOfView(50, 'm43');
  check(
    '同焦距水平视角 full > m43',
    fovFull > fovM43,
    `50mm: full=${fovFull.toFixed(2)}° > m43=${fovM43.toFixed(2)}°`,
  );

  const clampedLow = clampFocalToLens(10, 'wide');
  const clampedHigh = clampFocalToLens(500, 'wide');
  const clampedMid = clampFocalToLens(24, 'wide');
  check(
    'clampFocalToLens 边界',
    clampedLow === 14 && clampedHigh === 35 && clampedMid === 24,
    `10→${clampedLow}, 500→${clampedHigh}, 24→${clampedMid}`,
  );

  const baseSettings: CameraSettings = {
    shutter: 1 / 250,
    aperture: 4,
    iso: 200,
    exposureComp: 0,
    metering: 'evaluative',
    focusMode: 'auto',
    focusDistance: 3,
    focusPoint: { x: 0.5, y: 0.5 },
    focusPeak: false,
    dofPreview: false,
    wbPreset: 'daylight',
    wbTemp: 5500,
    wbTint: 0,
    focalLength: 50,
    ndStops: 0,
    shutterType: 'mechanical',
    driveMode: 'single',
    burstFrames: 5,
    timerSeconds: 2,
    bracketingEnabled: false,
    bracketFrames: 3,
    bracketStepEV: 1,
    hdrEnabled: false,
    flashEnabled: false,
    flashPowerEV: 0,
    flashSync: 'front',
    stabilization: true,
    zebra: false,
    guides: false,
    level: false,
    filmSim: 'standard',
    lutEnabled: false,
    lutName: '',
    lens: 'standard',
    sensor: 'full',
    fileFormat: 'jpeg',
  };
  const roundTrip = deserializePreset(serializePreset(baseSettings, 'test'), baseSettings);
  check(
    '序列化/反序列化往返保留 aperture/iso',
    roundTrip !== null && roundTrip.settings.aperture === 4 && roundTrip.settings.iso === 200 && roundTrip.name === 'test',
    roundTrip ? `aperture=${roundTrip.settings.aperture}, iso=${roundTrip.settings.iso}, name=${roundTrip.name}` : 'null',
  );

  check(
    '非法 JSON 反序列化返回 null',
    deserializePreset('{not json', baseSettings) === null &&
      deserializePreset('{"name":"x","settings":{}}', baseSettings) === null,
    'bad json 与缺少数值字段均返回 null',
  );

  const blurFull = diffractionBlurForSensor(8, 'full');
  const blurM43 = diffractionBlurForSensor(8, 'm43');
  check(
    '衍射模糊随裁切系数缩放 m43 > full',
    blurM43 > blurFull && Math.abs(blurM43 / blurFull - m43.crop / full.crop) < 1e-9,
    `full=${blurFull.toFixed(4)}μm, m43=${blurM43.toFixed(4)}μm`,
  );

  return results;
}

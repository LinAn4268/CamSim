// src/types/camera.ts — 相机参数与状态类型定义
// 所有物理量都有明确单位，字段命名带单位后缀（mm / s / K / eV）。

export type MeteringMode = 'evaluative' | 'center' | 'spot';
export type FocusMode = 'manual' | 'auto';
export type WbPreset = 'daylight' | 'cloudy' | 'tungsten' | 'fluorescent' | 'custom';
export type DriveMode = 'single' | 'burst' | 'timer';

/** P1：快门类型。机械=全局曝光；电子=逐行读出，可能产生果冻效应。 */
export type ShutterType = 'mechanical' | 'electronic';
/** P1：胶片模拟 / 色彩风格（1D 色调 LUT + 饱和度矩阵）。 */
export type FilmSimulation = 'standard' | 'portrait' | 'landscape' | 'mono' | 'log';
/** P1：闪光同步方式。前帘=曝光开始；后帘=曝光结束（拖影在主体前方）。 */
export type FlashSync = 'front' | 'rear';
/** P2：传感器规格。裁切系数、CoC、噪点尺度随尺寸变化。 */
export type SensorId = 'full' | 'aps-c' | 'm43';
/** P2：镜头（决定焦距范围与基础畸变特性）。 */
export type LensId = 'wide' | 'standard' | 'tele';
/** P2：文件格式。JPEG=机内处理后输出；RAW=保留线性高光，需显影。 */
export type FileFormat = 'jpeg' | 'raw';

export interface CameraSettings {
  shutter: number;       // 曝光时间，秒（s），1/8000 ~ 30
  aperture: number;      // 光圈值 N（无量纲），f/1.4 ~ f/22
  iso: number;           // 感光度（无量纲），100 ~ 25600（可扩 51200）
  exposureComp: number;  // 曝光补偿（eV），-5 ~ +5，步进 1/3
  metering: MeteringMode;
  focusMode: FocusMode;
  focusDistance: number; // 对焦距离，米（m）
  focusPoint: { x: number; y: number }; // 归一化画面坐标 0..1
  focusPeak: boolean;    // 对焦峰值显示
  dofPreview: boolean;   // 景深预览（收缩光圈）
  wbPreset: WbPreset;
  wbTemp: number;        // 色温，开尔文（K），2000 ~ 10000
  wbTint: number;        // 色调偏移（绿-品红轴），-100 ~ +100
  focalLength: number;   // 焦距，毫米（mm）
  ndStops: number;       // ND 滤镜档数，0 ~ 10（P1）

  // ---- P1 ----
  shutterType: ShutterType;
  driveMode: DriveMode;
  burstFrames: number;      // 连拍张数 3 / 5 / 10
  timerSeconds: number;     // 定时拍摄秒数 2 / 5 / 10
  bracketingEnabled: boolean; // 包围曝光开关
  bracketFrames: number;    // 包围张数 3 / 5 / 7
  bracketStepEV: number;    // 包围步进 EV（1 / 2 / 3）
  hdrEnabled: boolean;      // HDR 多曝光合成（需开启包围曝光）
  flashEnabled: boolean;
  flashPowerEV: number;     // 闪光输出相对 EV，-3 ~ +3
  flashSync: FlashSync;
  stabilization: boolean;   // 防抖：抑制手抖造成的整体模糊
  zebra: boolean;           // 斑马纹过曝警告
  guides: boolean;          // 构图辅助线
  level: boolean;           // 电子水平仪
  filmSim: FilmSimulation;
  lutEnabled: boolean;      // 3D LUT / 曲线（非物理色彩风格）
  lutName: string;          // 当前 LUT 名称（内置曲线或导入的 .cube）

  // ---- P2 ----
  lens: LensId;
  sensor: SensorId;
  fileFormat: FileFormat;
}

export interface SceneSettings {
  keyIntensity: number;  // 主光强度（相对单位）
  keyTemp: number;       // 主光色温 K
  keyAzimuth: number;    // 主光方位角 弧度
  keyElevation: number;  // 主光仰角 弧度
  ambientIntensity: number; // 环境光强度
  motionSpeed: number;   // 运动物体角速度（rad/s）
  motionEnabled: boolean;
  cameraRoll: number;    // 相机倾斜角（度），用于水平仪验证
}

export interface MeteringResult {
  ev: number;            // 测光得到的场景亮度 EV（ISO100 基准）
  suggestedShutter: number; // 建议快门（s）
  luminance: number;     // 测光区域平均线性亮度
}

export interface PhotoExif {
  shutter: string;
  aperture: string;
  iso: number;
  focalLength: string;
  ev: number;
  exposureComp: number;
  metering: MeteringMode;
  wb: string;
  wbTemp: number;
  focusDistance: number;
  timestamp: string;
  // P1 / P2 扩展
  shutterType: ShutterType;
  driveMode: DriveMode;
  ndStops: number;
  flash: string;
  stabilization: boolean;
  filmSim: FilmSimulation;
  lens: LensId;
  sensor: SensorId;
  fileFormat: FileFormat;
  bracketEV?: number;     // 包围曝光的相对 EV 偏移
  hdr?: boolean;          // 是否为多曝光合成结果
  lut?: string;
}

export interface Photo {
  id: string;
  dataUrl: string;
  exif: PhotoExif;
  width: number;
  height: number;
  format: FileFormat;
  /** RAW：线性场景数据（0..255 表示 0..16 线性光），未做色调映射/胶片模拟，用于重新显影。 */
  rawLinear?: Uint8Array;
  bracketId?: string;     // 同一组包围曝光的关联 ID
  bracketIndex?: number;
  hdr?: boolean;
}

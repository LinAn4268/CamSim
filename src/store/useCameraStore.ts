// src/store/useCameraStore.ts — 集中式相机状态（唯一数据源），UI 与渲染通过它解耦

import { create } from 'zustand';
import type {
  CameraSettings, SceneSettings, Photo, PhotoExif, MeteringMode, WbPreset, FocusMode,
  ShutterType, DriveMode, FlashSync, FilmSimulation, SensorId, LensId, FileFormat,
} from '../types/camera';
import { exposureValue, clamp, SHUTTER_STOPS, APERTURE_STOPS, ISO_STOPS } from '../camera/physics';
import { WB_PRESET_TEMP } from '../camera/whiteBalance';
import { DEFAULT_ADVANCED, bracketEVs } from '../camera/advanced';
import { SENSOR_PROFILES, LENS_PROFILES, clampFocalToLens } from '../camera/optics';

export interface CameraState {
  settings: CameraSettings;
  scene: SceneSettings;
  photos: Photo[];
  activePhotoId: string | null;
  showPlayback: boolean;
  // 由渲染管线回写的实时数据
  meterEV: number;
  meterShutter: number;
  histogram: { r: number[]; g: number[]; b: number[]; luma: number[] };
  overexposedRatio: number;
  underexposedRatio: number;
  fps: number;
  // P1：连拍/定时/包围的运行时状态
  shooting: boolean;
  countdown: number;
  lastBracket: Array<{ ev: number; photoId: string }>;
  hdrResultId: string | null;
  customLuts: Record<string, string>; // 用户导入的 .cube 文本

  // actions — P0
  setShutter: (v: number) => void;
  setAperture: (v: number) => void;
  setIso: (v: number) => void;
  setExposureComp: (v: number) => void;
  setMetering: (v: MeteringMode) => void;
  setFocusMode: (v: FocusMode) => void;
  setFocusDistance: (v: number) => void;
  setFocusPoint: (x: number, y: number) => void;
  toggleFocusPeak: () => void;
  toggleDofPreview: () => void;
  setWbPreset: (v: WbPreset) => void;
  setWbTemp: (v: number) => void;
  setWbTint: (v: number) => void;
  setFocalLength: (v: number) => void;
  setNdStops: (v: number) => void;
  setScene: (patch: Partial<SceneSettings>) => void;
  setMeter: (ev: number, shutter: number) => void;
  setHistogram: (h: CameraState['histogram'], over: number, under: number) => void;
  setFps: (v: number) => void;
  addPhoto: (p: Photo) => void;
  addPhotos: (photos: Photo[]) => void;
  setActivePhoto: (id: string | null) => void;
  setShowPlayback: (v: boolean) => void;
  resetCamera: () => void;
  resetScene: () => void;

  // actions — P1
  setShutterType: (v: ShutterType) => void;
  setDriveMode: (v: DriveMode) => void;
  setBurstFrames: (v: number) => void;
  setTimerSeconds: (v: number) => void;
  setBracketing: (enabled: boolean) => void;
  setBracketFrames: (v: number) => void;
  setBracketStep: (v: number) => void;
  setHdr: (enabled: boolean) => void;
  setFlash: (enabled: boolean) => void;
  setFlashPower: (v: number) => void;
  setFlashSync: (v: FlashSync) => void;
  setStabilization: (enabled: boolean) => void;
  toggleZebra: () => void;
  toggleGuides: () => void;
  toggleLevel: () => void;
  setFilmSim: (v: FilmSimulation) => void;
  setLut: (name: string) => void;
  addCustomLut: (name: string, text: string) => void;
  setShooting: (v: boolean) => void;
  setCountdown: (v: number) => void;
  setLastBracket: (v: Array<{ ev: number; photoId: string }>) => void;
  setHdrResult: (id: string | null) => void;

  // actions — P2
  setLens: (v: LensId) => void;
  setSensor: (v: SensorId) => void;
  setFileFormat: (v: FileFormat) => void;
  loadPreset: (settings: Partial<CameraSettings>) => void;
}

const defaultSettings: CameraSettings = {
  shutter: 1 / 125,
  aperture: 5.6,
  iso: 400,
  exposureComp: 0,
  metering: 'evaluative',
  focusMode: 'auto',
  focusDistance: 7,
  focusPoint: { x: 0.5, y: 0.5 },
  focusPeak: false,
  dofPreview: false,
  wbPreset: 'daylight',
  wbTemp: 5500,
  wbTint: 0,
  focalLength: 50,
  ndStops: 0,
  ...DEFAULT_ADVANCED,
  lens: 'standard',
  sensor: 'full',
  fileFormat: 'jpeg',
};

const defaultScene: SceneSettings = {
  keyIntensity: 3.0,
  keyTemp: 5500,
  keyAzimuth: 0.8,
  keyElevation: 0.9,
  ambientIntensity: 0.35,
  motionSpeed: 1.2,
  motionEnabled: true,
  cameraRoll: 0,
};

/** 按档位对齐数值步进（用于快门/光圈/ISO 调节）。 */
export function quantizeStop(value: number, stops: readonly number[]): number {
  let best = stops[0];
  for (const s of stops) if (Math.abs(Math.log(s / value)) < Math.abs(Math.log(best / value))) best = s;
  return best;
}

export function makeExif(s: CameraSettings, extra: Partial<PhotoExif> = {}): PhotoExif {
  const shutterStr = s.shutter >= 1 ? `${s.shutter}s` : `1/${Math.round(1 / s.shutter)}s`;
  const flashName = s.flashEnabled
    ? `${s.flashSync === 'rear' ? '后帘' : '前帘'}同步 ${s.flashPowerEV >= 0 ? '+' : ''}${s.flashPowerEV}EV`
    : '关';
  return {
    shutter: shutterStr,
    aperture: `f/${s.aperture}`,
    iso: s.iso,
    focalLength: `${Math.round(s.focalLength)}mm`,
    ev: exposureValue(s.aperture, s.shutter, s.iso),
    exposureComp: s.exposureComp,
    metering: s.metering,
    wb: s.wbPreset,
    wbTemp: s.wbTemp,
    focusDistance: s.focusDistance,
    timestamp: new Date().toLocaleString('zh-CN'),
    shutterType: s.shutterType,
    driveMode: s.driveMode,
    ndStops: s.ndStops,
    flash: flashName,
    stabilization: s.stabilization,
    filmSim: s.filmSim,
    lens: s.lens,
    sensor: s.sensor,
    fileFormat: s.fileFormat,
    lut: s.lutEnabled ? s.lutName : undefined,
    ...extra,
  };
}

export const useCameraStore = create<CameraState>((set) => ({
  settings: { ...defaultSettings },
  scene: { ...defaultScene },
  photos: [],
  activePhotoId: null,
  showPlayback: false,
  meterEV: 0,
  meterShutter: 1 / 125,
  histogram: { r: [], g: [], b: [], luma: [] },
  overexposedRatio: 0,
  underexposedRatio: 0,
  fps: 0,
  shooting: false,
  countdown: 0,
  lastBracket: [],
  hdrResultId: null,
  customLuts: {},

  // ---- P0 ----
  setShutter: (v) => set((st) => ({ settings: { ...st.settings, shutter: clamp(v, 1 / 8000, 30) } })),
  setAperture: (v) => set((st) => ({ settings: { ...st.settings, aperture: clamp(v, 1.4, 22) } })),
  setIso: (v) => set((st) => ({ settings: { ...st.settings, iso: clamp(Math.round(v), 50, 51200) } })),
  setExposureComp: (v) => set((st) => ({ settings: { ...st.settings, exposureComp: clamp(v, -5, 5) } })),
  setMetering: (v) => set((st) => ({ settings: { ...st.settings, metering: v } })),
  setFocusMode: (v) => set((st) => ({ settings: { ...st.settings, focusMode: v } })),
  setFocusDistance: (v) => set((st) => ({ settings: { ...st.settings, focusDistance: clamp(v, 0.1, 100) } })),
  setFocusPoint: (x, y) => set((st) => ({ settings: { ...st.settings, focusPoint: { x: clamp(x, 0, 1), y: clamp(y, 0, 1) } } })),
  toggleFocusPeak: () => set((st) => ({ settings: { ...st.settings, focusPeak: !st.settings.focusPeak } })),
  toggleDofPreview: () => set((st) => ({ settings: { ...st.settings, dofPreview: !st.settings.dofPreview } })),
  setWbPreset: (v) => set((st) => ({ settings: { ...st.settings, wbPreset: v, wbTemp: WB_PRESET_TEMP[v] ?? st.settings.wbTemp } })),
  setWbTemp: (v) => set((st) => ({ settings: { ...st.settings, wbTemp: clamp(v, 2000, 10000), wbPreset: 'custom' } })),
  setWbTint: (v) => set((st) => ({ settings: { ...st.settings, wbTint: clamp(v, -100, 100), wbPreset: 'custom' } })),
  setFocalLength: (v) => set((st) => ({ settings: { ...st.settings, focalLength: clamp(v, 1, 1000) } })),
  setNdStops: (v) => set((st) => ({ settings: { ...st.settings, ndStops: clamp(v, 0, 10) } })),
  setScene: (patch) => set((st) => ({ scene: { ...st.scene, ...patch } })),
  setMeter: (ev, shutter) => set({ meterEV: ev, meterShutter: shutter }),
  setHistogram: (h, over, under) => set({ histogram: h, overexposedRatio: over, underexposedRatio: under }),
  setFps: (v) => set({ fps: v }),
  addPhoto: (p) => set((st) => ({ photos: [p, ...st.photos].slice(0, 48), activePhotoId: p.id, showPlayback: true })),
  addPhotos: (newPhotos) => set((st) => (newPhotos.length === 0 ? st : ({
    photos: [...newPhotos, ...st.photos].slice(0, 48),
    activePhotoId: newPhotos[0].id,
    showPlayback: true,
  }))),
  setActivePhoto: (id) => set({ activePhotoId: id }),
  setShowPlayback: (v) => set({ showPlayback: v }),
  resetCamera: () => set((st) => ({ settings: { ...defaultSettings }, customLuts: st.customLuts })),
  resetScene: () => set({ scene: { ...defaultScene } }),

  // ---- P1 ----
  setShutterType: (v) => set((st) => ({ settings: { ...st.settings, shutterType: v } })),
  setDriveMode: (v) => set((st) => ({ settings: { ...st.settings, driveMode: v } })),
  setBurstFrames: (v) => set((st) => ({ settings: { ...st.settings, burstFrames: [3, 5, 10].includes(v) ? v : 5 } })),
  setTimerSeconds: (v) => set((st) => ({ settings: { ...st.settings, timerSeconds: [2, 5, 10].includes(v) ? v : 2 } })),
  setBracketing: (enabled) => set((st) => ({ settings: { ...st.settings, bracketingEnabled: enabled, hdrEnabled: enabled ? st.settings.hdrEnabled : false } })),
  setBracketFrames: (v) => set((st) => ({ settings: { ...st.settings, bracketFrames: [3, 5, 7].includes(v) ? v : 3 } })),
  setBracketStep: (v) => set((st) => ({ settings: { ...st.settings, bracketStepEV: clamp(Math.round(v), 1, 3) } })),
  setHdr: (enabled) => set((st) => ({ settings: { ...st.settings, hdrEnabled: enabled, bracketingEnabled: enabled ? true : st.settings.bracketingEnabled } })),
  setFlash: (enabled) => set((st) => ({ settings: { ...st.settings, flashEnabled: enabled } })),
  setFlashPower: (v) => set((st) => ({ settings: { ...st.settings, flashPowerEV: clamp(v, -3, 3) } })),
  setFlashSync: (v) => set((st) => ({ settings: { ...st.settings, flashSync: v } })),
  setStabilization: (enabled) => set((st) => ({ settings: { ...st.settings, stabilization: enabled } })),
  toggleZebra: () => set((st) => ({ settings: { ...st.settings, zebra: !st.settings.zebra } })),
  toggleGuides: () => set((st) => ({ settings: { ...st.settings, guides: !st.settings.guides } })),
  toggleLevel: () => set((st) => ({ settings: { ...st.settings, level: !st.settings.level } })),
  setFilmSim: (v) => set((st) => ({ settings: { ...st.settings, filmSim: v } })),
  setLut: (name) => set((st) => ({ settings: { ...st.settings, lutName: name, lutEnabled: name !== 'None' } })),
  addCustomLut: (name, text) => set((st) => ({ customLuts: { ...st.customLuts, [name]: text }, settings: { ...st.settings, lutName: name, lutEnabled: true } })),
  setShooting: (v) => set({ shooting: v }),
  setCountdown: (v) => set({ countdown: v }),
  setLastBracket: (v) => set({ lastBracket: v }),
  setHdrResult: (id) => set({ hdrResultId: id }),

  // ---- P2 ----
  setLens: (v) => set((st) => ({
    settings: { ...st.settings, lens: v, focalLength: clampFocalToLens(st.settings.focalLength, v) },
  })),
  setSensor: (v) => set((st) => ({
    settings: { ...st.settings, sensor: v, focalLength: clamp(st.settings.focalLength, 1, 1000) },
  })),
  setFileFormat: (v) => set((st) => ({ settings: { ...st.settings, fileFormat: v } })),
  loadPreset: (patch) => set((st) => ({
    settings: {
      ...st.settings,
      ...patch,
      focalLength: clampFocalToLens(patch.focalLength ?? st.settings.focalLength, patch.lens ?? st.settings.lens),
    },
  })),
}));

export { defaultSettings, defaultScene, SHUTTER_STOPS, APERTURE_STOPS, ISO_STOPS, bracketEVs, SENSOR_PROFILES, LENS_PROFILES };

// src/store/useCameraStore.test.ts — 状态层纯逻辑单测（quantizeStop / makeExif / 设置器约束 / 联动）
import { beforeEach, describe, it, expect } from 'vitest';
import { useCameraStore, quantizeStop, makeExif, defaultSettings } from './useCameraStore';
import { SHUTTER_STOPS, APERTURE_STOPS, ISO_STOPS } from './useCameraStore';
import type { CameraSettings } from '../types/camera';

const st = () => useCameraStore.getState();

beforeEach(() => {
  // 每个用例前重置回默认值，避免状态在用例间泄漏
  st().resetCamera();
  st().resetScene();
  st().setBracketing(false);
  st().setHdr(false);
});

describe('quantizeStop', () => {
  it('已存在的档位原样返回', () => {
    expect(quantizeStop(5.6, APERTURE_STOPS)).toBe(5.6);
    expect(quantizeStop(1 / 125, SHUTTER_STOPS)).toBe(1 / 125);
    expect(quantizeStop(400, ISO_STOPS)).toBe(400);
  });

  it('取对数距离最近的档位', () => {
    expect(quantizeStop(4.5, APERTURE_STOPS)).toBe(4);
    expect(quantizeStop(6.5, APERTURE_STOPS)).toBe(5.6);
    expect(quantizeStop(7.5, APERTURE_STOPS)).toBe(8);
    expect(quantizeStop(150, ISO_STOPS)).toBe(200);
  });
});

describe('makeExif', () => {
  const base = (over: Partial<CameraSettings> = {}): CameraSettings => ({ ...defaultSettings, ...over });

  it('输出基础 P0 EXIF 字段', () => {
    const e = makeExif(base({ shutter: 1 / 125, aperture: 5.6, iso: 400, focalLength: 50, wbTemp: 5500 }));
    expect(e.shutter).toBe('1/125s');
    expect(e.aperture).toBe('f/5.6');
    expect(e.iso).toBe(400);
    expect(e.focalLength).toBe('50mm');
    expect(e.wbTemp).toBe(5500);
    expect(e.timestamp).toBeTruthy();
  });

  it('慢门以 xxs 形式输出', () => {
    expect(makeExif(base({ shutter: 2 })).shutter).toBe('2s');
    expect(makeExif(base({ shutter: 1 / 8000 })).shutter).toBe('1/8000s');
  });

  it('包含 P1 字段：快门类型/驱动/ND/防抖/风格/LUT', () => {
    const e = makeExif(base({
      shutterType: 'electronic', driveMode: 'burst', ndStops: 2,
      stabilization: true, filmSim: 'mono', lutEnabled: true, lutName: 'Warm Film',
    }));
    expect(e.shutterType).toBe('electronic');
    expect(e.driveMode).toBe('burst');
    expect(e.ndStops).toBe(2);
    expect(e.stabilization).toBe(true);
    expect(e.filmSim).toBe('mono');
    expect(e.lut).toBe('Warm Film');
  });

  it('LUT 未启用时 lut 为 undefined', () => {
    expect(makeExif(base({ lutEnabled: false, lutName: 'Warm Film' })).lut).toBeUndefined();
  });

  it('闪光描述含同步帘幕与闪光补偿；关闭时为“关”', () => {
    const on = makeExif(base({ flashEnabled: true, flashSync: 'rear', flashPowerEV: 1 }));
    expect(on.flash).toContain('后帘');
    expect(on.flash).toContain('+1EV');
    expect(makeExif(base({ flashEnabled: false })).flash).toBe('关');
  });

  it('P2 字段：传感器/镜头/文件格式，且 extra 覆盖默认', () => {
    const e = makeExif(base({ sensor: 'm43', lens: 'tele', fileFormat: 'raw' }));
    expect(e.sensor).toBe('m43');
    expect(e.lens).toBe('tele');
    expect(e.fileFormat).toBe('raw');
    const overridden = makeExif(base(), { bracketEV: 1, hdr: true, fileFormat: 'jpeg' });
    expect(overridden.bracketEV).toBe(1);
    expect(overridden.hdr).toBe(true);
    expect(overridden.fileFormat).toBe('jpeg'); // extra 覆盖 s 推导值
  });
});

describe('设置器约束', () => {
  it('P0 参数钳制到合法范围', () => {
    st().setShutter(1 / 100000);
    expect(st().settings.shutter).toBe(1 / 8000);
    st().setIso(999999);
    expect(st().settings.iso).toBe(51200);
    st().setAperture(0.5);
    expect(st().settings.aperture).toBe(1.4);
    st().setExposureComp(99);
    expect(st().settings.exposureComp).toBe(5);
    st().setNdStops(-3);
    expect(st().settings.ndStops).toBe(0);
    st().setWbTemp(99999);
    expect(st().settings.wbTemp).toBe(10000);
    expect(st().settings.wbPreset).toBe('custom');
  });

  it('P1 枚举/离散参数使用白名单回退', () => {
    st().setBurstFrames(7 as 5);
    expect(st().settings.burstFrames).toBe(5);
    st().setBurstFrames(10);
    expect(st().settings.burstFrames).toBe(10);
    st().setTimerSeconds(3 as 2);
    expect(st().settings.timerSeconds).toBe(2);
    st().setBracketFrames(4 as 3);
    expect(st().settings.bracketFrames).toBe(3);
    st().setBracketStep(9 as 1);
    expect(st().settings.bracketStepEV).toBe(3);
    st().setFlashPower(9 as 0);
    expect(st().settings.flashPowerEV).toBe(3);
  });

  it('包围曝光与 HDR 联动：关 BKT 连带关 HDR；开 HDR 连带开 BKT', () => {
    st().setHdr(true);
    expect(st().settings.bracketingEnabled).toBe(true);
    expect(st().settings.hdrEnabled).toBe(true);
    st().setBracketing(false);
    expect(st().settings.hdrEnabled).toBe(false);
  });

  it('LUT 选择联动启用状态', () => {
    st().setLut('Neutral');
    expect(st().settings.lutEnabled).toBe(true);
    st().setLut('None');
    expect(st().settings.lutEnabled).toBe(false);
  });

  it('addPhoto / addPhotos 与胶片上限 48', () => {
    const mk = (id: string) => ({ id } as never);
    st().addPhotos([mk('a'), mk('b')]);
    expect(st().photos.length).toBe(2);
    expect(st().activePhotoId).toBe('a');
    expect(st().showPlayback).toBe(true);
    st().addPhotos([]);
    expect(st().photos.length).toBe(2); // 空数组 no-op
    st().addPhotos(Array.from({ length: 60 }, (_, i) => mk(`p${i}`)));
    expect(st().photos.length).toBe(48);
  });

  it('resetCamera 恢复默认但保留自定义 LUT', () => {
    st().addCustomLut('Mine', 'LUT_3D_SIZE 2\n0 0 0\n');
    st().setIso(6400);
    st().resetCamera();
    expect(st().settings.iso).toBe(defaultSettings.iso);
    expect(st().customLuts['Mine']).toBeTruthy();
  });

  it('setLens 把焦距钳制到镜头范围', () => {
    st().setLens('tele');   // 70-200
    expect(st().settings.focalLength).toBeGreaterThanOrEqual(70);
    st().setLens('wide');   // 14-35
    expect(st().settings.focalLength).toBeLessThanOrEqual(35);
  });

  it('其余设置器均能更新对应状态（全量冒烟）', () => {
    const s = st();
    s.setMetering('spot');          expect(st().settings.metering).toBe('spot');
    s.setFocusMode('auto');         expect(st().settings.focusMode).toBe('auto');
    s.setFocusDistance(2.5);        expect(st().settings.focusDistance).toBe(2.5);
    s.setFocusPoint(0.3, 0.7);      expect(st().settings.focusPoint).toEqual({ x: 0.3, y: 0.7 });
    const peakBefore = st().settings.focusPeak;
    s.toggleFocusPeak();            expect(st().settings.focusPeak).toBe(!peakBefore);
    const dofBefore = st().settings.dofPreview;
    s.toggleDofPreview();           expect(st().settings.dofPreview).toBe(!dofBefore);
    s.setWbPreset('tungsten');      expect(st().settings.wbTemp).toBe(3200);
    s.setWbTint(20);               expect(st().settings.wbTint).toBe(20);
    s.setFocalLength(85);          expect(st().settings.focalLength).toBe(85);
    s.setScene({ keyIntensity: 5 }); expect(st().scene.keyIntensity).toBe(5);
    s.setMeter(1.25, 1 / 250);     expect(st().meterEV).toBe(1.25); expect(st().meterShutter).toBe(1 / 250);
    s.setHistogram({ r: [1], g: [2], b: [3], luma: [4] }, 0.1, 0.2);
    expect(st().overexposedRatio).toBe(0.1); expect(st().underexposedRatio).toBe(0.2);
    s.setFps(60);                  expect(st().fps).toBe(60);
    const photo = { id: 'x' } as never;
    s.addPhoto(photo);             expect(st().activePhotoId).toBe('x');
    s.setActivePhoto('x');         expect(st().activePhotoId).toBe('x');
    s.setShowPlayback(false);      expect(st().showPlayback).toBe(false);
    s.setShutterType('electronic'); expect(st().settings.shutterType).toBe('electronic');
    s.setDriveMode('timer');       expect(st().settings.driveMode).toBe('timer');
    s.setFlash(true);              expect(st().settings.flashEnabled).toBe(true);
    s.setFlashSync('rear');        expect(st().settings.flashSync).toBe('rear');
    s.setStabilization(true);      expect(st().settings.stabilization).toBe(true);
    const zebraBefore = st().settings.zebra;
    s.toggleZebra();               expect(st().settings.zebra).toBe(!zebraBefore);
    const guidesBefore = st().settings.guides;
    s.toggleGuides();              expect(st().settings.guides).toBe(!guidesBefore);
    const levelBefore = st().settings.level;
    s.toggleLevel();               expect(st().settings.level).toBe(!levelBefore);
    s.setFilmSim('landscape');     expect(st().settings.filmSim).toBe('landscape');
    s.setShooting(true);           expect(st().shooting).toBe(true);
    s.setCountdown(3);             expect(st().countdown).toBe(3);
    s.setLastBracket([photo]);     expect(st().lastBracket.length).toBe(1);
    s.setHdrResult('hdr1');        expect(st().hdrResultId).toBe('hdr1');
    s.setSensor('aps-c');          expect(st().settings.sensor).toBe('aps-c');
    s.setFileFormat('raw');        expect(st().settings.fileFormat).toBe('raw');
    s.loadPreset({ iso: 800, lens: 'standard', focalLength: 50 });
    expect(st().settings.iso).toBe(800); expect(st().settings.focalLength).toBe(50);
  });
});

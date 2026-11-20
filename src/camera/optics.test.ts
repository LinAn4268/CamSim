import { describe, it, expect } from 'vitest';
import {
  SENSOR_PROFILES, LENS_PROFILES, sensorFieldOfView, sensorDepthOfField,
  sensorNoiseScale, diffractionBlurForSensor, effectiveApertureForDoF,
  serializePreset, deserializePreset, clampFocalToLens, runOpticsSelfTest,
} from './optics';
import { defaultSettings } from '../store/useCameraStore';

describe('optics (P2)', () => {
  it('自测套件全通过', () => {
    expect(runOpticsSelfTest().filter((c) => !c.pass)).toEqual([]);
  });

  it('传感器裁切系数递增', () => {
    expect(SENSOR_PROFILES.full.crop).toBe(1);
    expect(SENSOR_PROFILES['aps-c'].crop).toBeGreaterThan(1);
    expect(SENSOR_PROFILES.m43.crop).toBeGreaterThan(SENSOR_PROFILES['aps-c'].crop);
  });

  it('同焦距小传感器视角更窄', () => {
    expect(sensorFieldOfView(50, 'm43')).toBeLessThan(sensorFieldOfView(50, 'full'));
  });

  it('同参数小传感器景深更浅（CoC 更小）', () => {
    expect(sensorDepthOfField(50, 2.8, 5, 'm43').total)
      .toBeLessThan(sensorDepthOfField(50, 2.8, 5, 'full').total);
  });

  it('噪点尺度与衍射随裁切增大', () => {
    expect(sensorNoiseScale('m43')).toBeGreaterThan(sensorNoiseScale('full'));
    expect(diffractionBlurForSensor(8, 'm43')).toBeGreaterThan(diffractionBlurForSensor(8, 'full'));
    expect(effectiveApertureForDoF(5.6, 'aps-c')).toBeGreaterThan(5.6);
  });

  it('镜头焦距范围钳制', () => {
    expect(clampFocalToLens(10, 'wide')).toBe(LENS_PROFILES.wide.minFocal);
    expect(clampFocalToLens(500, 'standard')).toBe(LENS_PROFILES.standard.maxFocal);
    expect(clampFocalToLens(50, 'standard')).toBe(50);
  });

  it('预设序列化往返', () => {
    const json = serializePreset(defaultSettings, '测试预设');
    const parsed = deserializePreset(json, defaultSettings);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('测试预设');
    expect(parsed!.settings.aperture).toBe(defaultSettings.aperture);
    expect(deserializePreset('{bad', defaultSettings)).toBeNull();
  });
});

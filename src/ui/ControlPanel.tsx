// src/ui/ControlPanel.tsx — 专家级相机控制面板（P0 + P1 + P2 全部参数集中可见可操作）

import { useCameraStore } from '../store/useCameraStore';
import { safeShutter } from '../camera/physics';
import {
  sensorFieldOfView, sensorDepthOfField, diffractionBlurForSensor, SENSOR_PROFILES, LENS_PROFILES,
  serializePreset, deserializePreset, formatFileFormat,
} from '../camera/optics';
import { flashSyncDescription } from '../camera/advanced';
import { BUILTIN_LUTS } from '../camera/film';
import type {
  MeteringMode, WbPreset, ShutterType, DriveMode, FlashSync,
  FilmSimulation, SensorId, LensId, FileFormat,
} from '../types/camera';

const formatShutter = (t: number) => (t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}`);

function Slider({ label, value, min, max, step, unit, onChange, display }: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void; display?: string;
}) {
  return (
    <label className="slider-row">
      <div className="slider-head"><span>{label}</span><b>{display ?? `${value}${unit}`}</b></div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Toggle({ label, active, onClick, hint }: {
  label: string; active: boolean; onClick: () => void; hint?: string;
}) {
  return (
    <button className={`toggle-btn ${active ? 'active' : ''}`} onClick={onClick} title={hint}>
      <span className="toggle-dot" />{label}
    </button>
  );
}

export function ControlPanel() {
  const s = useCameraStore((st) => st.settings);
  const sc = useCameraStore((st) => st.scene);
  const customLuts = useCameraStore((st) => st.customLuts);
  const set = useCameraStore;
  const dof = sensorDepthOfField(s.focalLength, s.aperture, s.focusDistance, s.sensor);
  const sensor = SENSOR_PROFILES[s.sensor];
  const lens = LENS_PROFILES[s.lens];
  const lutOptions = ['None', ...Object.keys(BUILTIN_LUTS), ...Object.keys(customLuts)];

  const exportPreset = () => {
    const json = serializePreset(s, `${sensor.label} · ${lens.labelText}`);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'camera-preset.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importPreset = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = deserializePreset(String(reader.result), s);
      if (parsed) set.getState().loadPreset(parsed.settings);
      else window.alert('预设文件格式无效');
    };
    reader.readAsText(file);
  };
  const importLut = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const name = file.name.replace(/\.cube$/i, '') || '自定义 LUT';
      set.getState().addCustomLut(name, String(reader.result));
    };
    reader.readAsText(file);
  };

  return (
    <div className="control-panel">
      <div className="panel-section">
        <div className="module-title">曝光三角 <span className="hint">EXPOSURE</span></div>
        <Slider label="快门速度" value={Math.log2(s.shutter)} min={-12.97} max={4.91} step={0.01}
          unit="" display={formatShutter(s.shutter)} onChange={(v) => set.getState().setShutter(Math.pow(2, v))} />
        <div className="quick-row">
          {[1 / 1000, 1 / 250, 1 / 60, 1 / 15, 1].map(t => (
            <button key={t} className={s.shutter === t ? 'active' : ''} onClick={() => set.getState().setShutter(t)}>{formatShutter(t)}</button>
          ))}
        </div>
        <Slider label="光圈" value={s.aperture} min={1.4} max={22} step={0.1} unit=""
          display={`f/${s.aperture.toFixed(1)}`} onChange={(v) => set.getState().setAperture(v)} />
        <div className="quick-row">
          {[1.4, 2.8, 4, 5.6, 8, 11, 16].map(n => (
            <button key={n} className={s.aperture === n ? 'active' : ''} onClick={() => set.getState().setAperture(n)}>f/{n}</button>
          ))}
        </div>
        <Slider label="ISO" value={Math.log2(s.iso / 100)} min={-1} max={9} step={1} unit=""
          display={`ISO ${s.iso}`} onChange={(v) => set.getState().setIso(100 * Math.pow(2, v))} />
        <Slider label="曝光补偿" value={s.exposureComp} min={-5} max={5} step={1 / 3} unit=" EV"
          display={`${s.exposureComp >= 0 ? '+' : ''}${s.exposureComp.toFixed(2)} EV`}
          onChange={(v) => set.getState().setExposureComp(v)} />
        <Slider label="ND 滤镜" value={s.ndStops} min={0} max={10} step={1} unit=" 档"
          display={`ND ${s.ndStops} 档 · 等效 ${formatShutter(s.shutter * Math.pow(2, s.ndStops))}`}
          onChange={(v) => set.getState().setNdStops(v)} />
      </div>

      <div className="panel-section">
        <div className="module-title">测光 <span className="hint">METERING</span></div>
        <div className="btn-group">
          {([['evaluative', '评价'], ['center', '中央重点'], ['spot', '点测光']] as [MeteringMode, string][]).map(([m, l]) => (
            <button key={m} className={s.metering === m ? 'active' : ''} onClick={() => set.getState().setMetering(m)}>{l}</button>
          ))}
        </div>
        <div className="btn-group">
          <Toggle label="斑马纹警告" active={s.zebra} onClick={() => set.getState().toggleZebra()} hint="高亮区域叠加斜纹，提示过曝" />
          <Toggle label="构图辅助线" active={s.guides} onClick={() => set.getState().toggleGuides()} />
          <Toggle label="电子水平仪" active={s.level} onClick={() => set.getState().toggleLevel()} hint="配合下方「相机倾斜」检查水平" />
        </div>
        {s.level && (
          <Slider label="相机倾斜" value={sc.cameraRoll} min={-45} max={45} step={0.5} unit="°"
            display={`${sc.cameraRoll.toFixed(1)}°`} onChange={(v) => set.getState().setScene({ cameraRoll: v })} />
        )}
      </div>

      <div className="panel-section">
        <div className="module-title">对焦 <span className="hint">FOCUS</span></div>
        <div className="btn-group">
          <button className={s.focusMode === 'auto' ? 'active' : ''} onClick={() => set.getState().setFocusMode('auto')}>自动 AF</button>
          <button className={s.focusMode === 'manual' ? 'active' : ''} onClick={() => set.getState().setFocusMode('manual')}>手动 MF</button>
        </div>
        <Slider label="对焦距离" value={s.focusDistance} min={0.3} max={20} step={0.05} unit=" m"
          display={`${s.focusDistance.toFixed(2)} m`} onChange={(v) => set.getState().setFocusDistance(v)} />
        <div className="info-grid">
          <div><span>景深范围</span><b>{dof.near.toFixed(2)} – {dof.far === Infinity ? '∞' : dof.far.toFixed(2)} m</b></div>
          <div><span>超焦距</span><b>{dof.hyperfocal.toFixed(1)} m</b></div>
          <div><span>安全快门</span><b>1/{Math.round(1 / safeShutter(s.focalLength))}s</b></div>
          <div><span>焦点</span><b>{(s.focusPoint.x * 100).toFixed(0)}%, {(s.focusPoint.y * 100).toFixed(0)}%</b></div>
        </div>
        <div className="btn-group">
          <button className={s.focusPeak ? 'active' : ''} onClick={() => set.getState().toggleFocusPeak()}>对焦峰值</button>
          <button className={s.dofPreview ? 'active' : ''} onClick={() => set.getState().toggleDofPreview()}>景深预览</button>
        </div>
      </div>

      <div className="panel-section">
        <div className="module-title">白平衡 <span className="hint">WHITE BALANCE</span></div>
        <div className="btn-group">
          {([['daylight', '日光'], ['cloudy', '阴天'], ['tungsten', '白炽'], ['fluorescent', '荧光'], ['custom', '自定义']] as [WbPreset, string][]).map(([w, l]) => (
            <button key={w} className={s.wbPreset === w ? 'active' : ''} onClick={() => set.getState().setWbPreset(w)}>{l}</button>
          ))}
        </div>
        <Slider label="色温" value={s.wbTemp} min={2000} max={10000} step={100} unit="" display={`${s.wbTemp} K`} onChange={(v) => set.getState().setWbTemp(v)} />
        <Slider label="色调" value={s.wbTint} min={-100} max={100} step={1} unit=""
          display={`G${Math.abs(s.wbTint)} / M${Math.abs(s.wbTint)}`} onChange={(v) => set.getState().setWbTint(v)} />
      </div>

      <div className="panel-section">
        <div className="module-title">镜头与传感器 <span className="hint">OPTICS · P2</span></div>
        <div className="btn-group">
          {(['full', 'aps-c', 'm43'] as SensorId[]).map((id) => (
            <button key={id} className={s.sensor === id ? 'active' : ''} onClick={() => set.getState().setSensor(id)}>{SENSOR_PROFILES[id].label}</button>
          ))}
        </div>
        <div className="btn-group">
          {(['wide', 'standard', 'tele'] as LensId[]).map((id) => (
            <button key={id} className={s.lens === id ? 'active' : ''} onClick={() => set.getState().setLens(id)}>{LENS_PROFILES[id].labelText}</button>
          ))}
        </div>
        <Slider label="焦距" value={s.focalLength} min={lens.minFocal} max={lens.maxFocal} step={1} unit=" mm"
          display={`${Math.round(s.focalLength)} mm`} onChange={(v) => set.getState().setFocalLength(v)} />
        <div className="info-grid">
          <div><span>等效焦距</span><b>{Math.round(s.focalLength * sensor.crop)} mm</b></div>
          <div><span>水平视角</span><b>{sensorFieldOfView(s.focalLength, s.sensor).toFixed(1)}°</b></div>
          <div><span>衍射模糊</span><b>{diffractionBlurForSensor(s.aperture, s.sensor).toFixed(1)} μm</b></div>
          <div><span>裁切系数</span><b>{sensor.crop.toFixed(2)}×</b></div>
        </div>
        <div className="btn-group">
          {(['jpeg', 'raw'] as FileFormat[]).map((id) => (
            <button key={id} className={s.fileFormat === id ? 'active' : ''} onClick={() => set.getState().setFileFormat(id)}>{formatFileFormat(id)}</button>
          ))}
        </div>
      </div>

      <div className="panel-section">
        <div className="module-title">快门与驱动 <span className="hint">SHUTTER · P1</span></div>
        <div className="btn-group">
          {([['mechanical', '机械快门'], ['electronic', '电子快门']] as [ShutterType, string][]).map(([v, l]) => (
            <button key={v} className={s.shutterType === v ? 'active' : ''} onClick={() => set.getState().setShutterType(v)}>{l}</button>
          ))}
        </div>
        <div className="btn-group">
          {([['single', '单张'], ['burst', '连拍'], ['timer', '定时']] as [DriveMode, string][]).map(([v, l]) => (
            <button key={v} className={s.driveMode === v ? 'active' : ''} onClick={() => set.getState().setDriveMode(v)}>{l}</button>
          ))}
        </div>
        {s.driveMode === 'burst' && (
          <Slider label="连拍张数" value={s.burstFrames} min={3} max={10} step={1} unit=" 张"
            display={`${s.burstFrames} 张`} onChange={(v) => set.getState().setBurstFrames?.(v)} />
        )}
        {s.driveMode === 'timer' && (
          <Slider label="定时秒数" value={s.timerSeconds} min={2} max={10} step={1} unit=" s"
            display={`${s.timerSeconds} s`} onChange={(v) => set.getState().setTimerSeconds?.(v)} />
        )}
        <div className="btn-group">
          <Toggle label="防抖 IBIS" active={s.stabilization} onClick={() => set.getState().setStabilization(!s.stabilization)} hint="补偿 4 档手抖" />
        </div>
      </div>

      <div className="panel-section">
        <div className="module-title">闪光 <span className="hint">FLASH · P1</span></div>
        <div className="btn-group">
          <Toggle label="闪光灯" active={s.flashEnabled} onClick={() => set.getState().setFlash(!s.flashEnabled)} />
        </div>
        {s.flashEnabled && (
          <>
            <div className="btn-group">
              {([['front', '前帘同步'], ['rear', '后帘同步']] as [FlashSync, string][]).map(([v, l]) => (
                <button key={v} className={s.flashSync === v ? 'active' : ''} onClick={() => set.getState().setFlashSync(v)}>{l}</button>
              ))}
            </div>
            <Slider label="闪光输出" value={s.flashPowerEV} min={-3} max={3} step={0.5} unit=" EV"
              display={`${s.flashPowerEV >= 0 ? '+' : ''}${s.flashPowerEV} EV`} onChange={(v) => set.getState().setFlashPower(v)} />
            <div className="info-hint">{flashSyncDescription(s.flashSync, s.shutter)}</div>
          </>
        )}
      </div>

      <div className="panel-section">
        <div className="module-title">包围曝光与 HDR <span className="hint">BRACKET · P1</span></div>
        <div className="btn-group">
          <Toggle label="包围曝光" active={s.bracketingEnabled} onClick={() => set.getState().setBracketing(!s.bracketingEnabled)} />
          <Toggle label="HDR 合成" active={s.hdrEnabled} onClick={() => set.getState().setHdr(!s.hdrEnabled)} hint="需开启包围曝光" />
        </div>
        {s.bracketingEnabled && (
          <>
            <div className="btn-group">
              {[3, 5, 7].map((n) => (
                <button key={n} className={s.bracketFrames === n ? 'active' : ''} onClick={() => set.getState().setBracketFrames(n)}>{n} 张</button>
              ))}
            </div>
            <Slider label="包围步进" value={s.bracketStepEV} min={1} max={3} step={1} unit=" EV"
              display={`±${s.bracketStepEV} EV`} onChange={(v) => set.getState().setBracketStep(v)} />
            <div className="info-hint">拍摄后自动生成一组 {s.bracketFrames} 张不同曝光的照片{s.hdrEnabled ? ' + 1 张 HDR 合成图' : ''}。</div>
          </>
        )}
      </div>

      <div className="panel-section">
        <div className="module-title">色彩风格 <span className="hint">FILM · P1</span></div>
        <div className="btn-group">
          {(['standard', 'portrait', 'landscape', 'mono', 'log'] as FilmSimulation[]).map((v) => (
            <button key={v} className={s.filmSim === v ? 'active' : ''} onClick={() => set.getState().setFilmSim(v)}>{v.toUpperCase()}</button>
          ))}
        </div>
        <div className="btn-group">
          <select className="lut-select" value={s.lutName} onChange={(e) => set.getState().setLut(e.target.value)}>
            {lutOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <label className="file-btn">导入 .cube<input type="file" accept=".cube" hidden onChange={(e) => e.target.files?.[0] && importLut(e.target.files[0])} /></label>
        </div>
        <div className="info-hint">胶片模拟为矩阵 + 曲线；LUT 为 3D 查色表（.cube），在色调映射之后应用。</div>
      </div>

      <div className="panel-section">
        <div className="module-title">预设 <span className="hint">PRESET · P2</span></div>
        <div className="btn-group">
          <button onClick={exportPreset}>导出预设 JSON</button>
          <label className="file-btn">导入预设<input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importPreset(e.target.files[0])} /></label>
        </div>
      </div>

      <div className="panel-section">
        <div className="module-title">场景光照 <span className="hint">SCENE</span></div>
        <Slider label="主光强度" value={sc.keyIntensity} min={0} max={8} step={0.1} unit="" display={sc.keyIntensity.toFixed(1)} onChange={(v) => set.getState().setScene({ keyIntensity: v })} />
        <Slider label="主光色温" value={sc.keyTemp} min={2000} max={10000} step={100} unit="" display={`${sc.keyTemp} K`} onChange={(v) => set.getState().setScene({ keyTemp: v })} />
        <Slider label="环境光" value={sc.ambientIntensity} min={0} max={2} step={0.05} unit="" display={sc.ambientIntensity.toFixed(2)} onChange={(v) => set.getState().setScene({ ambientIntensity: v })} />
        <Slider label="运动速度" value={sc.motionSpeed} min={0} max={4} step={0.1} unit=" rad/s" display={`${sc.motionSpeed.toFixed(1)} rad/s`} onChange={(v) => set.getState().setScene({ motionSpeed: v })} />
        <div className="btn-group">
          <button className={sc.motionEnabled ? 'active' : ''} onClick={() => set.getState().setScene({ motionEnabled: !sc.motionEnabled })}>运动物体 {sc.motionEnabled ? 'ON' : 'OFF'}</button>
          <button onClick={() => set.getState().resetScene()}>恢复默认场景</button>
        </div>
      </div>
    </div>
  );
}

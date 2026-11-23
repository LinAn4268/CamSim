// src/ui/ControlPanel.tsx — Sony 风格菜单式控制面板（分组标签页 + 行式菜单项）
// 功能与之前一致（P0 + P1 + P2 全参数），只是改成 α 系列机背菜单的呈现方式：
// 顶部图标标签栏切换分组，每行左标题右数值，深灰底 + 橙色高亮。

import { useState } from 'react';
import { useCameraStore } from '../store/useCameraStore';
import { handheldSafeShutterLimit, flashSyncDescription } from '../camera/advanced';
import { formatShutterLabel } from '../utils/format';
import {
  sensorFieldOfView, sensorDepthOfField, diffractionBlurForSensor, SENSOR_PROFILES, LENS_PROFILES,
  serializePreset, deserializePreset, formatFileFormat,
} from '../camera/optics';
import { BUILTIN_LUTS } from '../camera/film';
import type {
  MeteringMode, WbPreset, ShutterType, DriveMode, FlashSync,
  FilmSimulation, SensorId, LensId, FileFormat,
} from '../types/camera';

const formatShutter = (t: number) => (t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}`);

/** 菜单行：左侧标题 + 右侧当前值，下方内联控件（滑块 / 按钮组）。 */
function MenuRow({ label, value, children, hint }: {
  label: string; value?: string; children?: React.ReactNode; hint?: string;
}) {
  return (
    <div className="menu-row">
      <div className="menu-row-head">
        <span className="menu-row-label">{label}</span>
        {value !== undefined && <span className="menu-row-value">{value}</span>}
      </div>
      {children && <div className="menu-row-body">{children}</div>}
      {hint && <div className="menu-row-hint">{hint}</div>}
    </div>
  );
}

function Slider({ value, min, max, step, onChange }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))} />
  );
}

function Segmented<T extends string>({ options, value, onChange }: {
  options: [T, string][]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map(([v, l]) => (
        <button key={v} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

function Chip({ label, active, onClick, hint }: {
  label: string; active: boolean; onClick: () => void; hint?: string;
}) {
  return (
    <button className={`chip ${active ? 'active' : ''}`} onClick={onClick} title={hint}>
      <span className="chip-dot" />{label}
    </button>
  );
}

const TABS = [
  { id: 'exposure', label: '曝光', icon: '◐' },
  { id: 'focus', label: '对焦', icon: '◎' },
  { id: 'color', label: '色彩', icon: '◑' },
  { id: 'drive', label: '驱动', icon: '⏱' },
  { id: 'lens', label: '镜头', icon: '◉' },
  { id: 'setup', label: '设置', icon: '⚙' },
] as const;
type TabId = typeof TABS[number]['id'];

export function ControlPanel() {
  const [tab, setTab] = useState<TabId>('exposure');
  const s = useCameraStore((st) => st.settings);
  const sc = useCameraStore((st) => st.scene);
  const customLuts = useCameraStore((st) => st.customLuts);
  const viewMoved = useCameraStore((st) => st.viewMoved);
  // 测光结果来自引擎（异步回读 + 与渲染共用的标定增益），不能在 UI 里另用一条公式重算，
  // 否则菜单里的「测光 EV」会和取景器 / 曝光刻度盘对不上。
  const meterEV = useCameraStore((st) => st.meterEV);
  const meterShutter = useCameraStore((st) => st.meterShutter);
  const st = () => useCameraStore.getState();
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
      if (parsed) st().loadPreset(parsed.settings);
      else window.alert('预设文件格式无效');
    };
    reader.readAsText(file);
  };
  const importLut = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const name = file.name.replace(/\.cube$/i, '') || '自定义 LUT';
      st().addCustomLut(name, String(reader.result));
    };
    reader.readAsText(file);
  };

  return (
    <div className="sony-menu">
      {/* α 系列机背菜单的标签栏：图标 + 中文名，当前组橙色下划线 */}
      <div className="menu-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="menu-scroll">
        {tab === 'exposure' && (
          <>
            <div className="menu-group-title">曝光控制 <span>EXPOSURE</span></div>
            <MenuRow label="快门速度" value={formatShutter(s.shutter)}>
              <Slider value={Math.log2(s.shutter)} min={-12.97} max={4.91} step={0.01}
                onChange={(v) => st().setShutter(Math.pow(2, v))} />
            </MenuRow>
            <MenuRow label="光圈" value={`f/${s.aperture.toFixed(1)}`}>
              <Slider value={s.aperture} min={1.4} max={22} step={0.1} onChange={(v) => st().setAperture(v)} />
              <div className="chip-row">
                {[1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22].map((n) => (
                  <button key={n} className={`chip tiny ${Math.abs(s.aperture - n) < 0.05 ? 'active' : ''}`}
                    onClick={() => st().setAperture(n)}>{n}</button>
                ))}
              </div>
            </MenuRow>
            <MenuRow label="ISO 感光度" value={`${s.iso}`}>
              <Slider value={Math.log2(s.iso / 100)} min={-1} max={9} step={1}
                onChange={(v) => st().setIso(100 * Math.pow(2, v))} />
            </MenuRow>
            <MenuRow label="曝光补偿" value={`${s.exposureComp >= 0 ? '+' : ''}${s.exposureComp.toFixed(2)} EV`}>
              <Slider value={s.exposureComp} min={-5} max={5} step={1 / 3}
                onChange={(v) => st().setExposureComp(v)} />
            </MenuRow>
            <MenuRow label="ND 滤镜" value={`${s.ndStops} 档`} hint={`等效快门 ${formatShutter(s.shutter * Math.pow(2, s.ndStops))}`}>
              <Slider value={s.ndStops} min={0} max={10} step={1} onChange={(v) => st().setNdStops(v)} />
            </MenuRow>
            <div className="menu-info">
              <div><span>测光 EV</span><b>{meterEV.toFixed(2)}</b></div>
              <div><span>建议快门</span><b>{formatShutterLabel(meterShutter)}</b></div>
            </div>
          </>
        )}

        {tab === 'focus' && (
          <>
            <div className="menu-group-title">对焦 <span>FOCUS</span></div>
            <MenuRow label="对焦模式" value={s.focusMode === 'auto' ? 'AF' : 'MF'}>
              <Segmented options={[['auto', '自动 AF'], ['manual', '手动 MF']] as [string, string][]}
                value={s.focusMode} onChange={(v) => st().setFocusMode(v as 'auto' | 'manual')} />
            </MenuRow>
            <MenuRow label="对焦距离" value={`${s.focusDistance.toFixed(2)} m`}>
              <Slider value={s.focusDistance} min={0.3} max={20} step={0.05}
                onChange={(v) => st().setFocusDistance(v)} />
            </MenuRow>
            <MenuRow label="对焦辅助">
              <div className="chip-row">
                <Chip label="对焦峰值" active={s.focusPeak} onClick={() => st().toggleFocusPeak()} />
                <Chip label="景深预览" active={s.dofPreview} onClick={() => st().toggleDofPreview()} />
              </div>
            </MenuRow>
            <div className="menu-info">
              <div><span>景深</span><b>{dof.near.toFixed(2)}–{dof.far === Infinity ? '∞' : dof.far.toFixed(2)} m</b></div>
              <div><span>超焦距</span><b>{dof.hyperfocal.toFixed(1)} m</b></div>
              <div><span>安全快门</span><b>{formatShutterLabel(handheldSafeShutterLimit(s.focalLength, sensor.crop, s.stabilization))}</b></div>
              <div><span>对焦点</span><b>{(s.focusPoint.x * 100).toFixed(0)}%, {(s.focusPoint.y * 100).toFixed(0)}%</b></div>
            </div>
            <div className="menu-group-title">测光 <span>METERING</span></div>
            <MenuRow label="测光模式">
              <Segmented options={[['evaluative', '多重'], ['center', '中央'], ['spot', '点测光']] as [MeteringMode, string][]}
                value={s.metering} onChange={(v) => st().setMetering(v)} />
            </MenuRow>
            <MenuRow label="取景辅助">
              <div className="chip-row">
                <Chip label="斑马纹" active={s.zebra} onClick={() => st().toggleZebra()} hint="高亮区域叠加斜纹" />
                <Chip label="构图线" active={s.guides} onClick={() => st().toggleGuides()} />
                <Chip label="水平仪" active={s.level} onClick={() => st().toggleLevel()} />
              </div>
            </MenuRow>
            {s.level && (
              <MenuRow label="相机倾斜" value={`${sc.cameraRoll.toFixed(1)}°`}>
                <Slider value={sc.cameraRoll} min={-45} max={45} step={0.5}
                  onChange={(v) => st().setScene({ cameraRoll: v })} />
              </MenuRow>
            )}
          </>
        )}

        {tab === 'color' && (
          <>
            <div className="menu-group-title">白平衡 <span>WHITE BALANCE</span></div>
            <MenuRow label="白平衡模式" value={`${s.wbTemp} K`}>
              <Segmented options={[['daylight', '日光'], ['cloudy', '阴天'], ['tungsten', '白炽'], ['fluorescent', '荧光'], ['custom', '自定义']] as [WbPreset, string][]}
                value={s.wbPreset} onChange={(v) => st().setWbPreset(v)} />
            </MenuRow>
            <MenuRow label="色温" value={`${s.wbTemp} K`}>
              <Slider value={s.wbTemp} min={2000} max={10000} step={100} onChange={(v) => st().setWbTemp(v)} />
            </MenuRow>
            <MenuRow label="色调" value={`${s.wbTint >= 0 ? 'G' : 'M'}${Math.abs(s.wbTint)}`}>
              <Slider value={s.wbTint} min={-100} max={100} step={1} onChange={(v) => st().setWbTint(v)} />
            </MenuRow>
            <div className="menu-group-title">创意外观 <span>CREATIVE LOOK</span></div>
            <MenuRow label="胶片模拟">
              <Segmented options={[['standard', 'ST'], ['portrait', 'PT'], ['landscape', 'LS'], ['mono', 'BW'], ['log', 'S-LOG']] as [FilmSimulation, string][]}
                value={s.filmSim} onChange={(v) => st().setFilmSim(v)} />
            </MenuRow>
            <MenuRow label="LUT / 查色表" value={s.lutEnabled ? s.lutName : '关闭'}>
              <div className="chip-row">
                <select className="lut-select" value={s.lutName} onChange={(e) => st().setLut(e.target.value)}>
                  {lutOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                <label className="file-btn">导入 .cube
                  <input type="file" accept=".cube" hidden onChange={(e) => e.target.files?.[0] && importLut(e.target.files[0])} />
                </label>
              </div>
            </MenuRow>
            <div className="menu-note">胶片模拟为矩阵 + 曲线；LUT 为 3D 查色表，在色调映射之后应用。</div>
          </>
        )}

        {tab === 'drive' && (
          <>
            <div className="menu-group-title">快门与驱动 <span>SHUTTER / DRIVE</span></div>
            <MenuRow label="快门类型" value={s.shutterType === 'electronic' ? '电子' : '机械'}>
              <Segmented options={[['mechanical', '机械快门'], ['electronic', '电子快门']] as [ShutterType, string][]}
                value={s.shutterType} onChange={(v) => st().setShutterType(v)} />
            </MenuRow>
            <MenuRow label="驱动模式">
              <Segmented options={[['single', '单张'], ['burst', '连拍'], ['timer', '定时']] as [DriveMode, string][]}
                value={s.driveMode} onChange={(v) => st().setDriveMode(v)} />
            </MenuRow>
            {s.driveMode === 'burst' && (
              <MenuRow label="连拍张数" value={`${s.burstFrames} 张`}>
                <Segmented options={[[3, '3'], [5, '5'], [10, '10']].map(([n, l]) => [String(n), l] as [string, string])}
                  value={String(s.burstFrames)} onChange={(v) => st().setBurstFrames(Number(v))} />
              </MenuRow>
            )}
            {s.driveMode === 'timer' && (
              <MenuRow label="定时秒数" value={`${s.timerSeconds} s`}>
                <Segmented options={[[2, '2s'], [5, '5s'], [10, '10s']].map(([n, l]) => [String(n), l] as [string, string])}
                  value={String(s.timerSeconds)} onChange={(v) => st().setTimerSeconds(Number(v))} />
              </MenuRow>
            )}
            <MenuRow label="防抖">
              <Chip label="IBIS 机身防抖（4 档）" active={s.stabilization}
                onClick={() => st().setStabilization(!s.stabilization)} />
            </MenuRow>

            <div className="menu-group-title">闪光 <span>FLASH</span></div>
            <MenuRow label="闪光灯">
              <Chip label={s.flashEnabled ? '开启' : '关闭'} active={s.flashEnabled}
                onClick={() => st().setFlash(!s.flashEnabled)} />
            </MenuRow>
            {s.flashEnabled && (
              <>
                <MenuRow label="同步方式">
                  <Segmented options={[['front', '前帘同步'], ['rear', '后帘同步']] as [FlashSync, string][]}
                    value={s.flashSync} onChange={(v) => st().setFlashSync(v)} />
                </MenuRow>
                <MenuRow label="闪光输出" value={`${s.flashPowerEV >= 0 ? '+' : ''}${s.flashPowerEV} EV`}>
                  <Slider value={s.flashPowerEV} min={-3} max={3} step={0.5}
                    onChange={(v) => st().setFlashPower(v)} />
                </MenuRow>
                <div className="menu-note">{flashSyncDescription(s.flashSync, s.shutter)}</div>
              </>
            )}

            <div className="menu-group-title">包围曝光与 HDR <span>BRACKET</span></div>
            <MenuRow label="包围曝光">
              <Chip label="开启包围" active={s.bracketingEnabled} onClick={() => st().setBracketing(!s.bracketingEnabled)} />
            </MenuRow>
            {s.bracketingEnabled && (
              <>
                <MenuRow label="张数 / 步进" value={`${s.bracketFrames} 张 ±${s.bracketStepEV} EV`}>
                  <div className="chip-row">
                    <Segmented options={[[3, '3 张'], [5, '5 张'], [7, '7 张']].map(([n, l]) => [String(n), l] as [string, string])}
                      value={String(s.bracketFrames)} onChange={(v) => st().setBracketFrames(Number(v))} />
                  </div>
                  <Slider value={s.bracketStepEV} min={1} max={3} step={1}
                    onChange={(v) => st().setBracketStep(v)} />
                </MenuRow>
                <MenuRow label="HDR 合成">
                  <Chip label="合成一张 HDR" active={s.hdrEnabled} onClick={() => st().setHdr(!s.hdrEnabled)} />
                </MenuRow>
              </>
            )}
          </>
        )}

        {tab === 'lens' && (
          <>
            <div className="menu-group-title">镜头 <span>LENS</span></div>
            <MenuRow label="镜头" value={lens.labelText}>
              <Segmented options={(['wide', 'standard', 'tele'] as LensId[]).map((id) => [id, LENS_PROFILES[id].labelText] as [LensId, string])}
                value={s.lens} onChange={(v) => st().setLens(v)} />
            </MenuRow>
            <MenuRow label="焦距" value={`${Math.round(s.focalLength)} mm`}>
              <Slider value={s.focalLength} min={lens.minFocal} max={lens.maxFocal} step={1}
                onChange={(v) => st().setFocalLength(v)} />
            </MenuRow>
            <div className="menu-group-title">影像传感器 <span>SENSOR</span></div>
            <MenuRow label="传感器尺寸" value={`${sensor.label}（${sensor.crop.toFixed(2)}×）`}>
              <Segmented options={(['full', 'aps-c', 'm43'] as SensorId[]).map((id) => [id, SENSOR_PROFILES[id].label] as [SensorId, string])}
                value={s.sensor} onChange={(v) => st().setSensor(v)} />
            </MenuRow>
            <div className="menu-info">
              <div><span>等效焦距</span><b>{Math.round(s.focalLength * sensor.crop)} mm</b></div>
              <div><span>水平视角</span><b>{sensorFieldOfView(s.focalLength, s.sensor).toFixed(1)}°</b></div>
              <div><span>衍射模糊</span><b>{diffractionBlurForSensor(s.aperture, s.sensor).toFixed(1)} μm</b></div>
              <div><span>像素密度</span><b>{(1 / (sensor.crop * sensor.crop)).toFixed(2)}×</b></div>
            </div>
            <div className="menu-group-title">记录格式 <span>FILE FORMAT</span></div>
            <MenuRow label="文件格式">
              <Segmented options={(['jpeg', 'raw'] as FileFormat[]).map((id) => [id, formatFileFormat(id)] as [FileFormat, string])}
                value={s.fileFormat} onChange={(v) => st().setFileFormat(v)} />
            </MenuRow>
            <div className="menu-group-title">机身视角 <span>VIEW</span></div>
            <MenuRow label="镜头位置与视角" value={viewMoved ? '已移动' : '默认'}>
              <button className="menu-action" onClick={() => st().requestResetView()}>恢复默认镜头位置及视角</button>
            </MenuRow>
          </>
        )}

        {tab === 'setup' && (
          <>
            <div className="menu-group-title">场景与布光 <span>SCENE</span></div>
            <MenuRow label="主光强度" value={sc.keyIntensity.toFixed(1)}>
              <Slider value={sc.keyIntensity} min={0} max={8} step={0.1}
                onChange={(v) => st().setScene({ keyIntensity: v })} />
            </MenuRow>
            <MenuRow label="主光色温" value={`${sc.keyTemp} K`}>
              <Slider value={sc.keyTemp} min={2000} max={10000} step={100}
                onChange={(v) => st().setScene({ keyTemp: v })} />
            </MenuRow>
            <MenuRow label="环境光" value={sc.ambientIntensity.toFixed(2)}>
              <Slider value={sc.ambientIntensity} min={0} max={2} step={0.05}
                onChange={(v) => st().setScene({ ambientIntensity: v })} />
            </MenuRow>
            <MenuRow label="运动速度" value={`${sc.motionSpeed.toFixed(1)} rad/s`}>
              <Slider value={sc.motionSpeed} min={0} max={4} step={0.1}
                onChange={(v) => st().setScene({ motionSpeed: v })} />
            </MenuRow>
            <MenuRow label="运动物体">
              <Chip label={sc.motionEnabled ? '运动 ON' : '运动 OFF'} active={sc.motionEnabled}
                onClick={() => st().setScene({ motionEnabled: !sc.motionEnabled })} />
            </MenuRow>

            <div className="menu-group-title">预设 <span>PRESET</span></div>
            <MenuRow label="相机预设">
              <div className="chip-row">
                <button className="menu-action" onClick={exportPreset}>导出预设 JSON</button>
                <label className="file-btn">导入预设
                  <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importPreset(e.target.files[0])} />
                </label>
              </div>
            </MenuRow>

            <div className="menu-group-title">重置 <span>RESET</span></div>
            <MenuRow label="恢复出厂">
              <div className="chip-row">
                <button className="menu-action" onClick={() => st().resetCamera()}>重置相机参数</button>
                <button className="menu-action" onClick={() => st().resetScene()}>重置场景布光</button>
              </div>
            </MenuRow>
            <div className="menu-note">相机参数包含曝光三角、对焦、白平衡、驱动与色彩风格；自定义 LUT 不会被清除。</div>
          </>
        )}
      </div>
    </div>
  );
}

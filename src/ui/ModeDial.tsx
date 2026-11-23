// src/ui/ModeDial.tsx — 机身顶部的物理转盘区：模式按键组 + 快门/光圈/ISO/补偿四个数值盘
//
// 布局刻意模仿真机顶部（左侧模式键，右侧四个数值盘），所有转盘都能拖动 / 滚轮 / 点击切换。

import { Dial } from './Dial';
import { useCameraStore } from '../store/useCameraStore';
import { formatShutterLabel } from '../utils/format';
import { SHUTTER_STOPS, APERTURE_STOPS, ISO_STOPS } from '../camera/physics';

/** 曝光补偿 1/3 档一格的等差档位（-5 .. +5）。 */
const EXP_STOPS = Array.from({ length: 31 }, (_, i) => Math.round((-5 + i / 3) * 100) / 100);

export function ModeDial() {
  const s = useCameraStore((st) => st.settings);
  const st = useCameraStore.getState;

  return (
    <div className="mode-dial">
      {/* 左侧：真机顶部那一排小型拨钮（对焦 / 驱动 / 快门类型） */}
      <div className="mode-switch" role="group" aria-label="相机模式">
        <span className="mode-caption">FOCUS</span>
        <button className={s.focusMode === 'auto' ? 'active' : ''} onClick={() => st().setFocusMode('auto')} title="自动对焦 AF">AF</button>
        <button className={s.focusMode === 'manual' ? 'active' : ''} onClick={() => st().setFocusMode('manual')} title="手动对焦 MF">MF</button>
        <span className="mode-caption">DRIVE</span>
        {([['single', 'S', '单张'], ['burst', 'C', '连拍'], ['timer', 'T', '定时']] as const).map(([v, label, title]) => (
          <button key={v} className={s.driveMode === v ? 'active' : ''} onClick={() => st().setDriveMode(v)} title={title}>{label}</button>
        ))}
        <span className="mode-caption">SHUTTER</span>
        {(['mechanical', 'electronic'] as const).map((v) => (
          <button key={v} className={s.shutterType === v ? 'active' : ''} onClick={() => st().setShutterType(v)}
            title={v === 'mechanical' ? '机械快门（全局曝光）' : '电子快门（滚动快门，可能果冻）'}>{v === 'mechanical' ? 'M' : 'E'}</button>
        ))}
      </div>

      <div className="dial-row">
        <Dial
          label="快门"
          value={s.shutter}
          display={formatShutterLabel(s.shutter)}
          stops={SHUTTER_STOPS}
          mode="log"
          onChange={(v) => st().setShutter(v)}
          hint="快门速度：上下拖动 / 滚轮 切换整档"
        />
        <Dial
          label="光圈"
          value={s.aperture}
          display={`f/${s.aperture.toFixed(1)}`}
          stops={APERTURE_STOPS}
          mode="log"
          onChange={(v) => st().setAperture(v)}
          hint="光圈 f/N：上下拖动 / 滚轮 切换整档"
        />
        <Dial
          label="ISO"
          value={s.iso}
          display={`${s.iso}`}
          stops={ISO_STOPS}
          mode="log"
          onChange={(v) => st().setIso(v)}
          hint="感光度 ISO：上下拖动 / 滚轮 切换整档"
        />
        <Dial
          label="补偿"
          value={s.exposureComp}
          display={`${s.exposureComp >= 0 ? '+' : ''}${s.exposureComp.toFixed(1)}`}
          stops={EXP_STOPS}
          mode="linear"
          accent
          onChange={(v) => st().setExposureComp(v)}
          hint="曝光补偿 EV：上下拖动 / 滚轮，1/3 档步进"
        />
      </div>
    </div>
  );
}

/** 供键盘快捷键复用：按整档调整快门 / 光圈 / ISO。 */
export function stepStop(kind: 'shutter' | 'aperture' | 'iso', value: number, dir: number): number {
  const stops: readonly number[] = kind === 'shutter' ? SHUTTER_STOPS : kind === 'aperture' ? APERTURE_STOPS : ISO_STOPS;
  let idx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = kind === 'shutter'
      ? Math.abs(Math.log(stops[i] / Math.max(value, 1e-9)))
      : Math.abs(stops[i] - value);
    if (d < bestDist) { bestDist = d; idx = i; }
  }
  const next = Math.max(0, Math.min(stops.length - 1, (idx < 0 ? 0 : idx) + dir));
  return stops[next];
}

// src/ui/Viewfinder.tsx — 取景器：挂载 WebGL 画布、Sony α 系列风格 HUD 叠加、快门按钮
// P1：单张 / 连拍 / 定时 / 包围曝光 / 多曝光 HDR 的拍摄编排都在这里完成。
// 机位（镜头位置与视角）可通过 HUD 右上「复位」或菜单「镜头 → 恢复默认」还原。

import { useEffect, useRef, useState } from 'react';
import { CameraEngine, RAW_W, RAW_H } from '../renderer/CameraEngine';
import { setEngineHandle } from '../renderer/engineHandle';
import { useCameraStore, makeExif } from '../store/useCameraStore';
import { formatShutterLabel } from '../utils/format';
import { bracketEVs, mergeHDR, effectiveHandheldShutter, isHandheldSafe, flashSyncDescription } from '../camera/advanced';
import { decodeEncodedLinear } from '../camera/tonemap';
import { SENSOR_PROFILES } from '../camera/optics';
import type { Photo } from '../types/camera';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 把 RGBA8 编码的线性数据解码为线性浮点（每通道 0..16）。 */
function decodeLinear(buf: Uint8Array): Float32Array {
  const out = new Float32Array(RAW_W * RAW_H * 4);
  for (let i = 0; i < RAW_W * RAW_H * 4; i += 4) {
    out[i] = decodeEncodedLinear(buf[i]);
    out[i + 1] = decodeEncodedLinear(buf[i + 1]);
    out[i + 2] = decodeEncodedLinear(buf[i + 2]);
    out[i + 3] = 1;
  }
  return out;
}

/** 分离 R/G/B 通道供 mergeHDR 逐通道合成。 */
function channel(data: Float32Array, ch: number): Float32Array {
  const out = new Float32Array(data.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + ch];
  return out;
}

const WB_LABEL: Record<string, string> = {
  daylight: 'AWB', cloudy: '阴天', tungsten: '白炽', fluorescent: '荧光', custom: '手动',
};
const DRIVE_ICON: Record<string, string> = { single: '□', burst: '≣', timer: '◷' };

export function Viewfinder() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CameraEngine | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const settings = useCameraStore((s) => s.settings);
  // 只订阅用到的场景字段：场景光照变化不该重渲染取景器叠加层。
  const cameraRoll = useCameraStore((s) => s.scene.cameraRoll);
  const fps = useCameraStore((s) => s.fps);
  const meterEV = useCameraStore((s) => s.meterEV);
  const meterShutter = useCameraStore((s) => s.meterShutter);
  const countdown = useCameraStore((s) => s.countdown);
  const shooting = useCameraStore((s) => s.shooting);
  const viewMoved = useCameraStore((s) => s.viewMoved);
  const viewResetToken = useCameraStore((s) => s.viewResetToken);

  useEffect(() => {
    if (!hostRef.current || engineRef.current) return;
    try {
      const engine = new CameraEngine(hostRef.current);
      engineRef.current = engine;
      setEngineHandle(engine);
      const ro = new ResizeObserver(() => engine.resize());
      ro.observe(hostRef.current);
      (window as unknown as { __cameraEngine: CameraEngine }).__cameraEngine = engine;
      return () => {
        ro.disconnect();
        setEngineHandle(null);
        engine.dispose();
        engineRef.current = null;
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 菜单 / HUD 请求复位机位：store 只递增计数，这里拿到最新引擎再执行
  useEffect(() => {
    if (viewResetToken === 0) return;
    engineRef.current?.resetView();
  }, [viewResetToken]);

  const resetView = () => {
    if (engineRef.current) engineRef.current.resetView();
    else useCameraStore.getState().requestResetView();
  };

  const flashScreen = () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
  };

  /** 编排一次快门动作（按驱动模式 / 包围曝光 / HDR 设置）。 */
  const shoot = async () => {
    const engine = engineRef.current;
    if (!engine || busyRef.current) return;
    busyRef.current = true;
    const st = useCameraStore.getState();
    const s = st.settings;
    try {
      st.setShooting(true);

      // 定时模式：倒计时后拍摄
      if (s.driveMode === 'timer') {
        for (let i = s.timerSeconds; i > 0; i--) {
          st.setCountdown(i);
          await sleep(1000);
        }
        st.setCountdown(0);
      }

      const takeSet = async () => {
        if (s.bracketingEnabled) {
          // 包围曝光：对称 EV 序列，逐帧拍摄
          const evs = bracketEVs(s.bracketFrames, s.bracketStepEV);
          const bracketId = `br-${Date.now()}`;
          const photos: Photo[] = [];
          const linearExposures: Array<{ data: Float32Array; evOffset: number }> = [];
          for (let i = 0; i < evs.length; i++) {
            const ev = evs[i];
            const frame = engine.captureWithEV(ev);
            const built: Photo = {
              id: `photo-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
              dataUrl: frame.dataUrl,
              exif: makeExif(s, { bracketEV: ev, hdr: s.hdrEnabled }),
              width: frame.width,
              height: frame.height,
              format: s.fileFormat,
              bracketId,
              bracketIndex: i,
              rawLinear: s.fileFormat === 'raw' ? frame.rawLinear : undefined,
            };
            photos.push(built);
            linearExposures.push({ data: decodeLinear(frame.rawLinear), evOffset: ev });
            flashScreen();
            await sleep(90);
          }
          // HDR 合成：逐通道加权融合，保留高光与暗部细节
          if (s.hdrEnabled) {
            const merged = new Float32Array(RAW_W * RAW_H * 4);
            for (let ch = 0; ch < 3; ch++) {
              const fused = mergeHDR(linearExposures.map((e) => ({ data: channel(e.data, ch), evOffset: e.evOffset })));
              for (let i = 0; i < RAW_W * RAW_H; i++) merged[i * 4 + ch] = fused[i];
            }
            for (let i = 0; i < RAW_W * RAW_H; i++) merged[i * 4 + 3] = 1;
            const hdrPhoto = engine.makeLinearPhoto(merged, false, {
              hdr: true, bracketEV: 0, driveMode: s.driveMode,
            });
            hdrPhoto.hdr = true;
            hdrPhoto.bracketId = bracketId;
            useCameraStore.getState().addPhoto(hdrPhoto);
            useCameraStore.getState().setHdrResult(hdrPhoto.id);
          }
          useCameraStore.getState().addPhotos(photos);
          useCameraStore.getState().setLastBracket(photos.map((p, i) => ({ ev: evs[i], photoId: p.id })));
        } else {
          // 普通单张
          const photo = engine.capture();
          useCameraStore.getState().addPhoto(photo);
          flashScreen();
        }
      };

      if (s.driveMode === 'burst') {
        // 连拍：按帧间隔连续拍摄，捕捉运动物体的不同位置
        useCameraStore.getState().setShowPlayback(false);
        const frames = Math.min(10, Math.max(3, s.burstFrames));
        for (let i = 0; i < frames; i++) {
          await takeSet();
          await sleep(120);
        }
        useCameraStore.getState().setLastBracket([]);
      } else {
        await takeSet();
      }
    } finally {
      st.setShooting(false);
      busyRef.current = false;
    }
  };

  // 暴露给快捷键 / 调试脚本的拍摄入口：只挂载一次，内部转发到最新的 shoot 实现。
  const shootRef = useRef(shoot);
  shootRef.current = shoot;
  useEffect(() => {
    (window as unknown as { __cameraCapture: () => void }).__cameraCapture = () => { void shootRef.current(); };
  }, []);

  // 手持安全判断直接用物理判定：安全快门 = 1/(焦距×裁切系数)，防抖再加 2^N 档宽容度。
  const crop = engineRef.current?.getCropFactor() ?? 1;
  const handheldSafe = isHandheldSafe(settings.shutter, settings.focalLength, crop, settings.stabilization);
  const effectiveSafeShutter = effectiveHandheldShutter(settings.shutter, settings.focalLength, crop, settings.stabilization);
  const sensor = SENSOR_PROFILES[settings.sensor];
  const evDelta = meterEV - (Math.log2((settings.aperture ** 2) / settings.shutter) - Math.log2(settings.iso / 100) + settings.exposureComp);
  const evPos = Math.max(0, Math.min(100, ((Math.max(-3, Math.min(3, evDelta)) + 3) / 6) * 100));

  return (
    <div className="camera-body">
      {/* 机身左肩：品牌与型号铭牌 */}
      <div className="body-shoulder">
        <div className="body-brand">α<span className="body-model">CamSim 7</span></div>
        <div className="body-sub">FULL-FRAME · WEBGL2 IMAGING</div>
        <div className="body-lamps">
          <span className={`lamp ${shooting ? 'on' : ''}`} title="拍摄中" />
          <span className={`lamp ${settings.flashEnabled ? 'on amber' : ''}`} title="闪光灯就绪" />
          <span className={`lamp ${settings.bracketingEnabled ? 'on' : ''}`} title="包围曝光" />
        </div>
      </div>

      <div className="viewfinder" ref={hostRef}>
        {error && <div className="gl-error">WebGL 初始化失败：{error}</div>}
        <div className="vf-overlay">
          {/* 顶栏：Sony 取景器顶部信息条（对焦区/驱动/白平衡/格式/帧率） */}
          <div className="vf-topbar">
            <span className="sony-badge">{settings.focusMode === 'auto' ? 'AF-C' : 'MF'}</span>
            <span className="sony-chip">{settings.metering === 'evaluative' ? '多重' : settings.metering === 'center' ? '中央' : '点测'}</span>
            <span className="sony-chip">{DRIVE_ICON[settings.driveMode]} {settings.driveMode === 'burst' ? `${settings.burstFrames}张` : settings.driveMode === 'timer' ? `${settings.timerSeconds}s` : '单张'}</span>
            <span className="sony-chip">{WB_LABEL[settings.wbPreset] ?? 'AWB'} {settings.wbTemp}K</span>
            <span className="sony-chip dim">{settings.shutterType === 'electronic' ? 'ES' : 'MS'}</span>
            <span className="vf-spacer" />
            {settings.stabilization && <span className="sony-chip ok">IS</span>}
            <span className="sony-chip dim">{settings.fileFormat.toUpperCase()}</span>
            <span className="sony-chip dim">{fps} F</span>
          </div>

          {/* 对焦框：Sony flexi-point 白框，合焦时转绿 */}
          <div className="focus-box" style={{ left: `${settings.focusPoint.x * 100}%`, top: `${settings.focusPoint.y * 100}%` }}>
            <span className="corner tl" /><span className="corner tr" />
            <span className="corner bl" /><span className="corner br" />
            <span className="focus-label">{settings.focusMode === 'auto' ? 'AF' : 'MF'}</span>
          </div>

          {settings.guides && (
            <div className="grid-lines">
              <div className="third-v" /><div className="third-v2" />
              <div className="third-h" /><div className="third-h2" />
            </div>
          )}
          {settings.level && (
            <div className="level-overlay" style={{ transform: `translate(-50%,-50%) rotate(${-cameraRoll}deg)` }}>
              <div className="level-line" />
              <span className="level-label">水平 {cameraRoll.toFixed(1)}°</span>
            </div>
          )}
          {settings.zebra && <div className="zebra-hint">斑马纹</div>}
          {countdown > 0 && <div className="countdown">{countdown}</div>}

          {/* 机位提示：偏离默认视角时给出可点击的复位入口 */}
          {viewMoved && (
            <button className="view-hint" onClick={resetView} title="回到默认镜头位置与视角">
              ↺ 视角已移动 · 复位
            </button>
          )}

          {/* 左侧状态列（快门类型 / 防抖 / ND / 闪光 / 包围） */}
          <div className="vf-status">
            <span>{settings.shutterType === 'electronic' ? '电子快门' : '机械快门'}</span>
            <span>
              {settings.stabilization ? 'IS ON' : 'IS OFF'} {handheldSafe ? '· 手持安全' : '· 建议三脚架'}
              {settings.stabilization && <span className="hint"> · 等效 {formatShutterLabel(effectiveSafeShutter)}</span>}
            </span>
            {settings.ndStops > 0 && <span>ND {settings.ndStops} 档 · 等效 {formatShutterLabel(settings.shutter * Math.pow(2, settings.ndStops))}</span>}
            {settings.flashEnabled && <span title={flashSyncDescription(settings.flashSync, settings.shutter)}>闪光 {settings.flashPowerEV >= 0 ? '+' : ''}{settings.flashPowerEV}EV</span>}
            {settings.bracketingEnabled && (
              <span>BKT {bracketEVs(settings.bracketFrames, settings.bracketStepEV).map((e) => (e > 0 ? `+${e}` : e)).join('/')}{settings.hdrEnabled ? ' · HDR' : ''}</span>
            )}
          </div>

          {/* 底栏：左=三段大读数（Sony 一字横排），中=快门，右=EV 刻度 */}
          <div className="vf-bottom">
            <div className="sony-readout">
              <span className="sr-main">{formatShutterLabel(settings.shutter)}</span>
              <span className="sr-main">F{settings.aperture.toFixed(1)}</span>
              <span className="sr-main">ISO {settings.iso}</span>
              <span className="sr-sub">
                {settings.exposureComp !== 0 && <>EV {settings.exposureComp >= 0 ? '+' : ''}{settings.exposureComp.toFixed(1)} · </>}
                测光 {formatShutterLabel(meterShutter)} · 偏差 {evDelta >= 0 ? '+' : ''}{evDelta.toFixed(1)}
              </span>
            </div>

            <button className="shutter-btn" onClick={shoot} disabled={shooting} title="拍摄（空格）">
              <span className="shutter-ring" />
              <span className="shutter-inner" />
            </button>

            <div className="sony-ev">
              <div className="sony-ev-track">
                {[-3, -2, -1, 0, 1, 2, 3].map((v) => (
                  <i key={v} className={v === 0 ? 'zero' : ''} />
                ))}
                <b style={{ left: `${evPos}%` }} />
              </div>
              <div className="sony-ev-scale">
                <span>-3</span><span>0</span><span>+3</span>
              </div>
              <span className="sr-mini">{Math.round(settings.focalLength)}mm · {sensor.label}</span>
            </div>
          </div>
        </div>
        {flash && <div className="shutter-flash" />}
      </div>

      {/* 机身右肩：复位视角 / 回放 */}
      <div className="body-shoulder right">
        <button className="body-btn" onClick={resetView} title="恢复默认镜头位置及视角">↺</button>
        <button className="body-btn" onClick={() => useCameraStore.getState().setShowPlayback(true)} title="回放">▶</button>
      </div>
    </div>
  );
}

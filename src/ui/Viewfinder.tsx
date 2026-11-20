// src/ui/Viewfinder.tsx — 取景器：挂载 WebGL、叠加构图辅助、快门按钮、状态栏
// P1：单张 / 连拍 / 定时 / 包围曝光 / 多曝光 HDR 的拍摄编排都在这里完成。

import { useEffect, useRef, useState } from 'react';
import { CameraEngine } from '../renderer/CameraEngine';
import { useCameraStore, makeExif } from '../store/useCameraStore';
import { formatShutterLabel } from '../utils/format';
import { bracketEVs, mergeHDR, effectiveHandheldShutter, flashSyncDescription } from '../camera/advanced';
import type { Photo } from '../types/camera';

const RAW_W = 256;
const RAW_H = 160;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 把 RGBA8 编码的线性数据解码为线性浮点（每通道 0..16）。 */
function decodeLinear(buf: Uint8Array): Float32Array {
  const out = new Float32Array(RAW_W * RAW_H * 4);
  for (let i = 0; i < RAW_W * RAW_H * 4; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      out[i + ch] = 16 * Math.pow(buf[i + ch] / 255, 2);
    }
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

export function Viewfinder() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CameraEngine | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const settings = useCameraStore((s) => s.settings);
  const scene = useCameraStore((s) => s.scene);
  const fps = useCameraStore((s) => s.fps);
  const meterShutter = useCameraStore((s) => s.meterShutter);
  const countdown = useCameraStore((s) => s.countdown);
  const shooting = useCameraStore((s) => s.shooting);

  useEffect(() => {
    if (!hostRef.current || engineRef.current) return;
    try {
      const engine = new CameraEngine(hostRef.current);
      engineRef.current = engine;
      const ro = new ResizeObserver(() => engine.resize());
      ro.observe(hostRef.current);
      (window as unknown as { __cameraEngine: CameraEngine }).__cameraEngine = engine;
      return () => { ro.disconnect(); engine.dispose(); engineRef.current = null; };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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

  useEffect(() => {
    (window as unknown as { __cameraCapture: () => void }).__cameraCapture = shoot;
  });

  const safeInfo = effectiveHandheldShutter(settings.shutter, settings.focalLength, engineRef.current?.getCropFactor() ?? 1, settings.stabilization);
  const handheldSafe = safeInfo >= settings.shutter; // 防抖折算后等效快门更短则更安全

  return (
    <div className="viewfinder" ref={hostRef}>
      {error && <div className="gl-error">WebGL 初始化失败：{error}</div>}
      <div className="vf-overlay">
        <div className="vf-topbar">
          <span className="rec-dot" /> LIVE VIEW
          <span className="vf-spacer" />
          <span>M {formatShutterLabel(settings.shutter)} · f/{settings.aperture.toFixed(1)} · ISO{settings.iso}</span>
          <span className="vf-spacer" />
          <span>{fps} FPS</span>
        </div>
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
          <div className="level-overlay" style={{ transform: `translate(-50%,-50%) rotate(${-scene.cameraRoll}deg)` }}>
            <div className="level-line" />
            <span className="level-label">水平 {scene.cameraRoll.toFixed(1)}°</span>
          </div>
        )}
        {settings.zebra && <div className="zebra-hint">斑马纹：高亮区域显示斜纹警告</div>}
        {countdown > 0 && <div className="countdown">{countdown}</div>}
        <div className="vf-bottom">
          <div className="vf-meter">
            测光建议 <b>{formatShutterLabel(meterShutter)}</b>
            <span className="hint">（按当前光圈/ISO）</span>
          </div>
          <button className="shutter-btn" onClick={shoot} disabled={shooting} title="拍摄（空格）">
            <span className="shutter-inner" />
          </button>
          <div className="vf-right">
            <span>WB {settings.wbTemp}K</span>
            <span>{settings.focalLength.toFixed(0)}mm</span>
            {settings.flashEnabled && <span>⚡{settings.flashSync === 'front' ? '前帘' : '后帘'}</span>}
            {settings.bracketingEnabled && <span>BKT {bracketEVs(settings.bracketFrames, settings.bracketStepEV).map((e) => (e > 0 ? `+${e}` : e)).join('/')}</span>}
          </div>
        </div>
        <div className="vf-status">
          <span>{settings.shutterType === 'electronic' ? '电子快门' : '机械快门'}</span>
          <span>{settings.stabilization ? 'IS ON' : 'IS OFF'} {handheldSafe ? '· 手持安全' : '· 建议使用三脚架'}</span>
          <span className="vf-spacer" />
          {settings.ndStops > 0 && <span>ND {settings.ndStops} 档 · 等效 {formatShutterLabel(settings.shutter * Math.pow(2, settings.ndStops))}</span>}
          {settings.flashEnabled && <span title={flashSyncDescription(settings.flashSync, settings.shutter)}>闪光灯 {settings.flashPowerEV >= 0 ? '+' : ''}{settings.flashPowerEV}EV</span>}
        </div>
      </div>
      {flash && <div className="shutter-flash" />}
    </div>
  );
}

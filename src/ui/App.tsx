// src/ui/App.tsx — 应用主布局与键盘快捷键

import { useEffect } from 'react';
import { Viewfinder } from './Viewfinder';
import { ControlPanel } from './ControlPanel';
import { Histogram } from './Histogram';
import { ExposureScale } from './ExposureScale';
import { Playback } from './Playback';
import { useCameraStore, quantizeStop } from '../store/useCameraStore';
import { SHUTTER_STOPS, APERTURE_STOPS, ISO_STOPS } from '../camera/physics';

export function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const st = useCameraStore.getState();
      const s = st.settings;
      const step = e.shiftKey ? 2 : 1;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          (window as unknown as { __cameraCapture?: () => void }).__cameraCapture?.();
          break;
        case 'ArrowUp': case 'ArrowDown': {
          e.preventDefault();
          const dir = e.key === 'ArrowUp' ? 1 : -1;
          // 上/下：曝光补偿（专业相机机顶拨轮语义）
          st.setExposureComp(Math.round((s.exposureComp + dir * step / 3) * 100) / 100);
          break;
        }
        case 'ArrowLeft': case 'ArrowRight': {
          e.preventDefault();
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          // 左/右：光圈整车档切换
          const i = APERTURE_STOPS.findIndex(a => a >= s.aperture - 0.01);
          const next = APERTURE_STOPS[Math.max(0, Math.min(APERTURE_STOPS.length - 1, (i < 0 ? 0 : i) + dir * step))];
          st.setAperture(next);
          break;
        }
        case 'f': case 'F': {
          // F：对焦到画面中心
          st.setFocusPoint(0.5, 0.5);
          if (s.focusMode === 'auto') {
            const eng = (window as unknown as { __cameraEngine?: { autoFocusCenter?: () => number } }).__cameraEngine;
            if (eng?.autoFocusCenter) st.setFocusDistance(eng.autoFocusCenter());
          }
          break;
        }
        case 'p': case 'P': st.toggleFocusPeak(); break;
        case 'd': case 'D': st.toggleDofPreview(); break;
        case 'z': case 'Z': st.toggleZebra(); break;
        case 'g': case 'G': st.toggleGuides(); break;
        case 'h': case 'H': st.toggleLevel(); break;
        case 'b': case 'B': st.setBracketing(!s.bracketingEnabled); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="brand"><span className="brand-mark">◉</span> 真实相机模拟器 <small>REAL CAMERA SIMULATOR · WebGL2 物理成像管线</small></div>
        <div className="header-actions">
          <button onClick={() => useCameraStore.getState().resetCamera()}>↺ 重置相机</button>
          <button onClick={() => useCameraStore.getState().resetScene()}>↺ 默认场景</button>
          <button onClick={() => useCameraStore.getState().setShowPlayback(true)}>▣ 回放</button>
        </div>
      </header>
      <main className="app-main">
        <section className="left-col">
          <Viewfinder />
          <div className="under-vf">
            <ExposureScale />
            <Histogram />
          </div>
        </section>
        <aside className="right-col"><ControlPanel /></aside>
      </main>
      <footer className="app-footer">
        <span>拖动旋转 · 滚轮推拉 · 单击对焦 · 空格拍摄 · ↑↓曝光补偿 · ←→光圈 · F对焦 · P峰值 · D景深 · Z斑马纹 · G辅助线 · H水平仪 · B包围</span>
        <span>使用控制台 <code>__cameraSelfTest()</code> 验证物理公式 · <code>__cameraEngine.setQuality('low')</code> 降级</span>
      </footer>
      <Playback />
    </div>
  );
}

// 暴露档位工具供调试
(window as unknown as { __stopUtils: unknown }).__stopUtils = { SHUTTER_STOPS, APERTURE_STOPS, ISO_STOPS, quantizeStop };

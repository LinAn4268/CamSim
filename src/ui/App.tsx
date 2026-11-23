// src/ui/App.tsx — 应用主布局与键盘快捷键（相机机身造型：机顶转盘 + 取景器 + 菜单面板）

import { useEffect } from 'react';
import { Viewfinder } from './Viewfinder';
import { ControlPanel } from './ControlPanel';
import { Histogram } from './Histogram';
import { ExposureScale } from './ExposureScale';
import { Playback } from './Playback';
import { ModeDial, stepStop } from './ModeDial';
import { useCameraStore, quantizeStop } from '../store/useCameraStore';
import { SHUTTER_STOPS, APERTURE_STOPS, ISO_STOPS } from '../camera/physics';

export function App() {
  // 暴露档位工具供控制台调试：放在副作用里，避免模块导入时执行（SSR / 测试环境下 window 可能不存在）
  useEffect(() => {
    (window as unknown as { __stopUtils: unknown }).__stopUtils = {
      SHUTTER_STOPS, APERTURE_STOPS, ISO_STOPS, quantizeStop,
    };
  }, []);

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
          st.setAperture(stepStop('aperture', s.aperture, dir * step));
          break;
        }
        case '[': case ']': {
          // [ / ]：快门速度整档（模拟机背拨轮）
          e.preventDefault();
          st.setShutter(stepStop('shutter', s.shutter, e.key === ']' ? step : -step));
          break;
        }
        case ',': case '.': {
          // , / . ：ISO 整档
          e.preventDefault();
          st.setIso(stepStop('iso', s.iso, e.key === '.' ? step : -step));
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
        case 'm': case 'M':
          // M：切换对焦模式（真机 AF/MF 拨杆）
          st.setFocusMode(s.focusMode === 'auto' ? 'manual' : 'auto');
          break;
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
      {/* 机顶：型号铭牌 + 模式转盘（真机顶部那一排） */}
      <div className="camera-top">
        <div className="top-plate">
          <span className="top-brand">CamSim</span>
          <span className="top-model">X1</span>
          <span className="top-sub">REAL CAMERA SIMULATOR · WEBGL2</span>
        </div>
        <ModeDial />
        <div className="top-actions">
          <button onClick={() => useCameraStore.getState().resetCamera()} title="重置全部相机参数">↺ 重置</button>
          <button onClick={() => useCameraStore.getState().resetScene()} title="恢复默认布光与场景">◐ 场景</button>
          <button onClick={() => useCameraStore.getState().setShowPlayback(true)} title="打开回放">▣ 回放</button>
        </div>
      </div>

      {/* 机身主体：左=卡口/取景器，右=机背菜单面板 */}
      <div className="camera-shell">
        <main className="app-main">
          <section className="left-col">
            <Viewfinder />
            {/* 机底信息条：曝光刻度 + 直方图，等价于真机肩屏 / 机背信息栏 */}
            <div className="under-vf">
              <ExposureScale />
              <Histogram />
            </div>
          </section>
          <aside className="right-col"><ControlPanel /></aside>
        </main>
      </div>

      <footer className="app-footer">
        <span>拖动旋转 · 滚轮推拉 · 单击对焦 · 空格拍摄 · ↑↓曝光补偿 · ←→光圈 · [ ]快门 · , . ISO · M对焦模式 · F对焦 · P峰值 · D景深 · Z斑马纹 · G辅助线 · H水平仪 · B包围</span>
        <span>控制台 <code>__cameraSelfTest()</code> 验证物理公式 · <code>__cameraEngine.setQuality('low')</code> 手动降级 · 帧率长期偏低时会自动降级</span>
      </footer>
      <Playback />
    </div>
  );
}

// src/ui/Dial.tsx — 机身物理转盘：真机式的圆形刻度盘（拖动 / 滚轮 / 方向键切换档位）
//
// 真实相机顶部的拨盘是按整档定位的，因此这里用「档位数组 + 最近档」而不是连续滑杆：
// 拖动方向决定加减档，转盘指针与刻度会跟着一起转，读数显示在盘下方。

import { useRef } from 'react';

export interface DialProps {
  label: string;
  value: number;
  display: string;
  /** 可选档位（升序）。盘面刻度数量与此一致。 */
  stops: readonly number[];
  onChange: (v: number) => void;
  /** log：快门/光圈/ISO 这类等比序列；linear：曝光补偿这类等差序列。 */
  mode?: 'log' | 'linear';
  accent?: boolean;
  hint?: string;
  /** 转盘上要标注的几个刻度文字（可省略）。 */
  marks?: readonly string[];
}

/** 找到与当前值最接近的档位下标（log 模式按比例距离，线性模式按绝对差）。 */
function nearestIndex(stops: readonly number[], value: number, mode: 'log' | 'linear'): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = mode === 'log'
      ? Math.abs(Math.log(Math.max(stops[i], 1e-9) / Math.max(value, 1e-9)))
      : Math.abs(stops[i] - value);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

export function Dial({ label, value, display, stops, onChange, mode = 'log', accent, hint, marks }: DialProps) {
  // 拖拽时记录「按下瞬间的档位」作为基准，位移始终相对基准换算，
  // 否则每次 pointermove 都用同一份过期的 index 去加偏移，小幅拖动会连跳好几档。
  const drag = useRef<{ y: number; base: number; applied: number } | null>(null);
  const index = nearestIndex(stops, value, mode);
  const n = stops.length;
  const angle = n > 1 ? -135 + (270 * index) / (n - 1) : -135;

  const step = (delta: number) => {
    const next = Math.max(0, Math.min(n - 1, index + delta));
    if (next !== index) onChange(stops[next]);
  };

  return (
    <div
      className={`dial${accent ? ' accent' : ''}`}
      title={hint ?? `${label}：上下拖动或滚轮切换`}
      onPointerDown={(e) => {
        drag.current = { y: e.clientY, base: index, applied: 0 };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // 每 16px 一个档位，拖动幅度与档位数无关，手感一致
        const offset = Math.round((d.y - e.clientY) / 16);
        if (offset === d.applied) return; // 没跨过一档就不触发，避免重复 onChange
        d.applied = offset;
        const next = Math.max(0, Math.min(n - 1, d.base + offset));
        if (next !== index) onChange(stops[next]);
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      // 向上滚 = 加档（与拖拽方向一致），向下滚 = 减档
      onWheel={(e) => { step(e.deltaY < 0 ? 1 : -1); }}
    >
      <svg className="dial-face" viewBox="0 0 100 100" aria-label={`${label} ${display}`}>
        <circle className="dial-body" cx="50" cy="50" r="45" />
        <circle className="dial-inner" cx="50" cy="50" r="33" />
        {stops.map((_, i) => {
          const a = (-135 + (270 * i) / Math.max(1, n - 1)) * (Math.PI / 180);
          const inner = i === index ? 37 : 39;
          return (
            <line
              key={i}
              className={i === index ? 'dial-tick on' : 'dial-tick'}
              x1={50 + Math.sin(a) * inner}
              y1={50 - Math.cos(a) * inner}
              x2={50 + Math.sin(a) * 44}
              y2={50 - Math.cos(a) * 44}
            />
          );
        })}
        <line className="dial-pointer" x1="50" y1="50" x2="50" y2="17" transform={`rotate(${angle} 50 50)`} />
        <circle className="dial-hub" cx="50" cy="50" r="6" />
      </svg>
      <div className="dial-value">{display}</div>
      <div className="dial-label">{label}</div>
      {marks && (
        <div className="dial-marks">{marks.map((m) => <span key={m}>{m}</span>)}</div>
      )}
    </div>
  );
}

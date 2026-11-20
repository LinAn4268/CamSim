// src/ui/Histogram.tsx — 实时 RGB/Luma 直方图 + 过曝/欠曝警告

import { useCameraStore } from '../store/useCameraStore';

export function Histogram() {
  const histogram = useCameraStore((s) => s.histogram);
  const over = useCameraStore((s) => s.overexposedRatio);
  const under = useCameraStore((s) => s.underexposedRatio);
  const BINS = histogram.luma.length || 64;
  const max = Math.max(1, ...histogram.r, ...histogram.g, ...histogram.b, ...histogram.luma);

  const paths = (data: number[], color: string, fill: boolean) => {
    if (!data.length) return null;
    const pts = data.map((v, i) => `${i / (BINS - 1) * 100},${100 - (v / max) * 100}`).join(' ');
    return <polyline points={pts} fill={fill ? `${color}22` : 'none'} stroke={color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />;
  };

  return (
    <div className="histogram">
      <div className="module-title">直方图 <span className="hint">HISTOGRAM</span></div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="hist-svg">
        {paths(histogram.luma, '#9aa3ad', true)}
        {paths(histogram.r, '#ff4d4d', false)}
        {paths(histogram.g, '#43d17a', false)}
        {paths(histogram.b, '#4d8dff', false)}
      </svg>
      <div className="hist-labels"><span>阴影</span><span>中间调</span><span>高光</span></div>
      <div className={`warning ${over > 0.008 ? 'warn-active' : ''}`}>
        ⚠ 过曝 {(over * 100).toFixed(1)}% {over > 0.008 && '（高光溢出）'}
      </div>
      <div className={`warning ${under > 0.008 ? 'warn-active' : ''}`}>
        ⚠ 欠曝 {(under * 100).toFixed(1)}% {under > 0.008 && '（暗部死黑）'}
      </div>
    </div>
  );
}

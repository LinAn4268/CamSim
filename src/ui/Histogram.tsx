// src/ui/Histogram.tsx — 实时 RGB/Luma 直方图 + 过曝/欠曝警告

import { useMemo } from 'react';
import { useCameraStore } from '../store/useCameraStore';

/** 把 64 个分箱折算成 SVG 折线点串；峰值只算一次，避免重复展开数组。 */
function polyline(data: number[], max: number, bins: number): string {
  if (!data.length) return '';
  const out: string[] = [];
  for (let i = 0; i < data.length; i++) {
    out.push(`${(i / (bins - 1) * 100).toFixed(2)},${(100 - (data[i] / max) * 100).toFixed(2)}`);
  }
  return out.join(' ');
}

export function Histogram() {
  const histogram = useCameraStore((s) => s.histogram);
  const over = useCameraStore((s) => s.overexposedRatio);
  const under = useCameraStore((s) => s.underexposedRatio);

  const { lumaPts, rPts, gPts, bPts } = useMemo(() => {
    const bins = histogram.luma.length || 64;
    let max = 1;
    for (const arr of [histogram.r, histogram.g, histogram.b, histogram.luma]) {
      for (const v of arr) if (v > max) max = v;
    }
    return {
      lumaPts: polyline(histogram.luma, max, bins),
      rPts: polyline(histogram.r, max, bins),
      gPts: polyline(histogram.g, max, bins),
      bPts: polyline(histogram.b, max, bins),
    };
  }, [histogram]);

  return (
    <div className="histogram">
      <div className="module-title">直方图 <span className="hint">HISTOGRAM</span></div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="hist-svg">
        {lumaPts && <polyline points={lumaPts} fill="#9aa3ad22" stroke="#9aa3ad" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />}
        {rPts && <polyline points={rPts} fill="none" stroke="#ff4d4d" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />}
        {gPts && <polyline points={gPts} fill="none" stroke="#43d17a" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />}
        {bPts && <polyline points={bPts} fill="none" stroke="#4d8dff" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />}
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

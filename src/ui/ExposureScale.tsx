// src/ui/ExposureScale.tsx — EV 曝光刻度与测光建议

import { useCameraStore } from '../store/useCameraStore';
import { exposureValue, exposureDelta } from '../camera/physics';

export function ExposureScale() {
  const s = useCameraStore((st) => st.settings);
  const meterEV = useCameraStore((st) => st.meterEV);
  const ev = exposureValue(s.aperture, s.shutter, s.iso) + s.exposureComp;
  const delta = exposureDelta(ev, meterEV, 0);
  const pos = Math.max(-5, Math.min(5, delta));

  return (
    <div className="ev-scale">
      <div className="module-title">曝光刻度 <span className="hint">EV</span></div>
      <div className="ev-track">
        {[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((v) => (
          <div key={v} className={`ev-tick ${v === 0 ? 'zero' : ''}`}>
            <div className="tick-line" />
            <span>{v > 0 ? `+${v}` : v}</span>
          </div>
        ))}
        <div className="ev-marker" style={{ left: `${(pos + 5) / 10 * 100}%` }} title={`偏差 ${delta.toFixed(2)}EV`} />
      </div>
      <div className="ev-readout">
        <div><span>实际 EV</span><b>{ev.toFixed(2)}</b></div>
        <div><span>测光 EV</span><b>{meterEV.toFixed(2)}</b></div>
        <div><span>偏差</span><b className={Math.abs(delta) > 1 ? 'bad' : 'good'}>{delta >= 0 ? '+' : ''}{delta.toFixed(2)} EV</b></div>
        <div><span>补偿</span><b>{s.exposureComp >= 0 ? '+' : ''}{s.exposureComp.toFixed(2)} EV</b></div>
      </div>
    </div>
  );
}

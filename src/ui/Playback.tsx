// src/ui/Playback.tsx — 照片回放、EXIF 信息、包围/HDR 标记与带水印导出

import { useState } from 'react';
import { useCameraStore } from '../store/useCameraStore';
import { SENSOR_PROFILES, LENS_PROFILES, formatFileFormat } from '../camera/optics';

export function Playback() {
  const photos = useCameraStore((s) => s.photos);
  const activeId = useCameraStore((s) => s.activePhotoId);
  const show = useCameraStore((s) => s.showPlayback);
  const lastBracket = useCameraStore((s) => s.lastBracket);
  const setShow = useCameraStore((s) => s.setShowPlayback);
  const setActive = useCameraStore((s) => s.setActivePhoto);
  const [watermark, setWatermark] = useState(false);
  if (!show) return null;
  const photo = photos.find((p) => p.id === activeId) ?? photos[0];
  if (!photo) return null;

  const exif = photo.exif;
  const download = () => {
    const ext = photo.format === 'raw' ? 'png' : 'jpg';
    if (!watermark) {
      const a = document.createElement('a');
      a.href = photo.dataUrl;
      a.download = `camera-${photo.id}.${ext}`;
      a.click();
      return;
    }
    // 异步 decode → canvas 合成水印 → 导出
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const lines = [
        `${exif.focalLength}  f/${exif.aperture}  ${exif.shutter}  ISO${exif.iso}`,
        `${SENSOR_PROFILES[exif.sensor]?.label ?? exif.sensor} · ${LENS_PROFILES[exif.lens]?.labelText ?? exif.lens} · ${exif.filmSim.toUpperCase()}`,
        exif.timestamp,
      ];
      const pad = Math.max(8, Math.round(img.width * 0.02));
      const fontSize = Math.max(11, Math.round(img.width * 0.03));
      ctx.font = `500 ${fontSize}px ui-monospace, monospace`;
      const boxH = (fontSize + 6) * lines.length + pad * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, img.height - boxH, img.width, boxH);
      ctx.fillStyle = '#fff';
      lines.forEach((line, i) => ctx.fillText(line, pad, img.height - boxH + pad + fontSize * (i + 1)));
      const a = document.createElement('a');
      a.href = cv.toDataURL(photo.format === 'raw' ? 'image/png' : 'image/jpeg', 0.92);
      a.download = `camera-${photo.id}-wm.${ext}`;
      a.click();
    };
    img.src = photo.dataUrl;
  };

  return (
    <div className="playback">
      <div className="playback-head">
        <b>回放 · 照片参数</b>
        <button onClick={() => setShow(false)}>✕ 关闭</button>
      </div>
      <div className="playback-body">
        <img src={photo.dataUrl} alt="拍摄照片" className="playback-img" />
        <div className="exif">
          <div className="module-title">EXIF 风格信息</div>
          <div className="exif-grid">
            <div><span>快门</span><b>{exif.shutter} ({exif.shutterType === 'electronic' ? '电子' : '机械'})</b></div>
            <div><span>光圈</span><b>{exif.aperture}</b></div>
            <div><span>ISO</span><b>{exif.iso}</b></div>
            <div><span>焦距</span><b>{exif.focalLength} ({Math.round(parseInt(exif.focalLength) * SENSOR_PROFILES[exif.sensor]?.crop)}mm 等效)</b></div>
            <div><span>EV</span><b>{exif.ev.toFixed(2)}</b></div>
            <div><span>曝光补偿</span><b>{exif.exposureComp >= 0 ? '+' : ''}{exif.exposureComp.toFixed(2)} EV</b></div>
            <div><span>测光</span><b>{exif.metering}</b></div>
            <div><span>白平衡</span><b>{exif.wb} / {exif.wbTemp}K</b></div>
            <div><span>对焦距离</span><b>{exif.focusDistance.toFixed(2)} m</b></div>
            <div><span>分辨率</span><b>{photo.width}×{photo.height}</b></div>
            <div><span>格式</span><b>{formatFileFormat(exif.fileFormat)}{photo.rawLinear ? ' · 线性数据' : ''}</b></div>
            <div><span>传感器 / 镜头</span><b>{SENSOR_PROFILES[exif.sensor]?.label ?? exif.sensor} · {LENS_PROFILES[exif.lens]?.label ?? exif.lens}</b></div>
            <div><span>ND / 防抖</span><b>{exif.ndStops} 档 / {exif.stabilization ? 'ON' : 'OFF'}</b></div>
            <div><span>闪光</span><b>{exif.flash}</b></div>
            <div><span>驱动</span><b>{exif.driveMode}</b></div>
            <div><span>胶片模拟</span><b>{exif.filmSim.toUpperCase()}{exif.lut ? ` · ${exif.lut}` : ''}</b></div>
            {exif.bracketEV !== undefined && <div><span>包围 EV</span><b>{exif.bracketEV >= 0 ? '+' : ''}{exif.bracketEV}</b></div>}
            {exif.hdr && <div><span>HDR</span><b>多曝光合成</b></div>}
            <div><span>拍摄时间</span><b>{exif.timestamp}</b></div>
          </div>
          <div className="download-row">
            <label className="inline-check"><input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} /> 加水印</label>
            <button className="download-link" onClick={download}>⬇ 下载照片 ({photo.format === 'raw' ? 'PNG' : 'JPEG'})</button>
          </div>
        </div>
      </div>
      {lastBracket.length > 0 && (
        <div className="bracket-strip">
          <span className="bracket-label">包围序列</span>
          {lastBracket.map((b, i) => (
            <button key={b.photoId} className={b.photoId === photo.id ? 'active' : ''}
              onClick={() => setActive(b.photoId)} title={`EV ${b.ev}`}>
              {i + 1} <small>{b.ev >= 0 ? '+' : ''}{b.ev}EV</small>
            </button>
          ))}
        </div>
      )}
      <div className="filmstrip">
        {photos.map((p) => (
          <img key={p.id} src={p.dataUrl} alt="缩略图"
            className={p.id === photo.id ? 'active' : ''}
            onClick={() => setActive(p.id)} />
        ))}
      </div>
    </div>
  );
}

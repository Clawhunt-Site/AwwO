import { useState } from 'react';

import type { Vr360NodeData } from '../types';
import { PanoramaViewport } from './PanoramaViewport';

export function Vr360NodeCard({ data, onChange }: { data: Vr360NodeData; onChange: (data: Vr360NodeData) => void }) {
  const [warning, setWarning] = useState<string | null>(null);

  const loadImage = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : null;
      if (!url) return;
      const image = new Image();
      image.onload = () => {
        const ratio = image.width / image.height;
        setWarning(Math.abs(ratio - 2) > 0.12 ? `建议使用 2:1 全景图，当前为 ${ratio.toFixed(2)}:1` : null);
        onChange({ ...data, imageUrl: url, fileName: file.name });
      };
      image.src = url;
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="vr-node">
      <PanoramaViewport
        imageUrl={data.imageUrl}
        yaw={data.yaw}
        pitch={data.pitch}
        fov={data.fov}
        onViewChange={(view) => onChange({ ...data, ...view })}
      />
      <div className="vr-node__meta">
        <span>{data.fileName ?? '方向校准网格 · 尚未载入全景图'}</span>
        <label className="cc-file-button">
          选择全景图
          <input type="file" accept="image/*" onChange={(event) => loadImage(event.target.files?.[0])} />
        </label>
      </div>
      {warning ? <p className="cc-warning" role="status">{warning}</p> : null}
      <label className="vr-fov">
        <span>视场角 {Math.round(data.fov)}°</span>
        <input
          type="range"
          min="35"
          max="120"
          value={data.fov}
          onChange={(event) => onChange({ ...data, fov: Number(event.target.value) })}
        />
      </label>
      <div className="vr-reference-actions">
        <button className={data.referenceCount === 4 ? 'is-on' : ''} type="button" onClick={() => onChange({ ...data, referenceCount: 4 })}>4 宫格参考</button>
        <button className={data.referenceCount === 12 ? 'is-on' : ''} type="button" onClick={() => onChange({ ...data, referenceCount: 12 })}>12 宫格参考</button>
      </div>
      {data.referenceCount ? (
        <div className="vr-reference-strip" aria-label={`${data.referenceCount} 个视角参考`}>
          {Array.from({ length: data.referenceCount }, (_, index) => (
            <span key={index}>{Math.round((360 / data.referenceCount) * index)}°</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

import type { Director3DNodeData } from '../types';
import { Director3DStage } from './Director3DStage';

export function Director3DNodeCard({
  data,
  onChange,
  onOpen,
}: {
  data: Director3DNodeData;
  onChange: (data: Director3DNodeData) => void;
  onOpen: () => void;
}) {
  return (
    <div className="director-3d-node">
      <Director3DStage
        data={data}
        onViewChange={(view) => onChange({ ...data, ...view })}
        onCapture={(previewDataUrl) => onChange({
          ...data,
          previewDataUrl,
          savedTake: `${data.scenePreset} · ${data.shotSize} · ${data.lensMm}mm`,
        })}
      />
      <div className="director-3d-preset-row">
        <label>
          <span>场景</span>
          <select
            value={data.scenePreset}
            onChange={(event) => onChange({ ...data, scenePreset: event.target.value as Director3DNodeData['scenePreset'] })}
          >
            <option>摄影棚</option>
            <option>雨夜街道</option>
            <option>废弃剧院</option>
          </select>
        </label>
        <label>
          <span>景别</span>
          <select
            value={data.shotSize}
            onChange={(event) => onChange({ ...data, shotSize: event.target.value as Director3DNodeData['shotSize'] })}
          >
            <option>远景</option>
            <option>中景</option>
            <option>近景</option>
          </select>
        </label>
      </div>
      <fieldset className="director-lens-bank">
        <legend>镜头焦段</legend>
        {[24, 35, 50, 85].map((lens) => (
          <button
            key={lens}
            className={data.lensMm === lens ? 'is-on' : ''}
            type="button"
            onClick={() => onChange({ ...data, lensMm: lens as Director3DNodeData['lensMm'] })}
          >
            {lens}mm
          </button>
        ))}
      </fieldset>
      <div className="director-sliders">
        <label>
          <span>机位距离 {data.cameraDistance.toFixed(1)}m</span>
          <input type="range" min="4" max="14" step="0.2" value={data.cameraDistance} onChange={(event) => onChange({ ...data, cameraDistance: Number(event.target.value) })} />
        </label>
        <label>
          <span>人物横移 {data.actorX.toFixed(1)}m</span>
          <input type="range" min="-3" max="3" step="0.1" value={data.actorX} onChange={(event) => onChange({ ...data, actorX: Number(event.target.value) })} />
        </label>
        <label>
          <span>主光强度 {Math.round(data.keyLightIntensity)}%</span>
          <input type="range" min="0" max="100" value={data.keyLightIntensity} onChange={(event) => onChange({ ...data, keyLightIntensity: Number(event.target.value) })} />
        </label>
      </div>
      <label className="cc-field director-note">
        <span>导演备注</span>
        <textarea rows={2} value={data.directorNote} onChange={(event) => onChange({ ...data, directorNote: event.target.value })} />
      </label>
      {data.savedTake ? <div className="director-saved-take" role="status">TAKE 已保存 · {data.savedTake}</div> : null}
      <button className="cc-button cc-button--wide director-3d-open" type="button" onClick={onOpen}>进入 3D 导演台</button>
    </div>
  );
}

import { buildScriptBeats } from '../engine/document';
import type { ScriptDirectorNodeData } from '../types';

export function ScriptDirectorNodeCard({
  data,
  onChange,
  onOpen,
}: {
  data: ScriptDirectorNodeData;
  onChange: (data: ScriptDirectorNodeData) => void;
  onOpen: () => void;
}) {
  const directScript = () => onChange({
    ...data,
    beats: buildScriptBeats(data.premise, data.targetDurationSec),
  });

  return (
    <div className="script-director-node">
      <div className="script-director-heading">
        <span>AI SCRIPT DESK</span>
        <strong>{data.beats.reduce((total, beat) => total + beat.durationSec, 0)} 秒结构</strong>
      </div>
      <label className="cc-field">
        <span>故事命题</span>
        <textarea
          rows={3}
          value={data.premise}
          onChange={(event) => onChange({ ...data, premise: event.target.value })}
        />
      </label>
      <div className="script-director-meta">
        <label>
          <span>类型</span>
          <select
            value={data.genre}
            onChange={(event) => onChange({ ...data, genre: event.target.value as ScriptDirectorNodeData['genre'] })}
          >
            {['悬疑', '动作', '爱情', '喜剧', '科幻'].map((genre) => <option key={genre}>{genre}</option>)}
          </select>
        </label>
        <label>
          <span>时长</span>
          <input
            type="number"
            min="16"
            max="600"
            value={data.targetDurationSec}
            onChange={(event) => onChange({ ...data, targetDurationSec: Number(event.target.value) })}
          />
        </label>
      </div>
      <label className="cc-field script-director-line">
        <span>人物</span>
        <input value={data.cast} onChange={(event) => onChange({ ...data, cast: event.target.value })} />
      </label>
      <label className="cc-field script-director-line">
        <span>调性</span>
        <input value={data.tone} onChange={(event) => onChange({ ...data, tone: event.target.value })} />
      </label>
      <button className="cc-button cc-button--primary cc-button--wide" type="button" onClick={directScript}>
        重新导演剧本节拍
      </button>
      <button className="cc-button cc-button--wide script-director-open" type="button" onClick={onOpen}>
        进入 AI 剧本导演台
      </button>
      <ol className="script-beat-board" aria-label="剧本节拍表">
        {data.beats.map((beat, index) => (
          <li key={beat.id}>
            <span className="script-beat-index">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{beat.act} · {beat.durationSec}s</strong>
              <textarea
                aria-label={`${beat.act}目标`}
                value={beat.objective}
                onChange={(event) => onChange({
                  ...data,
                  beats: data.beats.map((candidate) => candidate.id === beat.id
                    ? { ...candidate, objective: event.target.value }
                    : candidate),
                })}
              />
              <span>{beat.conflict}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

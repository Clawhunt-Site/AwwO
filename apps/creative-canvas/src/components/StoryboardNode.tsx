import { buildFramesFromPrompt } from '../engine/document';
import type { StoryboardNodeData } from '../types';

export function StoryboardNodeCard({ data, onChange }: { data: StoryboardNodeData; onChange: (data: StoryboardNodeData) => void }) {
  const frameCount = data.rows * data.cols;
  const regenerate = () => onChange({ ...data, frames: buildFramesFromPrompt(data.globalPrompt, frameCount) });
  return (
    <div className="storyboard-node">
      <label className="cc-field">
        <span>故事梗概</span>
        <textarea
          value={data.globalPrompt}
          rows={3}
          onChange={(event) => onChange({ ...data, globalPrompt: event.target.value })}
        />
      </label>
      <div className="storyboard-controls">
        <label>
          <span>画幅</span>
          <select
            value={data.aspectRatio}
            onChange={(event) => onChange({ ...data, aspectRatio: event.target.value as StoryboardNodeData['aspectRatio'] })}
          >
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="2.39:1">2.39:1</option>
          </select>
        </label>
        <label>
          <span>网格</span>
          <select
            value={`${data.rows}x${data.cols}`}
            onChange={(event) => {
              const [rows, cols] = event.target.value.split('x').map(Number);
              onChange({ ...data, rows, cols, frames: buildFramesFromPrompt(data.globalPrompt, rows * cols) });
            }}
          >
            <option value="2x2">2 × 2</option>
            <option value="3x3">3 × 3</option>
            <option value="3x4">3 × 4</option>
          </select>
        </label>
        <button className="cc-button cc-button--primary" type="button" onClick={regenerate}>生成镜头卡</button>
      </div>
      <div className="storyboard-grid" style={{ gridTemplateColumns: `repeat(${data.cols}, minmax(0, 1fr))` }}>
        {data.frames.slice(0, frameCount).map((frame, index) => (
          <label key={frame.id} className={`story-frame is-${frame.status}`}>
            <span className="story-frame__index">{String(index + 1).padStart(2, '0')}</span>
            <textarea
              value={frame.description}
              aria-label={`镜头 ${index + 1} 描述`}
              onChange={(event) => onChange({
                ...data,
                frames: data.frames.map((candidate) => candidate.id === frame.id
                  ? { ...candidate, description: event.target.value, status: 'draft' }
                  : candidate),
              })}
            />
            <span className="story-frame__status">{frame.status === 'ready' ? '已规划' : '待规划'}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

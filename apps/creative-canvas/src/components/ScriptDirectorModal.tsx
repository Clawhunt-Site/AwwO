import { useState } from 'react';

import { buildScriptShots } from '../engine/document';
import type { ScriptDirectorNodeData, ScriptShot } from '../types';

export function ScriptDirectorModal({
  data,
  onChange,
  onClose,
  onCreateStoryboard,
}: {
  data: ScriptDirectorNodeData;
  onChange: (data: ScriptDirectorNodeData) => void;
  onClose: () => void;
  onCreateStoryboard: () => void;
}) {
  const [selectedShotId, setSelectedShotId] = useState<string | null>(data.shots[0]?.id ?? null);
  const selectedShot = data.shots.find((shot) => shot.id === selectedShotId) ?? null;
  const [notice, setNotice] = useState<string | null>(null);

  const splitScript = () => {
    const shots = buildScriptShots(data.premise, data.shotCount, data.cast, data.visualStyle, {
      subject: data.characterReference,
      scene: data.sceneReference,
    });
    onChange({ ...data, shots });
    setSelectedShotId(shots[0]?.id ?? null);
    setNotice(`已拆分 ${shots.length} 个镜头`);
  };

  const updateShot = (next: ScriptShot) => onChange({
    ...data,
    shots: data.shots.map((shot) => shot.id === next.id ? next : shot),
  });

  return (
    <div className="script-studio" role="dialog" aria-modal="true" aria-labelledby="script-studio-title">
      <header className="script-studio-topbar">
        <div className="script-studio-title">
          <span aria-hidden="true">▣</span>
          <div>
            <h2 id="script-studio-title">AI 剧本导演台</h2>
            <p>剧本拆镜 · 故事圣经 · 角色连续性 · 一键铺开 AI 生图节点</p>
          </div>
        </div>
        <div className="script-studio-actions">
          <span>{data.shots.length}/{data.shotCount} 镜头 · {data.aspectRatio}</span>
          <button type="button" disabled={data.shots.length === 0} onClick={onCreateStoryboard}>✦ 生成 AI 生图节点</button>
          <button type="button" onClick={onClose}>退出导演台</button>
        </div>
      </header>

      <div className="script-studio-layout">
        <aside className="script-input-panel">
          <div className="script-panel-heading">
            <div><strong>▦ 剧本输入</strong><span>支持故事梗概、对白、短剧脚本、漫画分镜文案</span></div>
            <button type="button" onClick={splitScript}>⌁ 智能拆分</button>
          </div>
          <button className="script-example-button" type="button">示例模板 <span>展开</span></button>
          <div className="script-recognition">
            <strong>智能识别：{data.premise.trim() ? '故事梗概' : '等待识别'}</strong>
            <span>粘贴剧本后自动判断类型</span>
          </div>
          <textarea
            className="script-source-input"
            aria-label="剧本正文"
            value={data.premise}
            placeholder="粘贴剧本：例如女主夜晚来到废弃车站，发现男主留下的录音……"
            onChange={(event) => onChange({ ...data, premise: event.target.value })}
          />
        </aside>

        <main className="shot-workspace">
          <header>
            <div><strong>镜头卡工作区</strong><span>点击镜头卡可在右侧编辑，后续可接生图、视频、配音和时间线</span></div>
            <span>{data.shots.length}/{data.shotCount}</span>
          </header>
          {data.shots.length > 0 ? (
            <div className="shot-card-grid">
              {data.shots.map((shot, index) => (
                <button
                  key={shot.id}
                  className={selectedShotId === shot.id ? 'is-selected' : ''}
                  type="button"
                  onClick={() => setSelectedShotId(shot.id)}
                >
                  <span>镜头 {String(index + 1).padStart(2, '0')}</span>
                  <div aria-hidden="true"><i /><i /><i /></div>
                  <strong>{shot.shotSize} · {shot.cameraMove}</strong>
                  <p>{shot.action}</p>
                </button>
              ))}
            </div>
          ) : (
            <div className="shot-workspace-empty">
              <div className="shot-skeleton-row" aria-hidden="true"><i /><i /><i /></div>
              <span>⌁</span>
              <h3>先把故事拆成镜头卡</h3>
              <p>左侧输入剧本后点击“智能拆分”，这里会生成故事圣经、镜头标题、角色、动作、景别、机位、运镜、图片提示词和视频提示词。</p>
              <button type="button" onClick={splitScript}>智能拆分剧本</button>
            </div>
          )}
        </main>

        <aside className="director-parameter-panel">
          <section>
            <h3>☷ 导演参数</h3>
            <div className="director-parameter-grid">
              <label><span>类型</span><select value={data.genre} onChange={(event) => onChange({ ...data, genre: event.target.value as ScriptDirectorNodeData['genre'] })}>{['悬疑', '动作', '爱情', '喜剧', '科幻'].map((item) => <option key={item}>{item}</option>)}</select></label>
              <label><span>画幅</span><select value={data.aspectRatio} onChange={(event) => onChange({ ...data, aspectRatio: event.target.value as ScriptDirectorNodeData['aspectRatio'] })}><option>9:16</option><option>16:9</option><option>1:1</option></select></label>
              <label><span>镜头数</span><select value={data.shotCount} onChange={(event) => onChange({ ...data, shotCount: Number(event.target.value) as ScriptDirectorNodeData['shotCount'] })}><option value="4">4 镜头</option><option value="8">8 镜头</option><option value="12">12 镜头</option></select></label>
              <label><span>节奏</span><select value={data.pace} onChange={(event) => onChange({ ...data, pace: event.target.value as ScriptDirectorNodeData['pace'] })}><option>舒缓节奏</option><option>标准节奏</option><option>快速节奏</option></select></label>
            </div>
            <label className="director-style-field"><span>视觉风格</span><input value={data.visualStyle} onChange={(event) => onChange({ ...data, visualStyle: event.target.value })} /></label>
            <label className="director-check"><input type="checkbox" checked={data.maintainCharacterContinuity} onChange={(event) => onChange({ ...data, maintainCharacterContinuity: event.target.checked })} />自动整理角色连续性</label>
            <label className="director-check"><input type="checkbox" checked={data.generateVideoPrompts} onChange={(event) => onChange({ ...data, generateVideoPrompts: event.target.checked })} />同时生成视频提示词</label>
            <div className="director-button-row"><button type="button" onClick={splitScript}>重新拆分</button><button type="button" onClick={() => onChange({
              ...data,
              shots: [...data.shots, ...buildScriptShots(data.premise, 1, data.cast, data.visualStyle, {
                subject: data.characterReference,
                scene: data.sceneReference,
              })],
            })}>铺生图节点</button></div>
          </section>

          <section className="director-more-tools">
            <h3>更多工具</h3>
            <article><strong>角色参考</strong><p>绑定人物参考，生图时自动带入并保持连续性。</p><input aria-label="角色参考" placeholder="角色名或本地资产说明" value={data.characterReference} onChange={(event) => onChange({ ...data, characterReference: event.target.value })} /></article>
            <article><strong>场景参考</strong><p>绑定环境或地点，作为所有镜头的场景锚点。</p><input aria-label="场景参考" placeholder="场景名或本地资产说明" value={data.sceneReference} onChange={(event) => onChange({ ...data, sceneReference: event.target.value })} /></article>
          </section>

          <section className="current-shot-panel">
            <h3>当前镜头</h3>
            {selectedShot ? (
              <>
                <label><span>动作</span><textarea value={selectedShot.action} onChange={(event) => updateShot({ ...selectedShot, action: event.target.value })} /></label>
                <label><span>图片提示词</span><textarea value={selectedShot.imagePrompt} onChange={(event) => updateShot({ ...selectedShot, imagePrompt: event.target.value })} /></label>
                {data.generateVideoPrompts ? (
                  <label><span>Seedance 视频提示词</span><textarea className="seedance-prompt-textarea" value={selectedShot.videoPrompt} onChange={(event) => updateShot({ ...selectedShot, videoPrompt: event.target.value })} /></label>
                ) : null}
              </>
            ) : <p>拆分完成后，选择镜头卡进行编辑。</p>}
          </section>
        </aside>
      </div>
      {notice ? <div className="script-studio-notice" role="status">{notice}</div> : null}
    </div>
  );
}

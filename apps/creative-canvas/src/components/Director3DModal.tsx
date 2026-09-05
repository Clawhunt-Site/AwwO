import { useState } from 'react';

import { buildDirector3DSeedancePrompt } from '../engine/seedancePrompt';
import type { Director3DNodeData } from '../types';
import { Director3DStage } from './Director3DStage';

const SHOT_TEMPLATES = [
  ['双人对话', '两人对峙/聊天，适合短剧冲突', '中景', 50],
  ['低机位压迫', '侧拍主角，适合反转、掌权', '近景', 35],
  ['口播主角', '单人正对镜头，适合数字人口播', '中景', 50],
  ['商品展示', '人物与商品前景，适合电商种草', '近景', 85],
  ['情绪特写', '近景盯脸，适合反转前的情绪', '近景', 85],
  ['过肩对话', '前景压一人，后景看主角反应', '中景', 50],
  ['俯视调度', '看清人物和道具关系', '远景', 35],
  ['主角出场', '人物向镜头走来，适合开场', '远景', 35],
  ['3秒钩子', '人物近景开口，适合短视频开场', '近景', 50],
  ['反转揭晓', '前景遮挡后景揭晓', '中景', 50],
  ['前后对比', '左右对照构图', '中景', 35],
  ['美食特写', '桌面近景，突出质感', '近景', 85],
  ['空间探店', '广角展示环境', '远景', 24],
  ['车品展示', '人物带车或大件商品', '远景', 35],
] as const;

export function Director3DModal({
  data,
  onChange,
  onClose,
  onCreateFirstFrame,
}: {
  data: Director3DNodeData;
  onChange: (data: Director3DNodeData) => void;
  onClose: () => void;
  onCreateFirstFrame: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [stageOnly, setStageOnly] = useState(false);

  const videoPrompt = () => buildDirector3DSeedancePrompt(data);

  const exportScene = () => {
    const payload = JSON.stringify({ ...data, previewDataUrl: data.previewDataUrl ? '[local preview image]' : null }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'superclaw-3d-shot.json';
    link.click();
    URL.revokeObjectURL(url);
    setNotice('已导出 3D 镜头参数');
  };

  const chooseTemplate = (template: typeof SHOT_TEMPLATES[number]) => {
    onChange({
      ...data,
      selectedShotTemplate: template[0],
      shotSize: template[2],
      lensMm: template[3],
      directorNote: template[1],
    });
    setNotice(`已应用镜头：${template[0]}`);
  };

  const connectVideo = () => {
    onChange({ ...data, videoPrompt: videoPrompt() });
    setNotice('已生成本地视频提示词');
  };

  const copyVideoPrompt = async () => {
    const prompt = data.videoPrompt || videoPrompt();
    onChange({ ...data, videoPrompt: prompt });
    if (!navigator.clipboard) {
      setNotice('视频提示词已准备，可从镜头方案中复制');
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      setNotice('已复制视频提示词');
    } catch {
      setNotice('视频提示词已准备，可从镜头方案中复制');
    }
  };

  return (
    <div className="director-3d-studio" role="dialog" aria-modal="true" aria-labelledby="director-3d-title">
      <header className="director-3d-studio-topbar">
        <div><h2 id="director-3d-title">◇ 3D 导演台</h2><span>{data.backgroundName ?? '未设置背景'}</span></div>
        <nav aria-label="3D 场景状态">
          <span>● 背景 {data.backgroundName ?? '未设置'}</span>
          <span>┬ 人物 {data.characters.length}</span>
          <span>▦ 道具 {data.props.length}</span>
        </nav>
        <div><button type="button" onClick={exportScene}>⇩ 高级导出</button><button type="button" onClick={onCreateFirstFrame}>✦ 接 AI 首帧</button><button type="button" onClick={onClose}>退出</button></div>
      </header>

      <main className={`director-3d-studio-body${stageOnly ? ' is-stage-only' : ''}`}>
        <div className="director-current-intent"><strong>当前镜头意图：</strong>{data.selectedShotTemplate ?? '未选择，可先点下面的一键镜头'}</div>
        <section className="quick-shot-panel">
          <header><strong>新手一键镜头</strong><span>点一下自动摆人物 + 镜头</span></header>
          <div>
            {SHOT_TEMPLATES.map((template) => (
              <button key={template[0]} className={data.selectedShotTemplate === template[0] ? 'is-selected' : ''} type="button" onClick={() => chooseTemplate(template)}>
                <strong>{template[0]}</strong><span>{template[1]}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="director-3d-main-stage">
          <Director3DStage
            data={data}
            onViewChange={(view) => onChange({ ...data, ...view })}
            onCapture={(previewDataUrl) => onChange({ ...data, previewDataUrl, savedTake: `${data.selectedShotTemplate ?? data.shotSize} · ${data.lensMm}mm` })}
          />
          <div className="director-stage-distance">距离 {data.cameraDistance.toFixed(1)}m</div>
          <div className="director-stage-help"><span>拖拽旋转</span><span>滚轮缩放</span><span>右键平移</span></div>
        </section>

        <div className="director-ai-actions"><button type="button" onClick={() => void copyVideoPrompt()}>▣ 复制视频提示词</button><button type="button" onClick={connectVideo}>✦ 接 AI 视频</button></div>
        <p className="director-flow-note"><strong>小白流程：</strong>先摆好 3D 镜头，点“接 AI 视频”会生成本地镜头提示词；再用“接 AI 首帧”铺到画布，供后续生图和视频节点使用。</p>
        {data.videoPrompt ? (
          <section className="director-video-prompt-panel">
            <label htmlFor="director-seedance-prompt">最终 Seedance 提示词</label>
            <textarea id="director-seedance-prompt" readOnly value={data.videoPrompt} />
          </section>
        ) : null}

        <section className="director-character-panel">
          <header><strong>人物</strong><button type="button" onClick={() => onChange({ ...data, characters: [] })}>清空</button></header>
          <div>
            {data.characters.map((character) => (
              <span key={character.id}><i style={{ background: character.color }} />{character.name}<button type="button" aria-label={`移除 ${character.name}`} onClick={() => onChange({ ...data, characters: data.characters.filter((item) => item.id !== character.id) })}>×</button></span>
            ))}
            <button type="button" onClick={() => onChange({ ...data, characters: [...data.characters, { id: `actor-${Date.now()}`, name: `#${data.characters.length + 1} 站立`, color: '#4f8cff', x: 0, z: 1 }] })}>＋ 添加站立</button>
          </div>
        </section>

        <div className="director-bottom-actions">
          <button type="button" onClick={() => setStageOnly((current) => !current)}>{stageOnly ? '↙ 返回完整导演台' : '↗ 全屏操控'}</button>
          <label>⇧ 上传背景<input type="file" accept="image/*" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => onChange({ ...data, backgroundName: file.name, backgroundDataUrl: typeof reader.result === 'string' ? reader.result : null });
            reader.readAsDataURL(file);
          }} /></label>
        </div>
      </main>
      {notice ? <div className="director-3d-notice" role="status">{notice}</div> : null}
    </div>
  );
}

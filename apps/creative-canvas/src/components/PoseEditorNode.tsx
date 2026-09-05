import type { PoseNodeData } from '../types';
import { PoseSkeleton } from './PoseSkeleton';

export function PoseEditorNodeCard({
  data,
  onChange,
  onOpen,
}: {
  data: PoseNodeData;
  onChange: (data: PoseNodeData) => void;
  onOpen: () => void;
}) {
  return (
    <div className="pose-node">
      <div className="pose-node__preview">
        {data.previewDataUrl ? (
          <img src={data.previewDataUrl} alt="已保存的姿势骨架参考" />
        ) : (
          <PoseSkeleton joints={data.joints} />
        )}
        <span>{data.previewDataUrl ? '已保存骨架参考' : 'AI 动作参考'}</span>
      </div>
      <p>调整关节并把骨架作为分镜姿势约束。</p>
      <div className="pose-node__locks">
        {[
          ['lockHands', '手脚'],
          ['lockFacing', '朝向'],
          ['lockPose', '姿态'],
        ].map(([key, label]) => (
          <button
            key={key}
            className={data[key as keyof PoseNodeData] ? 'is-on' : ''}
            type="button"
            onClick={() => onChange({ ...data, [key]: !data[key as keyof PoseNodeData] })}
          >
            {label}
          </button>
        ))}
      </div>
      <button className="cc-button cc-button--primary cc-button--wide" type="button" onClick={onOpen}>进入动作编辑</button>
    </div>
  );
}

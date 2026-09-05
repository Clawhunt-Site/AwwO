import { useMemo, useRef, useState } from 'react';

import type { PoseJoint, PoseJointId, PoseNodeData } from '../types';
import { PoseSkeleton } from './PoseSkeleton';

function skeletonDataUrl(joints: PoseJoint[]): string {
  const points = new Map(joints.map((joint) => [joint.id, joint]));
  const bonePairs: Array<[PoseJointId, PoseJointId]> = [
    ['head', 'neck'], ['neck', 'leftShoulder'], ['neck', 'rightShoulder'],
    ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
    ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
    ['neck', 'pelvis'], ['pelvis', 'leftKnee'], ['pelvis', 'rightKnee'],
    ['leftKnee', 'leftAnkle'], ['rightKnee', 'rightAnkle'],
  ];
  const lines = bonePairs
    .map(([fromId, toId]) => {
      const from = points.get(fromId)!;
      const to = points.get(toId)!;
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#20d7ff" stroke-width="10" stroke-linecap="round"/>`;
    })
    .join('');
  const circles = joints
    .map((joint) => `<circle cx="${joint.x}" cy="${joint.y}" r="${joint.id === 'head' ? 24 : 13}" fill="#111427" stroke="#ffffff" stroke-width="7"/>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 640" width="480" height="640"><rect width="480" height="640" fill="#090b14"/>${lines}${circles}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function PoseEditorModal({
  data,
  onCancel,
  onSave,
}: {
  data: PoseNodeData;
  onCancel: () => void;
  onSave: (next: PoseNodeData) => void;
}) {
  const [joints, setJoints] = useState(() => data.joints.map((joint) => ({ ...joint })));
  const [activeJoint, setActiveJoint] = useState<PoseJointId | null>(null);
  const [locks, setLocks] = useState({
    hands: data.lockHands,
    facing: data.lockFacing,
    pose: data.lockPose,
  });
  const stageRef = useRef<HTMLDivElement>(null);
  const jointById = useMemo(() => new Map(joints.map((joint) => [joint.id, joint])), [joints]);

  const startJointDrag = (jointId: PoseJointId, event: React.PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    const stage = stageRef.current;
    if (!stage) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveJoint(jointId);

    const move = (pointerEvent: PointerEvent) => {
      const bounds = stage.getBoundingClientRect();
      const x = Math.max(22, Math.min(458, ((pointerEvent.clientX - bounds.left) / bounds.width) * 480));
      const y = Math.max(22, Math.min(618, ((pointerEvent.clientY - bounds.top) / bounds.height) * 640));
      setJoints((current) => current.map((joint) => (joint.id === jointId ? { ...joint, x, y } : joint)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setActiveJoint(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const nudgeJoint = (jointId: PoseJointId, event: React.KeyboardEvent<SVGCircleElement>) => {
    const offsets: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-5, 0],
      ArrowRight: [5, 0],
      ArrowUp: [0, -5],
      ArrowDown: [0, 5],
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    setJoints((current) => current.map((joint) => joint.id === jointId
      ? { ...joint, x: Math.max(22, Math.min(458, joint.x + offset[0])), y: Math.max(22, Math.min(618, joint.y + offset[1])) }
      : joint));
  };

  return (
    <div className="pose-modal" role="dialog" aria-modal="true" aria-labelledby="pose-editor-title">
      <div className="pose-modal__topbar">
        <div>
          <span className="pose-modal__eyebrow">AI 动作参考</span>
          <h2 id="pose-editor-title">姿势编辑器</h2>
        </div>
        <div className="pose-modal__actions">
          <button className="cc-button cc-button--quiet" type="button" onClick={onCancel}>退出</button>
          <button
            className="cc-button cc-button--primary"
            type="button"
            onClick={() => onSave({
              ...data,
              joints,
              previewDataUrl: skeletonDataUrl(joints),
              lockHands: locks.hands,
              lockFacing: locks.facing,
              lockPose: locks.pose,
            })}
          >
            保存骨架图
          </button>
        </div>
      </div>
      <div className="pose-modal__body">
        <aside className="pose-guide">
          <span className="pose-guide__step">动作工作流</span>
          <h3>先摆轮廓，再锁约束</h3>
          <p>拖动中间关节调整人物动作，也可用方向键微调。保存后，骨架图会回填到姿势节点并继续传给分镜节点。</p>
          <div className="pose-locks">
            {[
              ['hands', '锁手脚动作'],
              ['facing', '锁身体朝向'],
              ['pose', '锁人物姿态'],
            ].map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={locks[key as keyof typeof locks]}
                  onChange={(event) => setLocks((current) => ({ ...current, [key]: event.target.checked }))}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </aside>
        <div ref={stageRef} className="pose-stage">
          <div className="pose-stage__axis pose-stage__axis--x" />
          <div className="pose-stage__axis pose-stage__axis--y" />
          <PoseSkeleton
            joints={[...jointById.values()]}
            interactive
            activeJoint={activeJoint}
            onJointPointerDown={startJointDrag}
            onJointKeyDown={nudgeJoint}
          />
        </div>
        <aside className="pose-output-note">
          <span>输出</span>
          <strong>骨架参考图</strong>
          <p>首个 MVP 输出透明语义骨架；深度图、法向图和多人场景在后续 3D 阶段接入。</p>
        </aside>
      </div>
    </div>
  );
}

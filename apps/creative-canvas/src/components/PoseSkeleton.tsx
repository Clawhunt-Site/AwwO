import type { PoseJoint, PoseJointId } from '../types';

export const POSE_BONES: Array<[PoseJointId, PoseJointId]> = [
  ['head', 'neck'],
  ['neck', 'leftShoulder'],
  ['neck', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['neck', 'pelvis'],
  ['pelvis', 'leftKnee'],
  ['pelvis', 'rightKnee'],
  ['leftKnee', 'leftAnkle'],
  ['rightKnee', 'rightAnkle'],
];

export function PoseSkeleton({
  joints,
  interactive = false,
  activeJoint,
  onJointPointerDown,
  onJointKeyDown,
}: {
  joints: PoseJoint[];
  interactive?: boolean;
  activeJoint?: PoseJointId | null;
  onJointPointerDown?: (jointId: PoseJointId, event: React.PointerEvent<SVGCircleElement>) => void;
  onJointKeyDown?: (jointId: PoseJointId, event: React.KeyboardEvent<SVGCircleElement>) => void;
}) {
  const byId = new Map(joints.map((joint) => [joint.id, joint]));
  return (
    <svg
      className={`pose-skeleton${interactive ? ' is-interactive' : ''}`}
      viewBox="0 0 480 640"
      role="img"
      aria-label="可编辑人物骨架"
    >
      <defs>
        <linearGradient id="pose-bone-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#61e6ff" />
          <stop offset="1" stopColor="#a98cff" />
        </linearGradient>
      </defs>
      {POSE_BONES.map(([fromId, toId]) => {
        const from = byId.get(fromId);
        const to = byId.get(toId);
        if (!from || !to) return null;
        return (
          <line
            key={`${fromId}-${toId}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="url(#pose-bone-gradient)"
            strokeWidth="10"
            strokeLinecap="round"
          />
        );
      })}
      {joints.map((joint) => (
        <circle
          key={joint.id}
          className={activeJoint === joint.id ? 'is-active' : ''}
          cx={joint.x}
          cy={joint.y}
          r={joint.id === 'head' ? 24 : 13}
          fill={joint.id === 'head' ? '#f8f5ff' : '#111427'}
          stroke={activeJoint === joint.id ? '#ffbd6e' : '#f8f5ff'}
          strokeWidth="7"
          tabIndex={interactive ? 0 : undefined}
          aria-label={interactive ? `拖动关节 ${joint.id}` : undefined}
          onPointerDown={interactive ? (event) => onJointPointerDown?.(joint.id, event) : undefined}
          onKeyDown={interactive ? (event) => onJointKeyDown?.(joint.id, event) : undefined}
        />
      ))}
    </svg>
  );
}

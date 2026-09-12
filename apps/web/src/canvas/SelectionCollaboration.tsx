import { useState } from 'react';
import { MessagesSquare, Settings2, Play } from 'lucide-react';
import type { CanvasNode } from './canvasDoc';
import type { GraphCollaborationPolicy, GraphCollaborationSnapshot } from '../saas/graphRuns';
import { useCanvasI18n } from './i18n';
import './selectionCollaboration.css';

export function SelectionCollaboration({ nodes, disabled, available, onStart }: {
  nodes: ReadonlyArray<CanvasNode>; disabled: boolean; available: boolean;
  onStart: (ids: string[], policy: GraphCollaborationPolicy) => void;
}) {
  const { locale } = useCanvasI18n();
  const zh = locale === 'zh';
  const [settings, setSettings] = useState(false);
  const [goal, setGoal] = useState('');
  const [rounds, setRounds] = useState(1);
  const [lead, setLead] = useState('');
  if (nodes.length < 2) return null;
  const ids = nodes.map(node => node.id);
  const synthesizerNodeId = ids.includes(lead) ? lead : ids[0];
  const invalid = nodes.length > 6 || nodes.some(node => node.kind !== 'session' || node.team);
  const defaultGoal = zh
    ? `围绕这些组件的任务共同完善方案：${nodes.map(node => node.title).join('、')}。独立提出方案，认真检查其他方案的漏洞和取舍，结合评议形成可执行的综合方案。`
    : `Improve the shared solution for: ${nodes.map(node => node.title).join(', ')}. Propose independently, examine the other proposals and their tradeoffs, and synthesize an actionable result.`;
  const reason = !available ? (zh ? '请在服务器工作区使用跨节点互审' : 'Use a server workspace for cross-node review')
    : invalid ? (zh ? '请选择 2–6 个独立 Agent 节点；暂不支持包含节点团队的选区' : 'Select 2–6 individual Agent nodes; nested teams are not supported yet') : '';
  return <section className="awwo-selection-collaboration" aria-label={zh ? '选区互审' : 'Review selection'} onPointerDown={event => event.stopPropagation()}>
    <div className="awwo-selection-actions">
      <MessagesSquare size={17} aria-hidden="true" />
      <span>{zh ? `已选 ${nodes.length} 个组件` : `${nodes.length} components selected`}</span>
      <span className="awwo-selection-budget">{zh ? `${rounds} 轮 · 最多 ${2 * nodes.length * rounds + 1} 次调用` : `${rounds} round(s) · up to ${2 * nodes.length * rounds + 1} calls`}</span>
      <button type="button" aria-label={zh ? '互审设置' : 'Review settings'} aria-expanded={settings} disabled={disabled} onClick={() => setSettings(value => !value)}><Settings2 size={15} /></button>
      <button type="button" className="awwo-selection-start" disabled={disabled || Boolean(reason)} title={reason || undefined}
        onClick={() => onStart(ids, { goal: goal.trim() || defaultGoal, rounds, synthesizerNodeId })}><Play size={14} />{zh ? '互审优化' : 'Review & improve'}</button>
    </div>
    {reason && <p role="status">{reason}</p>}
    {settings && <div className="awwo-selection-settings">
      <label>{zh ? '共同目标' : 'Shared goal'}<textarea maxLength={4000} rows={2} value={goal} placeholder={defaultGoal} disabled={disabled} onChange={e => setGoal(e.target.value)} /></label>
      <div><label>{zh ? '互审轮数' : 'Review rounds'}<select value={rounds} disabled={disabled} onChange={e => setRounds(Number(e.target.value))}>{[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <label>{zh ? '负责汇总' : 'Synthesize with'}<select value={synthesizerNodeId} disabled={disabled} onChange={e => setLead(e.target.value)}>{nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label></div>
      <p>{zh ? '各自提案 → 互相评议 → 汇总方案。过程保留在各组件原有的 Session 中。' : 'Independent proposals → peer reviews → synthesis. Each component keeps its own Session.'}</p>
    </div>}
  </section>;
}

/** These are temporary execution connections; they never change the saved graph. */
export function CollaborationFlow({ nodes, collaboration, running, scale = 1 }: {
  nodes: ReadonlyArray<CanvasNode>; collaboration?: GraphCollaborationSnapshot; running: boolean; scale?: number;
}) {
  if (!collaboration) return null;
  const turns = collaboration.turns ?? [];
  const active = running ? turns.find(turn => turn.status === 'running') : undefined;
  if (!active || (active.phase === 'proposal' && active.round <= 1)) return null;
  const target = nodes.find(node => node.id === active.nodeId);
  if (!target) return null;
  const sourcePhase = active.phase === 'review' ? 'proposal' : 'review';
  const sourceRound = active.phase === 'proposal' ? active.round - 1 : active.round;
  const sources = new Set(turns.filter(turn => turn.status === 'completed' && turn.phase === sourcePhase
    && turn.round === sourceRound && turn.nodeId !== active.nodeId).map(turn => turn.nodeId));
  return <svg className="awwo-collaboration-flow" aria-hidden="true" data-testid="collaboration-flow">
    {nodes.filter(node => sources.has(node.id)).map(source => {
      const x = source.x + source.w, y = source.y + source.h / 2;
      const tx = target.x, ty = target.y + target.h / 2;
      const bend = Math.max(70, Math.abs(tx - x) * .4);
      const arrowScale = 1 / Math.max(.1, scale);
      return <g key={source.id}><path d={`M ${x} ${y} C ${x + bend} ${y}, ${tx - bend} ${ty}, ${tx} ${ty}`} />
        <path className="awwo-collaboration-arrow" d={`M ${tx - 9 * arrowScale} ${ty - 5 * arrowScale} L ${tx} ${ty} L ${tx - 9 * arrowScale} ${ty + 5 * arrowScale}`} /></g>;
    })}
  </svg>;
}

export function CollaborationStatus({ nodes, collaboration }: { nodes: ReadonlyArray<CanvasNode>; collaboration: GraphCollaborationSnapshot }) {
  const { locale } = useCanvasI18n();
  const zh = locale === 'zh';
  const active = collaboration.turns.find(turn => turn.status === 'running');
  const completed = collaboration.turns.filter(turn => turn.runId && turn.status === 'completed').length;
  const name = nodes.find(node => node.id === active?.nodeId)?.title;
  const phase = active?.phase ?? collaboration.phase;
  const phaseText = phase === 'review' ? (zh ? '评议方案' : 'Reviewing proposals') : phase === 'synthesis' ? (zh ? '汇总方案' : 'Synthesizing') : (zh ? '提出方案' : 'Proposing');
  return <section className="awwo-selection-collaboration" role="status" aria-live="polite">
    <div className="awwo-selection-actions"><MessagesSquare size={17} /><strong>{zh ? '互审进行中' : 'Peer review in progress'}</strong>
      <span>{zh ? `第 ${active?.round || collaboration.round || 1} 轮` : `Round ${active?.round || collaboration.round || 1}`}</span>
      <span>{name ? `${name} · ` : ''}{active ? phaseText : (zh ? '等待下一回合' : 'Waiting for the next turn')}</span>
      <span className="awwo-selection-budget">{completed} / {collaboration.maxModelCalls}</span></div>
    <progress aria-label={zh ? '互审进度' : 'Review progress'} value={completed} max={collaboration.maxModelCalls} style={{ width: '100%', height: 4, marginTop: 7 }} />
  </section>;
}

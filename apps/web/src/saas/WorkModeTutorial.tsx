import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleSlash, Play, TriangleAlert, X } from 'lucide-react';
import type { UiLocale } from '../locale';
import { PRODUCTION_WORKFLOWS } from './productionWorkflows';
import { formatDuration, loadProductionRun, type ProductionRunRecord } from './productionRuns';
import './work-mode-tutorial.css';

export type WorkModeTutorialProps = {
  open: boolean;
  /** A new account must walk through every step: no close, no skip, and Escape does nothing. */
  mandatory?: boolean;
  locale: UiLocale;
  readOnly?: boolean;
  /** `completed` only after the last step. */
  onClose: (completed: boolean) => void;
  /** Focus the home prompt box after the tutorial; never submits it. */
  onStart?: () => void;
};
type Copy = readonly [string, string];
const EXAMPLE = PRODUCTION_WORKFLOWS['pixel-platformer'];
/** Long enough for a step's scene to play once; the next step unlocks after it. */
export const STEP_DWELL_MS = 2400;
const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const STEPS: ReadonlyArray<{ key: string; title: Copy; body: Copy; readOnlyBody?: Copy }> = [
  { key: 'overview', title: ['AwwO 怎么工作', 'How AwwO works'], body: ['在 AwwO 里，一件事不交给一个聊天框，而是交给一支 Agent 团队。你写一句需求，AwwO 把它铺成一张画布：每个节点是一位 Agent，每条连线是一次交接。用一分钟看懂这张画布。',
    'In AwwO, a job goes to a team of agents, not to one chat box. You write one brief, and AwwO lays it out as a canvas: every node is an agent and every connection is a handoff. Take a minute to learn to read that canvas.'] },
  { key: 'plan', title: ['一句需求，先铺成一张画布', 'One brief becomes a canvas'], body: ['在首页输入框写下目标并发送，AwwO 会新建画布并开始规划：需要哪些角色、谁先谁后、彼此交接什么。规划出来的画布你可以直接改——增删节点、改任务、重新连线；也可以从制作案例里复制一张现成的。',
    'Write your goal in the home prompt box and send it: AwwO creates a canvas and plans it — which roles are needed, in what order, and what each hands to the next. You can change the plan directly: add or remove nodes, edit tasks, rewire connections. Or copy a ready-made canvas from the production cases.'] },
  { key: 'node', title: ['节点：一位 Agent，一项任务', 'A node is one agent with one task'], body: ['每个节点有自己的角色、模型和任务要求：左边是它要收到的输入，右边是它交出的成果，任务里写着验收标准。一个节点只做好自己这一件事。',
    'Every node has its own role, model and task: on the left the inputs it needs, on the right what it hands over, and its task spells out the acceptance criteria. A node does one thing, and does it well.'] },
  { key: 'handoff', title: ['连线：上游的真实产出就是下游的输入', 'A connection hands real output downstream'], body: ['连线不是装饰：上游节点交出的内容，会原样送进下游节点的输入。一个节点要等它的每一路输入都到齐，才会开始。',
    'Connections are not decoration: whatever an upstream node delivers goes, as it is, into the downstream node’s input. A node starts only once every one of its inputs has arrived.'] },
  { key: 'stages', title: ['阶段：能同时做的，就一起做', 'Stages: what can run together, does'], body: ['彼此没有依赖的节点同属一个阶段，可以并行，比如美术、关卡和音效互不等待，同时开工的数量取决于工作区的并发上限；它们都交付之后，程序节点再把三份成果合起来。',
    'Nodes that do not depend on each other share a stage and can run in parallel, like art, levels and sound, which never wait for each other; how many start at once depends on the workspace’s concurrency limit. Once all three have delivered, the code node puts their work together.'] },
  { key: 'run', title: ['运行：按阶段推进，状态一目了然', 'Run: stage by stage, every state in view'], body: ['点「运行图」后，任务在服务器上按阶段推进，关掉页面也会继续。每个节点显示进行中、完成、失败或被阻断：一个节点失败，依赖它的下游会停下；改好以后可以只重跑这一段，没受影响的结果会被沿用。',
    'Choose “Run graph” and the work advances stage by stage on the server, even if you close the page. Every node shows running, done, failed or blocked: when a node fails, everything downstream of it stops; once fixed, you can rerun just that part and keep the results it did not touch.'] },
  { key: 'deliver', title: ['验收与交付，然后轮到你', 'Review, delivery — then it is your turn'], body: ['最后由验收 Agent 对照标准逐项检查，把确认通过的、发现的缺陷和没法验证的分开写清楚。成品在节点的交付区预览和下载。现在去写你的第一个需求，或者打开一个制作案例，看它是怎么一步步做出来的。',
    'Finally a review agent checks the work against the criteria, keeping what passed, the defects it found and what it could not verify apart. Results preview and download in each node’s deliverables. Now write your first brief, or open a production case to see how it was made, step by step.'],
    readOnlyBody: ['最后由验收 Agent 对照标准逐项检查，把确认通过的、发现的缺陷和没法验证的分开写清楚。成品在节点的交付区预览和下载。现在打开一张团队画布看看，或者打开一个制作案例，看它是怎么一步步做出来的。',
      'Finally a review agent checks the work against the criteria, keeping what passed, the defects it found and what it could not verify apart. Results preview and download in each node’s deliverables. Now open one of your team’s canvases, or open a production case to see how it was made, step by step.'] },
];

const text = (copy: Copy, locale: UiLocale) => copy[locale === 'zh' ? 0 : 1];
const nodeTitle = (id: string, locale: UiLocale) => EXAMPLE.nodes.find(node => node.id === id)?.title[locale] ?? id;

/** The example canvas as columns, from the real workflow behind the pixel platformer case. */
function MiniCanvas({ locale, highlight, states, labels }: { locale: UiLocale; highlight?: number; states?: Readonly<Record<string, 'done' | 'running' | 'waiting' | 'failed' | 'blocked'>>; labels?: Readonly<Record<string, string>> }) {
  const columns = [...new Set(EXAMPLE.nodes.map(node => node.column))].sort((a, b) => a - b);
  return <div className="wmt-canvas">
    {columns.map((column, index) => <div key={column} className={`wmt-column${highlight === index ? ' is-lit' : ''}`} style={{ '--wmt-index': index } as CSSProperties}>
      <small>{String(index + 1).padStart(2, '0')}</small>
      {EXAMPLE.nodes.filter(node => node.column === column).map(node => <span key={node.id} className={`wmt-node${states?.[node.id] ? ` is-${states[node.id]}` : ''}`}>
        <b>{node.title[locale]}</b>{labels?.[node.id] && <i>{labels[node.id]}</i>}</span>)}
    </div>)}
  </div>;
}

function Scene({ step, locale, record }: { step: string; locale: UiLocale; record: ProductionRunRecord | null }) {
  const zh = locale === 'zh';
  const durations = record ? Object.fromEntries(record.nodes.filter(node => node.seconds !== undefined).map(node => [node.id, formatDuration(node.seconds!, locale)])) : undefined;
  switch (step) {
    case 'overview': return <div className="wmt-scene wmt-flow">
      {[[zh ? '一句需求' : 'One brief', zh ? '你写下目标' : 'your goal'], [zh ? '一张画布' : 'One canvas', zh ? 'AwwO 编排' : 'AwwO lays it out'], [zh ? '一支团队' : 'One team', zh ? 'Agent 分工协作' : 'agents in stages'], [zh ? '一份交付' : 'One delivery', zh ? '可预览、可下载' : 'ready to review']]
        .map(([title, detail], index) => <span key={title} style={{ '--wmt-index': index } as CSSProperties}><b>{title}</b><small>{detail}</small></span>)}
    </div>;
    case 'plan': return <div className="wmt-scene wmt-plan">
      <p className="wmt-prompt"><span>{EXAMPLE.brief[locale].slice(0, zh ? 34 : 96)}…</span><b>{zh ? '生成画布' : 'Generate canvas'}<ArrowRight size={12} aria-hidden="true" /></b></p>
      <MiniCanvas locale={locale} />
    </div>;
    case 'node': {
      const node = EXAMPLE.nodes.find(value => value.id === 'levels')!;
      return <div className="wmt-scene wmt-anatomy">
        <span className="wmt-port is-in">{zh ? '输入' : 'Input'}<b>{nodeTitle('design', locale)}</b></span>
        <article><header><b>{node.title[locale]}</b><small>{zh ? `数据 · ${record ? `模型 ${record.model}` : '模型由工作区选择'}` : `Data · ${record ? `model ${record.model}` : 'model chosen by the workspace'}`}</small></header>
          <p>{node.task[locale].slice(0, zh ? 58 : 150)}…</p><p className="wmt-check"><Check size={11} aria-hidden="true" />{node.acceptance[0][locale]}</p></article>
        <span className="wmt-port is-out">{zh ? '输出' : 'Output'}<b>{node.output[locale]}</b></span>
      </div>;
    }
    case 'handoff': return <div className="wmt-scene wmt-handoff">
      <div className="wmt-inputs">{['design', 'art', 'levels', 'sound'].map((id, index) => <span key={id} style={{ '--wmt-index': index } as CSSProperties}><Check size={11} aria-hidden="true" />{nodeTitle(id, locale)}</span>)}</div>
      <div className="wmt-wire"><i /><em>{zh ? '真实产出' : 'real output'}</em></div>
      <span className="wmt-node is-target"><b>{nodeTitle('build', locale)}</b><i>{zh ? '4 路输入到齐 → 开始' : '4 of 4 inputs in → starts'}</i></span>
    </div>;
    case 'stages': return <div className="wmt-scene wmt-stages"><MiniCanvas locale={locale} highlight={1} labels={durations} />
      <p className="wmt-caption">{zh ? '第 2 阶段：美术、关卡、音效互不依赖，可以并行' : 'Stage 2: art, levels and sound depend on nothing but design, so they can run in parallel'}</p></div>;
    case 'run': return <div className="wmt-scene wmt-run">
      <p className="wmt-run-bar"><span><Play size={11} aria-hidden="true" />{zh ? '运行图' : 'Run graph'}</span><i>{zh ? '运行中 · 4/6' : 'Running · 4/6'}</i></p>
      <MiniCanvas locale={locale} states={{ design: 'done', art: 'done', levels: 'done', sound: 'done', build: 'running', review: 'waiting' }} />
      <p className="wmt-caption">{zh ? '示意：运行中的画布这样显示每个节点的状态' : 'Illustration: how a running canvas shows each node’s state'}</p>
      <p className="wmt-legend"><span><Check size={11} aria-hidden="true" />{zh ? '完成' : 'Done'}</span><span className="is-running">{zh ? '进行中' : 'Running'}</span>
        <span className="is-failed"><TriangleAlert size={11} aria-hidden="true" />{zh ? '失败' : 'Failed'}</span><span className="is-blocked"><CircleSlash size={11} aria-hidden="true" />{zh ? '被阻断' : 'Blocked'}</span></p>
    </div>;
    default: return <div className="wmt-scene wmt-deliver">
      <article className="wmt-review"><b>{nodeTitle('review', locale)}</b>
        <span className="is-pass"><Check size={11} aria-hidden="true" />{zh ? '确认通过的项' : 'Confirmed'}</span>
        <span className="is-fail"><TriangleAlert size={11} aria-hidden="true" />{zh ? '发现的缺陷' : 'Defects found'}</span>
        <span className="is-open"><CircleSlash size={11} aria-hidden="true" />{zh ? '未验证的项' : 'Not verified'}</span></article>
      <article className="wmt-delivery"><b>{zh ? '交付成品' : 'Delivered'}</b><span>{EXAMPLE.nodes.find(node => node.id === 'build')!.output[locale]}</span>
        <small>{zh ? '在节点交付区预览、下载' : 'Preview and download it in the node’s deliverables'}</small></article>
      <p className="wmt-caption">{zh ? '示意：验收与交付在画布上的样子' : 'Illustration: how review and delivery look on a canvas'}</p>
    </div>;
  }
}

/** A full-screen explainer of the work mode. It never creates, runs or submits anything. */
export default function WorkModeTutorial({ open, mandatory = false, locale, readOnly = false, onClose, onStart }: WorkModeTutorialProps) {
  const [index, setIndex] = useState(0);
  const [unlocked, setUnlocked] = useState(0);
  const [record, setRecord] = useState<ProductionRunRecord | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Set before this component closes the dialog itself; any other close of a mandatory tutorial
  // (a browser's repeated-Escape close watcher, for one) is undone.
  const finishing = useRef(false);
  const id = useId();
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  const zh = locale === 'zh';
  const finish = (completed: boolean) => { finishing.current = true; dialog.current?.close(); onClose(completed); };

  useEffect(() => { let live = true; void loadProductionRun(EXAMPLE.id).then(value => { if (live) setRecord(value ?? null); }, () => {}); return () => { live = false; }; }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    finishing.current = false;
    if (element && !element.open) element.showModal();
    setIndex(0); setUnlocked(0);
    return () => { finishing.current = true; if (element?.open) element.close(); if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true }); };
  }, [open]);
  useLayoutEffect(() => { if (open) heading.current?.focus({ preventScroll: true }); }, [open, index]);
  // Each step unlocks once, after its scene has played; going back never locks it again.
  useEffect(() => {
    if (!open || unlocked > index) return;
    const timer = window.setTimeout(() => setUnlocked(value => Math.max(value, index + 1)), reducedMotion() ? STEP_DWELL_MS / 2 : STEP_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [open, index, unlocked]);
  if (!open) return null;
  const ready = unlocked > index;
  const next = () => { if (!ready) return; if (last) finish(true); else setIndex(index + 1); };
  const source = record ? (zh ? `画布与用时来自「像素平台跳跃」${record.capturedOn} 的真实运行` : `Canvas and timings from the real ${record.capturedOn} run of the pixel platformer case`)
    : (zh ? '画布来自「像素平台跳跃」制作案例' : 'Canvas from the pixel platformer production case');
  let action: ReactNode = null;
  if (last && onStart && !readOnly) action = <button type="button" className="wmt-secondary" disabled={!ready} onClick={() => { if (!ready) return; finish(true); onStart(); }}>{zh ? '去写第一个需求' : 'Write my first brief'}</button>;
  return <dialog ref={dialog} className="work-mode-tutorial" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} data-mandatory={mandatory || undefined}
    onCancel={event => { event.preventDefault(); if (!mandatory) finish(false); }}
    onClose={() => { const element = dialog.current; if (!finishing.current && element?.isConnected && !element.open) { if (mandatory) element.showModal(); else onClose(false); } }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); if (!mandatory) finish(false); } }}>
    <div className="wmt-shell">
      <header className="wmt-header"><span className="wmt-brand">AwwO <span>{zh ? '工作模式' : 'Work mode'}</span></span>
        <span className="wmt-count">{zh ? `第 ${index + 1} / ${STEPS.length} 步` : `Step ${index + 1} of ${STEPS.length}`}</span>
        {!mandatory && <button type="button" className="wmt-close" aria-label={zh ? '关闭讲解' : 'Close the tutorial'} onClick={() => finish(false)}><X size={18} aria-hidden="true" /></button>}</header>
      <div className="wmt-body">
        <div className="wmt-visual" aria-hidden="true" key={step.key}><Scene step={step.key} locale={locale} record={record} /><small className="wmt-source">{source}</small></div>
        <div className="wmt-copy">
          <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{text(step.title, locale)}</h2>
          <p id={`${id}-body`}>{text(readOnly && step.readOnlyBody ? step.readOnlyBody : step.body, locale)}</p>
          {mandatory && index === 0 && <p className="wmt-note">{zh ? '这是新账号的入门讲解，看完全部 7 步就能开始使用；之后可从「更多选项 → AwwO 工作模式」随时重看。' : 'This is the introduction for new accounts: go through all 7 steps to start. You can replay it any time from More options → How AwwO works.'}</p>}
        </div>
      </div>
      <footer className="wmt-footer">
        <ol className="wmt-progress" aria-hidden="true">{STEPS.map((item, position) => <li key={item.key} className={position < index ? 'is-done' : position === index ? 'is-current' : undefined} />)}</ol>
        <div className="wmt-buttons">
          {!mandatory && !last && <button type="button" className="wmt-skip" onClick={() => finish(false)}>{zh ? '跳过' : 'Skip'}</button>}
          {index > 0 && <button type="button" className="wmt-back" aria-label={zh ? '上一步' : 'Previous step'} onClick={() => setIndex(index - 1)}><ArrowLeft size={16} aria-hidden="true" /></button>}
          {action}
          <span className="wmt-sr" role="status">{ready ? (last ? (zh ? '可以开始使用 AwwO' : 'You can start using AwwO') : (zh ? '可以进入下一步' : 'You can go on to the next step')) : ''}</span>
          <button type="button" className="wmt-next" aria-disabled={!ready || undefined} onClick={next}>
            <span className="wmt-dwell" style={{ animationDuration: `${reducedMotion() ? STEP_DWELL_MS / 2 : STEP_DWELL_MS}ms` }} data-ready={ready || undefined} key={`${index}-${ready}`} aria-hidden="true" />
            {last ? (zh ? '开始使用 AwwO' : 'Start using AwwO') : (zh ? '下一步' : 'Next')}{last ? <Check size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
          </button>
        </div>
      </footer>
    </div>
  </dialog>;
}

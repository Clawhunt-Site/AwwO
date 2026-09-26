import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Bot, Check, Cpu, ExternalLink, Layers3, Sparkles, X } from 'lucide-react';
import { safeMainSiteURL } from './mainSite';
import './first-run-tour.css';

export type FirstRunScene = 'workspace' | 'canvas' | 'engines';
export type FirstRunAction = 'engines' | 'create-canvas' | 'provider-key';
export type FirstRunTourProps = {
  open: boolean;
  scene: FirstRunScene;
  locale: 'zh' | 'en';
  mainSiteURL?: string;
  readOnly?: boolean;
  personalEngines?: boolean;
  onClose: (completed: boolean) => void;
  /** Navigation or focus only: the host must never submit a form or run a task here. */
  onAction?: (action: FirstRunAction) => void;
};
type Copy = readonly [string, string];
type Step = { key: string; title: Copy; instruction: Copy; hint?: Copy; targets: string[]; mobileTargets?: string[]; diagram?: boolean; action?: FirstRunAction; actionLabel?: Copy; siteLink?: boolean };
type Rect = { x: number; y: number; width: number; height: number };
type Layout = { spotlight: Rect | null; card: CSSProperties; width: number; height: number };
const target = (name: string) => `[data-onboarding="${name}"]`;
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

function stepsFor(scene: FirstRunScene, readOnly: boolean, personalEngines: boolean): Step[] {
  if (scene === 'engines') return [
    { key: 'provider', title: ['选好模型服务', 'Choose a model provider'], instruction: ['在「模型服务」中选择服务商，再选择执行引擎；不确定时保留默认引擎。', 'Choose your model provider and an execution engine; keep the default engine if you are unsure.'], targets: ['engine-setup'] },
    { key: 'key', title: ['填入你自己的 API Key', 'Add your own API key'], instruction: ['把所选服务商的 API Key 填入密钥框，再点击「验证并保存」。', 'Paste the selected provider’s API key into the key field, then choose “Verify and save”.'], hint: ['这里填写模型凭证，不是 AwwO 登录密码。', 'Use a model credential here, not your AwwO password.'], targets: ['provider-key', 'engine-setup'], action: 'provider-key', actionLabel: ['去填写 API Key', 'Enter my API key'] },
    { key: 'verified', title: ['验证后就能选择模型', 'Verify, then choose your models'], instruction: ['验证成功后返回工作区；如果需要我们的模型服务，先通过 LLM Gate 获取凭证。', 'After verification, return to your workspace; use LLM Gate to get a credential for our model service.'], hint: ['只有你主动运行任务时，才会使用你的模型连接。', 'Your model connection is used when you choose to run a task.'], targets: ['provider-verify', 'gate-purchase', 'engine-setup'] },
  ];
  if (scene === 'canvas') return [
    { key: 'models', title: readOnly ? ['查看节点的模型信息', 'Review node model information'] : ['模型在左侧', 'Models live on the left'], instruction: readOnly ? ['查看画布中各节点使用的模型；编辑和运行需要工作区成员权限。', 'Review each node’s model; editing and execution require workspace member access.'] : ['打开左侧模型栏，点击或拖动一个可用模型，把它加入画布。', 'Open the model rail on the left, then click or drag an available model onto the canvas.'], hint: readOnly ? ['浏览节点与历史不需要连接个人模型凭证。', 'Browsing nodes and history does not require a personal model credential.'] : personalEngines ? ['模型未就绪时，可从「我的引擎」检查个人连接。', 'If models are unavailable, check your personal connections in “My engines”.'] : ['模型由工作区提供；未就绪时请联系工作区管理员。', 'Models are provided by your workspace; contact its administrator if they are unavailable.'], targets: readOnly ? ['canvas-stage'] : ['models', 'canvas-stage'], mobileTargets: readOnly ? ['canvas-stage'] : ['models-toggle', 'canvas-stage'] },
    { key: 'bots', title: readOnly ? ['定位画布中的 Bot', 'Locate a Bot on the canvas'] : ['Bot 在右侧', 'Bots live on the right'], instruction: readOnly ? ['打开画布导航，选择一个 Bot 来定位并查看它的内容。', 'Open canvas navigation and select a Bot to locate and inspect it.'] : ['在右侧选用工作区或产品 Bot，也可以先选人设，再从左侧添加模型。', 'Choose a workspace or product Bot on the right, or choose a persona before adding a model from the left.'], targets: ['bots', 'canvas-stage'], mobileTargets: ['bots-toggle', 'canvas-stage'] },
    { key: 'task', title: readOnly ? ['打开节点查看内容', 'Open a node to inspect it'] : ['给节点一个明确任务', 'Give the node a clear task'], instruction: readOnly ? ['打开画布中的节点，查看它的任务、会话和已保存的产物。', 'Open a canvas node to review its task, conversation and saved deliverables.'] : ['打开画布中的节点，写清要做什么、需要什么结果，再检查输入。', 'Open a canvas node, describe the task and expected result, then review its inputs.'], targets: ['node-task', 'canvas-stage'] },
    { key: 'run', title: readOnly ? ['查看运行与产物', 'Review runs and deliverables'] : ['运行，然后检查结果', 'Run, then review the result'], instruction: readOnly ? ['打开「后台运行与协作记录」查看进度，再从节点的产物区域核对结果。', 'Open “Background runs & collaboration” to check progress, then review the node’s deliverables.'] : ['准备好后主动点击「运行图」，再从节点产物和运行记录中检查结果。', 'When ready, choose “Run graph”, then review the node’s deliverables and run history.'], hint: readOnly ? ['只读权限允许浏览和导出，不会发起模型调用。', 'Read-only access allows browsing and export without starting model calls.'] : ['引导不会替你运行任务；未连接引擎时仍可编辑画布。', 'This tour never runs tasks for you. You can edit the canvas before connecting an engine.'], targets: readOnly ? ['run-history', 'canvas-stage'] : ['run-controls', 'canvas-stage'] },
  ];
  return [
    { key: 'welcome', title: ['欢迎来到 AwwO', 'Welcome to AwwO'], instruction: readOnly ? ['先打开一张画布，了解模型、任务与 Bot 如何在同一处协作。', 'Open a canvas to see how models, tasks and Bots work together.'] : personalEngines ? ['先连接模型，再建立画布，让你的 Bot 围绕同一个任务协作。', 'Connect a model, create a canvas, and bring your Bots together around one task.'] : ['先建立画布，再选择工作区提供的模型，让 Bot 围绕同一个任务协作。', 'Create a canvas, choose a workspace model, and bring your Bots together around one task.'], targets: [], diagram: true },
    { key: 'engines', title: readOnly ? ['了解执行权限', 'Understand execution access'] : personalEngines ? ['先准备执行引擎', 'Prepare your execution engine'] : ['使用工作区的执行引擎', 'Use your workspace engine'], instruction: readOnly ? ['你当前可以浏览工作区；如果需要编辑或运行任务，请联系工作区管理员。', 'You can browse this workspace; contact its administrator if you need to edit or run tasks.'] : !personalEngines ? ['工作区已经提供模型服务；进入画布后，从左侧选择可用模型即可。', 'Your workspace provides model access; open a canvas and choose an available model on the left.'] : ['打开「我的引擎」填写个人 API Key；使用我们的模型时，先去 LLM Gate 获取凭证。', 'Open “My engines” to add your API key; get a credential from LLM Gate to use our model service.'], targets: readOnly ? ['workspace-actions'] : ['engine-link', 'workspace-actions'], ...(!readOnly && personalEngines ? { action: 'engines' as const, actionLabel: ['去连接引擎', 'Connect my engine'] as Copy } : {}) },
    { key: 'canvas', title: readOnly ? ['打开团队画布', 'Open your team’s canvas'] : ['给任务建一张画布', 'Create a canvas for your task'], instruction: readOnly ? ['在列表中打开已有画布，查看 Bot、会话和运行结果。', 'Open an existing canvas from the list to review Bots, conversations and results.'] : ['输入任务名称并点击「新建画布」，也可以打开已有画布继续工作。', 'Name your task and choose “Create canvas”, or open an existing canvas to continue.'], targets: readOnly ? ['canvas-list'] : ['canvas-create', 'canvas-list'], ...(!readOnly ? { action: 'create-canvas' as const, actionLabel: ['去创建画布', 'Create my canvas'] as Copy } : {}) },
    { key: 'site', title: ['与 ClawHunt 主站相连', 'Connected with ClawHunt'], instruction: ['通过主站入口发现更多产品与 Bot，回到 AwwO 后继续你的画布任务。', 'Use the main site to discover more products and Bots, then return to AwwO to continue your canvas task.'], hint: ['主站如提示登录，请按提示登录；你可随时从「使用引导」重看这些步骤。', 'Sign in on the main site if prompted. You can replay these steps anytime from “Getting started”.'], targets: ['main-site', 'workspace-actions'], siteLink: true },
  ];
}

function findSpotlight(names: string[], width: number, height: number): Rect | null {
  for (const name of names) {
    for (const element of document.querySelectorAll<HTMLElement>(target(name))) {
      if (element.closest('[hidden], [aria-hidden="true"]')) continue;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= height || rect.left >= width) continue;
      const x = Math.max(8, rect.left - 6); const y = Math.max(8, rect.top - 6);
      const right = Math.min(width - 8, rect.right + 6); const bottom = Math.min(height - 8, rect.bottom + 6);
      if (right > x && bottom > y) return { x, y, width: right - x, height: bottom - y };
    }
  }
  return null;
}

/** A presentation-only guide. Native modal inertness prevents clicks reaching highlighted controls. */
export function FirstRunTour({ open, scene, locale, mainSiteURL, readOnly = false, personalEngines = true, onClose, onAction }: FirstRunTourProps) {
  const [requestedIndex, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const closeCallback = useRef(onClose); closeCallback.current = onClose;
  const [layout, setLayout] = useState<Layout>(() => ({ spotlight: null, card: {}, ...viewport() }));
  const id = useId();
  const siteURL = safeMainSiteURL(mainSiteURL);
  const steps = stepsFor(scene, readOnly, personalEngines).filter(step => !step.siteLink || Boolean(siteURL));
  const index = Math.min(requestedIndex, steps.length - 1);
  const step = steps[index];
  const zh = locale === 'zh';
  const text = (copy: Copy) => copy[zh ? 0 : 1];
  const finish = (completed: boolean) => { dialog.current?.close(); closeCallback.current(completed); };

  useLayoutEffect(() => { if (open) setIndex(0); }, [open, scene]);
  useLayoutEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (element?.open) element.close();
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const measure = () => {
      const { width, height } = viewport();
      const names = width <= 900 && step.mobileTargets ? [...step.mobileTargets, ...step.targets] : step.targets;
      const spotlight = findSpotlight(names, width, height);
      const cardWidth = Math.min(390, width - 24);
      const cardHeight = Math.min(card.current?.getBoundingClientRect().height || 380, height - 24);
      const clampX = (x: number) => Math.max(12, Math.min(x, width - cardWidth - 12));
      const clampY = (y: number) => Math.max(12, Math.min(y, height - cardHeight - 12));
      let left = (width - cardWidth) / 2; let top = (height - cardHeight) / 2;
      if (width <= 600) top = height - cardHeight - 12;
      else if (spotlight) {
        if (width - (spotlight.x + spotlight.width) >= cardWidth + 28) { left = spotlight.x + spotlight.width + 16; top = spotlight.y; }
        else if (spotlight.x >= cardWidth + 28) { left = spotlight.x - cardWidth - 16; top = spotlight.y; }
        else if (height - (spotlight.y + spotlight.height) >= cardHeight + 28) { left = spotlight.x; top = spotlight.y + spotlight.height + 16; }
        else if (spotlight.y >= cardHeight + 28) { left = spotlight.x; top = spotlight.y - cardHeight - 16; }
      }
      setLayout({ spotlight, width, height, card: { width: cardWidth, left: clampX(left), top: clampY(top) } });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    heading.current?.focus({ preventScroll: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (card.current) resize?.observe(card.current);
    const observer = new MutationObserver(records => { if (records.some(record => !dialog.current?.contains(record.target))) schedule(); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden'] });
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); resize?.disconnect(); observer.disconnect(); };
  }, [open, index, scene, locale, readOnly, personalEngines, siteURL]);

  if (!open) return null;
  const spotlight = layout.spotlight;
  return createPortal(<dialog ref={dialog} className="first-run-tour" aria-labelledby={`${id}-title`} aria-describedby={`${id}-instruction`}
    onCancel={event => { event.preventDefault(); finish(false); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); finish(false); } }}>
    <svg className="first-run-tour-scrim" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><mask id={`${id}-mask`}><rect width="100%" height="100%" fill="white" />{spotlight && <rect {...spotlight} rx="14" fill="black" />}</mask></defs>
      <rect width="100%" height="100%" className="first-run-tour-shade" mask={`url(#${id}-mask)`} />
      {spotlight && <rect {...spotlight} rx="14" className="first-run-tour-highlight" />}
    </svg>
    <section ref={card} className="first-run-tour-card" style={layout.card} data-spotlight={spotlight ? 'visible' : 'missing'}>
      <header className="first-run-tour-header"><span className="first-run-tour-brand"><Sparkles size={15} aria-hidden="true" />AwwO <span>{zh ? '使用引导' : 'Getting started'}</span></span><button className="first-run-tour-close" type="button" aria-label={zh ? '关闭引导' : 'Close tour'} onClick={() => finish(false)}><X size={18} /></button></header>
      <div className="first-run-tour-content">
        <span className="first-run-tour-count">{zh ? `第 ${index + 1} / ${steps.length} 步` : `Step ${index + 1} of ${steps.length}`}</span>
        <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{text(step.title)}</h2>
        <p id={`${id}-instruction`}>{text(step.instruction)}</p>
        {step.diagram && <div className="first-run-tour-map" aria-label={readOnly ? (zh ? '模型、画布任务与 Bot' : 'Models, canvas tasks and Bots') : (zh ? '左侧模型，中间任务画布，右侧 Bot' : 'Models on the left, task canvas in the center, Bots on the right')}>
          <div><Cpu size={22} /><strong>{zh ? '模型' : 'Models'}</strong><small>{readOnly ? (zh ? '模型信息' : 'DETAILS') : (zh ? '左侧' : 'LEFT')}</small></div><ArrowRight size={14} aria-hidden="true" /><div className="is-center"><Layers3 size={23} /><strong>{zh ? '任务画布' : 'Canvas'}</strong><small>{zh ? '协作与交付' : 'WORK TOGETHER'}</small></div><ArrowLeft size={14} aria-hidden="true" /><div><Bot size={22} /><strong>Bot</strong><small>{readOnly ? (zh ? '协作者' : 'TEAM') : (zh ? '右侧' : 'RIGHT')}</small></div>
        </div>}
        {step.hint && <p className="first-run-tour-hint">{text(step.hint)}</p>}
        {step.action && step.actionLabel && onAction && <button type="button" className="first-run-tour-action" onClick={() => { finish(false); onAction(step.action!); }}>{text(step.actionLabel)}<ArrowRight size={15} /></button>}
        {step.siteLink && siteURL && <a className="first-run-tour-action" href={siteURL} target="_blank" rel="noopener noreferrer">{zh ? '打开 ClawHunt 主站' : 'Open ClawHunt'}<ExternalLink size={14} /></a>}
      </div>
      <footer className="first-run-tour-footer"><div className="first-run-tour-progress" aria-hidden="true">{steps.map((item, position) => <span key={item.key} className={position <= index ? 'is-reached' : undefined} />)}</div><div className="first-run-tour-buttons"><button className="first-run-tour-skip" type="button" onClick={() => finish(false)}>{zh ? '暂时跳过' : 'Skip for now'}</button><div>{index > 0 && <button className="first-run-tour-back" type="button" aria-label={zh ? '上一步' : 'Previous step'} onClick={() => setIndex(Math.max(0, index - 1))}><ArrowLeft size={16} /></button>}<button className="first-run-tour-next" type="button" onClick={() => index === steps.length - 1 ? finish(true) : setIndex(index + 1)}>{index === steps.length - 1 ? (zh ? '知道了' : 'Got it') : (zh ? '下一步' : 'Next')}{index === steps.length - 1 ? <Check size={15} /> : <ArrowRight size={15} />}</button></div></div></footer>
    </section>
  </dialog>, document.body);
}

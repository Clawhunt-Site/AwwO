// The signed-out homepage around the sign-in card (SaaSApp Login): the welcome's canvas preview, how AwwO works and what
// it holds to, between the welcome and the production cases, and the page's footer. Styled in design/system.css
// (Sign-in), on the dark tank and the salt paper below it.
import type { ReactNode } from 'react';
import { Boxes, CircleCheck, ExternalLink, History, KeyRound, PenLine, Play, Users } from 'lucide-react';
import { useSaaSPreferences } from './preferences';

type Line = readonly [zh: string, en: string];
type Status = 'done' | 'running' | 'waiting';

/** A Chinese heading as its phrases, each kept whole on a line where it fits (design/system.css .saas-phrase); a
 *  phone otherwise broke 「工作」 across two lines. English wraps at its spaces. */
function Heading({ id, zh, en }: { id: string; zh: readonly string[]; en: string }) {
  const { locale } = useSaaSPreferences();
  // No space between them: a line may break between two inline blocks, and 「，」 takes no space after it.
  return <h2 id={id}>{locale === 'zh' ? zh.map(phrase => <span key={phrase} className="saas-phrase">{phrase}</span>) : en}</h2>;
}

/** The preview's canvas: a team of four, the review waiting on both builders. Laid out on a 100 × 196 grid (x in
 *  percent of the width, y in pixels), which the edges' SVG shares. */
const PREVIEW_NODES: ReadonlyArray<{ id: string; title: Line; status: Status; x: number; y: number }> = [
  { id: 'plan', title: ['规划', 'Plan'], status: 'done', x: 3, y: 69 },
  { id: 'page', title: ['页面', 'Page'], status: 'running', x: 37, y: 14 },
  { id: 'api', title: ['接口', 'API'], status: 'done', x: 37, y: 124 },
  { id: 'review', title: ['审核', 'Review'], status: 'waiting', x: 71, y: 69 },
];
const STATUS: Record<Status, Line> = { done: ['已完成', 'Done'], running: ['运行中', 'Running'], waiting: ['等待上游', 'Waiting'] };
/** A node is 26 wide and 58 tall: an edge leaves a node's right side at its middle and enters the next one's left. */
const PREVIEW_EDGES = [['plan', 'page'], ['plan', 'api'], ['page', 'review'], ['api', 'review']] as const;

function edgePath(from: string, to: string): string {
  const a = PREVIEW_NODES.find(node => node.id === from)!;
  const b = PREVIEW_NODES.find(node => node.id === to)!;
  const [x1, y1, x2, y2] = [a.x + 26, a.y + 29, b.x, b.y + 29];
  const bend = (x2 - x1) / 2;
  return `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
}

/** Decorative: what a workspace canvas looks like at work, before the visitor has one; the list says it in words. */
export function LandingPreview() {
  const { t } = useSaaSPreferences();
  return <div className="saas-login-preview">
    <div className="saas-landing-canvas" aria-hidden="true">
      <svg className="saas-landing-edges" viewBox="0 0 100 196" preserveAspectRatio="none">
        {PREVIEW_EDGES.map(([from, to]) => <path key={from + to} d={edgePath(from, to)} className={to === 'page' ? 'is-live' : undefined} vectorEffect="non-scaling-stroke" />)}
      </svg>
      {PREVIEW_NODES.map(node => <div key={node.id} className={`saas-landing-node is-${node.status}`} style={{ left: `${node.x}%`, top: node.y }}>
        <strong>{t(...node.title)}</strong><span>{t(...STATUS[node.status])}</span>
      </div>)}
    </div>
    <ul role="list">
      <li>{t('多个 Agent 节点按依赖顺序协作', 'Agent nodes run in dependency order')}</li>
      <li>{t('每个节点保留独立会话与交付物', 'Every node keeps its own session and output')}</li>
      <li>{t('使用你自己的模型服务与密钥', 'Bring your own model service and key')}</li>
    </ul>
  </div>;
}

/** The third step says where a canvas run goes on: on the hosted site it is the API's and goes on with the page closed
 *  (`hosted`); AwwO Local's goes on only while AwwO Local runs, so closing its window (`window`, in the Windows and Mac
 *  apps) or stopping it (`local`, npm run local) stops it. Before the API has said which, neither is said. */
const STEPS: ReadonlyArray<{ icon: ReactNode; title: Line; text: Line; hosted?: Line; window?: Line; local?: Line }> = [
  { icon: <PenLine size={18} aria-hidden="true" />, title: ['写下目标', 'Write down the goal'],
    text: ['一句话说清要交付什么：一个网站、一份周报、一段影片。画布助手据此规划节点和分工。',
      'Say in a sentence what you want delivered: a website, a weekly report, a film. The canvas assistant plans the nodes and who does what.'] },
  { icon: <Users size={18} aria-hidden="true" />, title: ['确认分工', 'Agree on the team'],
    text: ['每个节点是一位 Agent，有自己的职责、模型和要交付的东西。开始之前，哪一个都可以改。',
      'Each node is an agent with its own role, model and deliverable. Change any of them before you start.'] },
  { icon: <Play size={18} aria-hidden="true" />, title: ['运行与交付', 'Run and deliver'],
    text: ['节点按依赖顺序运行，上游的成果交给下游。交付的东西和经过的每一步都在「成果」里。',
      'Nodes run in dependency order, each handing its work downstream. What was delivered, and every step on the way, is in Results.'],
    hosted: ['节点按依赖顺序运行，上游的成果交给下游，关掉页面也会继续。交付的东西和经过的每一步都在「成果」里。',
      'Nodes run in dependency order, each handing its work downstream, and keep going when you close the page. What was delivered, and every step on the way, is in Results.'],
    window: ['节点按依赖顺序运行，上游的成果交给下游；AwwO 本地版开着时才运行，关闭它的窗口或退出都会停止运行。交付的东西和经过的每一步都在「成果」里。',
      'Nodes run in dependency order, each handing its work downstream, while AwwO Local is open: closing its window or quitting it stops them. What was delivered, and every step on the way, is in Results.'],
    local: ['节点按依赖顺序运行，上游的成果交给下游；AwwO 本地版运行时才运行，停止它就会停止运行。交付的东西和经过的每一步都在「成果」里。',
      'Nodes run in dependency order, each handing its work downstream, while AwwO Local is running: stopping it stops them. What was delivered, and every step on the way, is in Results.'] },
];
/** What the product holds to, on the hosted site and in AwwO Local alike, each worded as an AwwO law says it
 *  (docs/laws/awwo-laws.md: 001, 004, 009 and 017; each law lists what checks it). */
const PROMISES: ReadonlyArray<{ law: string; icon: ReactNode; title: Line; text: Line }> = [
  { law: 'AWWO-LAW-001', icon: <Boxes size={18} aria-hidden="true" />, title: ['工作区各自独立', 'Workspaces stay apart'],
    text: ['每个工作区的画布、会话和成员只属于它自己；别的工作区连它们是否存在都看不到。',
      'A workspace’s canvases, conversations and members are its own; another workspace cannot even tell they exist.'] },
  { law: 'AWWO-LAW-004', icon: <CircleCheck size={18} aria-hidden="true" />, title: ['完成就是真的完成', 'Done means done'],
    text: ['只有模型真的给出答案并保存下来，运行才算完成；中断、超时和失败都会如实标出。',
      'A run is complete only once the model’s answer is stored; an interruption, a timeout or a failure is shown as what it is.'] },
  { law: 'AWWO-LAW-009', icon: <History size={18} aria-hidden="true" />, title: ['改动不会被覆盖', 'Edits are never overwritten'],
    text: ['两个页面同时改同一张画布时，基于旧版本的保存会被拒绝，你的改动留作草稿，可以恢复或导出。',
      'When two pages edit one canvas, a save made on an out-of-date copy is refused and your edit is kept as a draft you can restore or export.'] },
  { law: 'AWWO-LAW-017', icon: <KeyRound size={18} aria-hidden="true" />, title: ['保存的密钥不会回到浏览器', 'Saved keys never come back to the browser'],
    text: ['模型服务的密钥保存之后，回应、事件和页面都不会再把它带回浏览器。',
      'Once a model provider key is saved, no response, event or page sends it back to the browser.'] },
];

/** How AwwO works, in three steps, and what it holds to: between the welcome and the cases. `where`: where a canvas run
 *  goes on, from the API's /auth/options (STEPS), or null until it has said. */
export function LandingStory({ where }: { where: 'hosted' | 'window' | 'local' | null }) {
  const { t } = useSaaSPreferences();
  return <div className="saas-landing">
    <section className="saas-landing-section" aria-labelledby="saas-landing-steps-title">
      <header className="saas-landing-heading">
        <span className="production-eyebrow"><span aria-hidden="true" />{t('怎么用', 'How it works')}</span>
        <Heading id="saas-landing-steps-title" zh={['从一句话到交付，', '三步。']} en="From one sentence to a delivery, in three steps." />
        {/* The home prompt plans a canvas (on a canvas, the assistant may start a request as a task at once). */}
        <p>{t('不用搭流程，也不用写提示词模板：在工作区首页说清要什么，画布助手把它拆给一支 Agent 团队，分工写在画布上，运行之前都可以改。',
          'No workflow to wire and no prompt templates: say what you want on the workspace home, and the canvas assistant splits it across a team of agents, laid out on the canvas, where you can change any of it before it runs.')}</p>
      </header>
      {/* role="list": Safari drops the list from a list without its markers. */}
      <ol className="saas-landing-steps" role="list">
        {STEPS.map((step, index) => <li key={step.title[1]}>
          <span className="saas-landing-step-head"><span className="saas-landing-step-number" aria-hidden="true">{index + 1}</span><span className="saas-landing-icon">{step.icon}</span></span>
          <h3>{t(...step.title)}</h3><p>{t(...((where && step[where]) || step.text))}</p>
        </li>)}
      </ol>
    </section>
    <section className="saas-landing-section" aria-labelledby="saas-landing-promises-title">
      <header className="saas-landing-heading">
        <span className="production-eyebrow"><span aria-hidden="true" />{t('放心交给它', 'Built to be trusted')}</span>
        <Heading id="saas-landing-promises-title" zh={['交给 AwwO 的工作，', '它这样守着。']} en="What AwwO holds to with your work." />
      </header>
      <ul className="saas-landing-promises" role="list">
        {PROMISES.map(item => <li key={item.law} data-law={item.law}><span className="saas-landing-icon">{item.icon}</span><h3>{t(...item.title)}</h3><p>{t(...item.text)}</p></li>)}
      </ul>
    </section>
  </div>;
}

/** The site this AwwO belongs to, when the API names one over https (the hosted site's ClawHunt). */
function mainSite(url: string | undefined): string {
  return url && /^https:\/\/[^/?#\s@]+/.test(url) ? url.replace(/\/+$/, '') : '';
}

/** The page's end: the brand, who makes it, the main site and its privacy policy (where the API names the site), and
 *  the license texts of the code the page runs (`licenses`, SaaSApp's link). */
export function LandingFooter({ siteURL, licenses }: { siteURL?: string; licenses: ReactNode }) {
  const { t } = useSaaSPreferences();
  const site = mainSite(siteURL);
  return <footer className="saas-login-footer">
    <div className="saas-landing-footer-brand"><span className="saas-logo">AwwO</span><p>{t('ClawHunt 孵化出品。让 Agent 在同一张画布上协作。', 'Incubated by ClawHunt. Your agents, together on one canvas.')}</p></div>
    <nav aria-label={t('站点链接', 'Site links')}>
      {site && <a href={site} target="_blank" rel="noopener noreferrer">{t('ClawHunt 主站', 'ClawHunt')}<ExternalLink size={13} aria-hidden="true" /></a>}
      {site && <a href={`${site}/legal`} target="_blank" rel="noopener noreferrer">{t('隐私政策', 'Privacy policy')}<ExternalLink size={13} aria-hidden="true" /></a>}
      {licenses}
    </nav>
    <small>© {new Date().getFullYear()} ClawHunt Store</small>
  </footer>;
}

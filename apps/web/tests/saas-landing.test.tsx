import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';

// The signed-out homepage went from the welcome straight to 31 cases and ended on one licences link (2026-11-05): it
// did not say how AwwO works or what it holds to, and the welcome's canvas was four grey boxes. These pin what replaced
// that; Chrome measured the layout (see the commit).
const web = (path: string) => resolve(process.cwd(), path);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function signedOut(options: Record<string, unknown>, locale: 'zh' | 'en' = 'zh') {
  localStorage.setItem('superclaw_locale', locale);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/options') ? response(options)
    : response({ error: { code: 'unauthenticated', message: 'Login required' } }, 401)));
  render(<SaaSApp />);
}
const hosted = { clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.store' };
const CASES = 'One brief, handed to a team of agents.';
const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it.each([
  ['zh', '从一句话到交付，三步。', ['写下目标', '确认分工', '运行与交付'], '交给 AwwO 的工作，它这样守着。', ['工作区各自独立', '完成就是真的完成', '改动不会被覆盖', '保存的密钥不会回到浏览器']],
  ['en', 'From one sentence to a delivery, in three steps.', ['Write down the goal', 'Agree on the team', 'Run and deliver'], 'What AwwO holds to with your work.',
    ['Workspaces stay apart', 'Done means done', 'Edits are never overwritten', 'Saved keys never come back to the browser']],
] as const)('says how AwwO works and what it holds to between the welcome and the cases (%s)', async (locale, stepsTitle, steps, promisesTitle, promises) => {
  signedOut(hosted, locale);
  const cases = await screen.findByRole('heading', { level: 2, name: CASES });
  const welcome = screen.getByRole('heading', { level: 1 });
  const how = screen.getByRole('heading', { level: 2, name: stepsTitle });
  const trust = screen.getByRole('heading', { level: 2, name: promisesTitle });
  expect(follows(welcome, how) && follows(how, trust) && follows(trust, cases)).toBe(true);
  // Three numbered steps, in order, and four promises, each a heading with its sentence.
  const stepList = within(how.closest('section')!).getByRole('list');
  expect(stepList.tagName).toBe('OL');
  expect(within(stepList).getAllByRole('heading', { level: 3 }).map(item => item.textContent)).toEqual(steps);
  const promiseList = within(trust.closest('section')!).getByRole('list');
  expect(within(promiseList).getAllByRole('heading', { level: 3 }).map(item => item.textContent)).toEqual(promises);
  for (const item of within(promiseList).getAllByRole('listitem')) expect(item.querySelector('p')!.textContent!.length).toBeGreaterThan(20);
  // Each language reads in its own: no Chinese in the English sections, and the reverse for their headings.
  const story = how.closest('.saas-landing')!;
  if (locale === 'en') expect(story.textContent).not.toMatch(/[一-鿿]/);
  else for (const heading of within(story as HTMLElement).getAllByRole('heading')) expect(heading.textContent).toMatch(/[一-鿿]/);
});

// Each promise names the law it is worded after; this checks that citation: the law is still in force under the heading
// the page was written against. A retired or renamed law fails it; comparing the wording stays the reviewer's.
it('ties each promise to an AwwO law still in force under the same heading', async () => {
  const laws = readFileSync(web('../../docs/laws/awwo-laws.md'), 'utf8');
  const cited = { 'AWWO-LAW-001': 'Another tenant\'s resource answers 404', 'AWWO-LAW-004': 'A run completes only on a real, stored answer',
    'AWWO-LAW-009': 'Canvas saves are compare-and-swap on the version read', 'AWWO-LAW-017': 'Secrets and provider keys never reach the browser' };
  signedOut(hosted);
  const trust = await screen.findByRole('heading', { level: 2, name: '交给 AwwO 的工作，它这样守着。' });
  const promises = within(trust.closest('section')!).getAllByRole('listitem');
  expect(promises.map(item => item.getAttribute('data-law'))).toEqual(Object.keys(cited));
  for (const [id, title] of Object.entries(cited)) {
    const at = laws.indexOf(`### ${id}: ${title}`);
    expect(at, id).toBeGreaterThan(0);
    expect(laws.slice(at, laws.indexOf('\n### ', at + 10)), id).not.toMatch(/Retired:/);
  }
  // LAW-017 is about what reaches the browser back: a person types their own key in it, and a connection key is shown once;
  // where the key is kept (the hosted API, or AwwO Local's own computer) is not the promise.
  expect(promises[3]).toHaveTextContent('模型服务的密钥保存之后，回应、事件和页面都不会再把它带回浏览器。');
  // LAW-009 refuses the save made on the version that is out of date, which is usually the later one.
  expect(promises[2]).toHaveTextContent('基于旧版本的保存会被拒绝');
  cleanup();
  signedOut(hosted, 'en');
  const english = within((await screen.findByRole('heading', { level: 2, name: 'What AwwO holds to with your work.' })).closest('section')!).getAllByRole('listitem');
  expect(english.map(item => item.getAttribute('data-law'))).toEqual(Object.keys(cited));
  expect(english[3]).toHaveTextContent('Once a model provider key is saved, no response, event or page sends it back to the browser.');
  expect(english[3].textContent).not.toMatch(/on the server/);
  expect(english[2]).toHaveTextContent('a save made on an out-of-date copy is refused');
});

// The hosted site's canvas runs are the API's and go on with the page closed; AwwO Local's go on only while it runs:
// the Windows and Mac apps stop it when their window closes (docs/awwo-local-edition.md), npm run local when it is
// stopped. Before the API says which edition this is, none of it is said.
const RUN_WHERE = {
  zh: ['关掉页面也会继续', '关闭它的窗口或退出都会停止运行', '停止它就会停止运行'],
  en: ['keep going when you close the page', 'closing its window or quitting it stops them', 'stopping it stops them'],
};
const STEP = { zh: ['运行与交付', '交付的东西和经过的每一步都在「成果」里。'], en: ['Run and deliver', 'What was delivered, and every step on the way, is in Results.'] };
const EDITIONS = [
  ['the hosted site', { clawhuntSSO: true, localAuth: false }, 0],
  ['AwwO Local in the Mac app', { clawhuntSSO: false, localAuth: true, edition: 'local', shell: 'macos' }, 1],
  ['AwwO Local in the Windows app', { clawhuntSSO: false, localAuth: true, edition: 'local', shell: 'windows' }, 1],
  ['AwwO Local run with npm', { clawhuntSSO: false, localAuth: true, edition: 'local' }, 2],
] as const;
it.each((['zh', 'en'] as const).flatMap(locale => EDITIONS.map(([name, options, said]) => [locale, name, options, said] as const)))(
  'says where a run goes on (%s, %s)', async (locale, _, options, said) => {
    signedOut(options, locale);
    const step = (await screen.findByRole('heading', { level: 3, name: STEP[locale][0] })).closest('li')!;
    RUN_WHERE[locale].forEach((words, index) => expect(step.textContent!.includes(words), words).toBe(index === said));
    expect(step).toHaveTextContent(STEP[locale][1]);
  });

it.each(['zh', 'en'] as const)('says nothing of where a run goes on before the API has said which edition this is (%s)', async locale => {
  localStorage.setItem('superclaw_locale', locale);
  // Signed out, with the sign-in methods (and so the edition) still loading.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/options') ? new Promise<Response>(() => {})
    : response({ error: { code: 'unauthenticated', message: 'Login required' } }, 401)));
  render(<SaaSApp />);
  const step = (await screen.findByRole('heading', { level: 3, name: STEP[locale][0] })).closest('li')!;
  for (const words of RUN_WHERE[locale]) expect(step.textContent).not.toContain(words);
});

it.each([
  ['zh', '从一句话到交付，三步。', '在工作区首页说清要什么，画布助手把它拆给一支 Agent 团队，分工写在画布上，运行之前都可以改。', '确认分工后再开始'],
  ['en', 'From one sentence to a delivery, in three steps.', 'say what you want on the workspace home, and the canvas assistant splits it across a team of agents, laid out on the canvas, where you can change any of it before it runs.', 'once you agree'],
] as const)('says the home prompt’s team can be changed before it runs, not that every request waits (%s)', async (locale, heading, said, gone) => {
  signedOut(hosted, locale);
  const intro = (await screen.findByRole('heading', { level: 2, name: heading })).closest('header')!.querySelector('p')!;
  expect(intro).toHaveTextContent(said);
  // The canvas assistant starts some requests as tasks at once (CanvasSurface routes them to the execution host).
  expect(intro.textContent).not.toContain(gone);
});

it('keeps the steps and promises lists for a screen reader, without their markers', async () => {
  signedOut(hosted);
  const how = await screen.findByRole('heading', { level: 2, name: '从一句话到交付，三步。' });
  // The welcome preview's points too: none of these lists draws its markers.
  const lists = document.querySelectorAll('.saas-landing ol, .saas-landing ul, .saas-login-preview ul');
  expect(lists).toHaveLength(3);
  for (const list of lists) expect(list).toHaveAttribute('role', 'list');
  expect(within(how.closest('section')!).getByRole('list').tagName).toBe('OL');
});

it('keeps each phrase of the story’s Chinese headings whole, as the headline’s (tests/saas-login-layout.test.tsx)', async () => {
  signedOut(hosted);
  await screen.findByRole('heading', { level: 1 });
  expect([...screen.getByRole('heading', { level: 2, name: '从一句话到交付，三步。' }).querySelectorAll('.saas-phrase')].map(phrase => phrase.textContent))
    .toEqual(['从一句话到交付，', '三步。']);
  expect([...screen.getByRole('heading', { level: 2, name: '交给 AwwO 的工作，它这样守着。' }).querySelectorAll('.saas-phrase')].map(phrase => phrase.textContent))
    .toEqual(['交给 AwwO 的工作，', '它这样守着。']);
  cleanup();
  signedOut(hosted, 'en');
  expect((await screen.findByRole('heading', { level: 2, name: 'What AwwO holds to with your work.' })).querySelector('.saas-phrase')).toBeNull();
});

it('shows a canvas at work in the welcome, as decoration, with the same points in words', async () => {
  signedOut(hosted);
  await screen.findByRole('heading', { level: 1 });
  const canvas = document.querySelector('.saas-login-brand .saas-landing-canvas')!;
  expect(canvas).toHaveAttribute('aria-hidden', 'true');
  expect([...canvas.querySelectorAll('.saas-landing-node')].map(node => [node.className.replace('saas-landing-node ', ''), node.textContent]))
    .toEqual([['is-done', '规划已完成'], ['is-running', '页面运行中'], ['is-done', '接口已完成'], ['is-waiting', '审核等待上游']]);
  // Four edges, the review waiting on both builders; the one into the running node carries the work.
  const edges = [...canvas.querySelectorAll('svg path')];
  expect(edges).toHaveLength(4);
  expect(edges.filter(edge => edge.classList.contains('is-live'))).toHaveLength(1);
  expect(within(document.querySelector('.saas-login-preview') as HTMLElement).getAllByRole('listitem').map(item => item.textContent))
    .toEqual(['多个 Agent 节点按依赖顺序协作', '每个节点保留独立会话与交付物', '使用你自己的模型服务与密钥']);
  // Moving parts hold still for a reader who asked for less motion, and the picture leaves a column too narrow for it.
  const css = readFileSync(web('src/saas/design/system.css'), 'utf8');
  expect(css).toContain('@media (prefers-reduced-motion: reduce) { .saas-landing-edges path.is-live, .saas-landing-node.is-running { animation: none; } }');
  expect(css).toContain('@media (max-width: 960px) { .saas-landing-canvas { display: none; }');
});

it('ends on a footer: the brand, the main site and its privacy policy, the licences and the copyright', async () => {
  signedOut(hosted);
  const footer = (await screen.findByRole('link', { name: '开源许可' })).closest('footer')!;
  expect(footer).toHaveClass('saas-login-footer');
  const site = within(footer).getByRole('link', { name: 'ClawHunt 主站' });
  expect(site).toHaveAttribute('href', 'https://clawhunt.store');
  const privacy = within(footer).getByRole('link', { name: '隐私政策' });
  // The same address as 设置 → 关于 AwwO's privacy policy (settings/sections.tsx AboutSettings).
  expect(privacy).toHaveAttribute('href', 'https://clawhunt.store/legal');
  for (const link of [site, privacy]) { expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer'); }
  // The copyright holder is the licence's.
  const holder = /Copyright \(c\) \d{4} (.+)/.exec(readFileSync(web('../../LICENSE'), 'utf8'))![1];
  expect(within(footer).getByText(`© ${new Date().getFullYear()} ${holder}`)).toBeVisible();
  // In the muted ink: the subtle one is 4.45:1 on 云白's ground at this size.
  const css = readFileSync(web('src/saas/design/system.css'), 'utf8');
  expect(css).toContain('.saas-login-footer small { grid-column: 1 / -1; color: var(--saas-muted);');
  expect(footer).toHaveTextContent('ClawHunt 孵化出品。');
  expect(follows(screen.getByRole('heading', { level: 2, name: CASES }), footer)).toBe(true);
});

it.each([
  ['no main site', { clawhuntSSO: false, localAuth: true }],
  ['a main site not on https', { clawhuntSSO: false, localAuth: true, clawhuntSiteURL: 'http://clawhunt.test' }],
])('names no main site or privacy policy where the API gives %s, and keeps the licences', async (_, options) => {
  signedOut(options);
  const footer = (await screen.findByRole('link', { name: '开源许可' })).closest('footer')!;
  expect(within(footer).getAllByRole('link').map(link => link.textContent)).toEqual(['开源许可']);
});

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ProductionShowcase from '../src/saas/ProductionShowcase';
import { ProductionCases } from '../src/saas/ProductionCases';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { showcasePage } from '../src/saas/examples/showcaseDocument';

// The site serves a media case's files beside its footage (showcase/media/); the dialog fetches them when it opens.
const WEB = path.resolve(__dirname, '..');
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith('/showcase/')) return new Response('not found', { status: 404 });
    return new Response(readFileSync(path.join(WEB, ...url.split('/').filter(Boolean))), { status: 200 });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('puts each named file in place, after ./ or / too, and leaves a page without files as it is', () => {
  const page = '<img src="n1/image-1.jpg"><img src="./n1/image-1.jpg"><script>clip.src = "/n2/video-1.mp4";</script><p>n3/model-1.glb</p>';
  expect(showcasePage(page, { 'n1/image-1.jpg': 'data:image/jpeg;base64,AA==', 'n2/video-1.mp4': 'data:video/mp4;base64,BB==' })).toBe(
    '<img src="data:image/jpeg;base64,AA=="><img src="data:image/jpeg;base64,AA=="><script>clip.src = "data:video/mp4;base64,BB==";</script><p>n3/model-1.glb</p>');
  expect(showcasePage(page, {})).toBe(page);
});

// The run view reads in English in both interface languages, as the cases do; these tests run in the Chinese interface.
it.each(['neon-city', 'shanhai-vn', 'aurora-gt'])('runs %s with the pictures and the clip its media nodes made, inlined in place of their paths', async id => {
  const item = PRODUCTION_CASES.find(value => value.id === id)!, media = PRODUCTION_WORKFLOWS[id].media!;
  render(<SaaSPreferencesProvider><ProductionShowcase item={item} /></SaaSPreferencesProvider>);
  const frame = await screen.findByTitle(`${item.title}: the result an AwwO run delivered`, undefined, { timeout: 20000 });
  const source = frame.getAttribute('srcdoc')!;
  // The homepage has no canvas files: every path the page names became its file's data: URL, and the clip is kept.
  expect(source).toContain("media-src data: blob: https:");
  expect(source).toMatch(/<video[^>]*src="data:video\/mp4;base64,/);
  expect(source).toContain('data:image/jpeg;base64,');
  for (const value of media) expect(source, value.id).not.toMatch(new RegExp(`\\b${value.id}/(image|video)-\\d+\\.`));
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads');
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  // The media nodes are shown beside the agents, not counted as agents.
  const strip = screen.getByRole('region', { name: 'What the media nodes generated in this run' });
  expect(within(strip).getAllByRole('listitem')).toHaveLength(media.length);
  for (const value of media) expect(within(strip).getByText(value.title)).toBeVisible();
  // The run counts as the team above does: its agents are agents, its media column is a stage, its nodes include the media.
  const agents = PRODUCTION_WORKFLOWS[id].nodes.length, nodes = agents + media.length;
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(`${agents} agents, 3 stages, `);
  expect(screen.getByText(`${nodes}/${nodes} nodes done`)).toBeVisible();
  expect(within(strip).getByText(`Stage 01 · ${media.length} media nodes, generated in the same run`)).toBeVisible();
  const stages = screen.getByRole('list', { name: 'Every agent, stage by stage' });
  expect([...stages.querySelectorAll('.production-made-stage')].map(label => label.firstChild?.textContent)).toEqual(id === 'shanhai-vn' ? ['01', '02', '03'] : ['02', '03']);
});

it('counts a media case’s agents without its media slot, which still shows as a stage, and its media among its nodes', async () => {
  render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  for (const [title, chip] of [['Neon City', 'Real run · 6/6 nodes done'], ['Tales of Mountains and Seas', 'Real run · 9/9 nodes done'], ['Aurora GT', 'Real run · 6/6 nodes done']] as const)
    expect(within(screen.getByRole('button', { name: title }).closest<HTMLElement>('.production-card')!).getByText(chip)).toBeVisible();
  for (const [title, line] of [['Neon City', '2 agents · 3 stages'], ['Tales of Mountains and Seas', '3 agents · 3 stages'], ['Aurora GT', '2 agents · 3 stages']] as const) {
    fireEvent.click(screen.getByRole('button', { name: title }));
    const dialog = screen.getByRole('dialog', { name: title });
    expect(within(dialog).getByText(line)).toBeVisible();
    expect(within(dialog).getAllByText('Media').length).toBeGreaterThan(0);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    cleanup();
    render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  }
});


// The rebuilt 3D cases (R1b, 2026-10-15): their 3D model node's GLB is published as a static file and handed to the page in
// place of the path its code loads, and the brand fonts their interfaces name come with the page.
it.each([['neon-circuit', 'Orbitron'], ['car-plant', 'Space Grotesk']] as const)('runs %s on the 3D model its canvas made, in its brand fonts', async (id, font) => {
  const item = PRODUCTION_CASES.find(value => value.id === id)!, media = PRODUCTION_WORKFLOWS[id].media!;
  expect(media.map(value => value.kind)).toEqual(['model3d']);
  render(<SaaSPreferencesProvider><ProductionShowcase item={item} /></SaaSPreferencesProvider>);
  const frame = await screen.findByTitle(`${item.title}: the result an AwwO run delivered`, undefined, { timeout: 20000 });
  const source = frame.getAttribute('srcdoc')!;
  expect(source).toContain('data:model/gltf-binary;base64,');
  expect(source).not.toMatch(new RegExp(`\\b${media[0].id}/model-\\d+\\.glb`));
  expect(source).toContain(`@font-face{font-family:"${font}";src:url(data:font/woff2;base64,`);
  expect(source).toContain('"three/addons/loaders/GLTFLoader.js"');
  // The model node shows in the strip by its preview picture, beside the agents.
  const strip = screen.getByRole('region', { name: 'What the media nodes generated in this run' });
  expect(within(strip).getAllByRole('listitem')).toHaveLength(1);
  expect(within(strip).getByText('Stage 01 · 1 media node, generated in the same run')).toBeVisible();
  expect(strip.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
}, 30000);


// A media case's page is never shown without the files it uses: a file that cannot be loaded shows a notice and a way to
// try again instead of a page with broken pictures.
it('shows no page while a media case’s file cannot be loaded, and runs it once a retry brings every file', async () => {
  const item = PRODUCTION_CASES.find(value => value.id === 'aurora-gt')!;
  const files = new Map(Object.entries(await import('../src/saas/production-runs/aurora-gt.media.json').then(module => module.default as Record<string, { src: string }>)));
  const broken = files.get('red/image-1.jpg')!.src;
  let fail = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === broken && fail) return new Response('missing', { status: 404 });
    return new Response(readFileSync(path.join(WEB, ...url.split('/').filter(Boolean))), { status: 200 });
  });
  render(<SaaSPreferencesProvider><ProductionShowcase item={item} /></SaaSPreferencesProvider>);
  const notice = await screen.findByRole('alert', undefined, { timeout: 20000 });
  expect(notice).toHaveTextContent('could not be loaded, so it is not shown without them');
  expect(screen.queryByTitle(`${item.title}: the result an AwwO run delivered`)).toBeNull();
  fail = false;
  fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
  const frame = await screen.findByTitle(`${item.title}: the result an AwwO run delivered`, undefined, { timeout: 20000 });
  expect(frame.getAttribute('srcdoc')).not.toMatch(/\bred\/image-1\.jpg/);
}, 30000);

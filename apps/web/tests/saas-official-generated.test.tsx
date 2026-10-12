import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { htmlPreviewDocument, PREVIEW_HOST_SCRIPT } from '../src/canvas/htmlDeliverable';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import GeneratedOfficialDemo, { hasGeneratedPage } from '../src/saas/examples/GeneratedOfficialDemo';
import { OfficialExamples } from '../src/saas/examples/OfficialExamples';
import { OfficialShowcase } from '../src/saas/examples/OfficialShowcase';
import { OFFICIAL_GENERATED_RECORDS } from '../src/saas/examples/generatedRecords';
import { OFFICIAL_MEDIA } from '../src/saas/examples/officialMedia';
import { OFFICIAL_WORKFLOWS, getOfficialWorkflow } from '../src/saas/examples/officialWorkflows';
import { showcasePage } from '../src/saas/examples/showcaseDocument';

const PAGES = import.meta.glob<string>(['../src/saas/examples/generated/official/*.ts', '!../src/saas/examples/generated/official/*.media.ts'], { eager: true, import: 'default' });
const MEDIA = import.meta.glob<Readonly<Record<string, string>>>('../src/saas/examples/generated/official/*.media.ts', { eager: true, import: 'default' });
const pageOf = (id: string) => PAGES[`../src/saas/examples/generated/official/${id}.ts`];
const mediaOf = (id: string) => MEDIA[`../src/saas/examples/generated/official/${id}.media.ts`] ?? {};

const item = getOfficialWorkflow('studio-pipeline')!;
const record = OFFICIAL_GENERATED_RECORDS[item.id]!;
const artifact = item.nodes.find(node => node.id === record.artifactNodeId)!;
const left = () => screen.getByRole('region', { name: '编排过程', exact: true });
const nodeButton = (title: string) => within(left()).getByRole('button', { name: `查看节点：${title}`, exact: true });
const withPreferences = (node: ReactNode) => render(<SaaSPreferencesProvider>{node}</SaaSPreferencesProvider>);

// These documents are parsed as data. No generated scripts are evaluated in jsdom.
function inertDocument(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}
/** The page's own first script in a preview, past AwwO's viewport script at the head. */
const pageScript = (preview: ParentNode) => [...preview.querySelectorAll('script')].find(script => script.textContent !== PREVIEW_HOST_SCRIPT);

function view() {
  return withPreferences(<OfficialShowcase item={item} record={record}><GeneratedOfficialDemo id={item.id} title={item.title.zh} /></OfficialShowcase>);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('superclaw_locale', 'zh');
  history.replaceState({}, '', '/?examples=1');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the official examples, as their real Claude Opus 5.5 runs made them', () => {
  it('publishes every official example as a completed run of its own workflow', () => {
    expect(Object.keys(OFFICIAL_GENERATED_RECORDS).sort()).toEqual(OFFICIAL_WORKFLOWS.map(example => example.id).sort());
    for (const [id, value] of Object.entries(OFFICIAL_GENERATED_RECORDS)) {
      const entry = value!;
      const workflow = getOfficialWorkflow(id)!;
      expect(hasGeneratedPage(id), id).toBe(true);
      expect(entry.model).toBe('Claude Opus 5.5');
      expect(entry.capturedOn).toBe('2026-10-12');
      expect(Object.keys(entry.nodes).sort(), id).toEqual(workflow.nodes.map(node => node.id).sort());
      expect(Object.values(entry.nodes).every(status => status === 'done'), id).toBe(true);
      expect([entry.completed, entry.total], id).toEqual([workflow.nodes.length, workflow.nodes.length]);
      expect(workflow.nodes.find(node => node.id === entry.artifactNodeId)?.outputType, id).toBe('html');
      expect(entry.reused).toBeUndefined();
      expect(entry.originalSHA256).toBeUndefined();
      expect(entry.sourceSHA256).toMatch(/^[0-9a-f]{64}$/);
      for (const locale of ['zh', 'en'] as const) {
        expect(entry.note[locale], id).toContain('Claude Opus 5.5');
        expect(entry.verification[locale].trim(), id).not.toBe('');
      }
      // Public copy never says which provider generated a picture, clip or model.
      expect(JSON.stringify(entry), id).not.toMatch(/x-?tasy|tripo|runninghub|seedream|jimeng/i);
    }
  });

  it('keeps each page byte for byte as its node delivered it', () => {
    for (const [id, entry] of Object.entries(OFFICIAL_GENERATED_RECORDS)) {
      const page = pageOf(id);
      expect(typeof page, id).toBe('string');
      expect(createHash('sha256').update(page, 'utf8').digest('hex'), id).toBe(entry!.sourceSHA256);
      expect(page.trim(), id).toMatch(/<\/html>$/i);
      expect(page, id).not.toMatch(/<script[^>]+src=/i);
    }
  });

  it('carries only the generated files a page names, as small inline pictures and clips', () => {
    const withMedia = [];
    for (const id of Object.keys(OFFICIAL_GENERATED_RECORDS)) {
      const media = Object.entries(mediaOf(id));
      if (!OFFICIAL_MEDIA[id]?.length) expect(media, id).toHaveLength(0);
      for (const [reference, url] of media) {
        expect(pageOf(id), `${id}: ${reference}`).toContain(reference);
        expect(url, reference).toMatch(/^data:(?:image\/(?:jpeg|webp)|video\/mp4);base64,[A-Za-z0-9+/=]+$/);
        expect(url.length, reference).toBeLessThan(1_000_000);
      }
      if (media.length) withMedia.push(id);
    }
    expect(withMedia.sort()).toEqual(Object.keys(OFFICIAL_MEDIA).sort());
  });

  it('puts each named file in place, after ./ or / too, and leaves a page without files as it is', () => {
    const page = '<img src="n1/image-1.jpg"><img src="./n1/image-1.jpg"><script>clip.src = "/n2/video-1.mp4";</script><p>n3/model-1.glb</p>';
    expect(showcasePage(page, { 'n1/image-1.jpg': 'data:image/jpeg;base64,AA==', 'n2/video-1.mp4': 'data:video/mp4;base64,BB==' })).toBe(
      '<img src="data:image/jpeg;base64,AA=="><img src="data:image/jpeg;base64,AA=="><script>clip.src = "data:video/mp4;base64,BB==";</script><p>n3/model-1.glb</p>');
    expect(showcasePage(page, {})).toBe(page);
  });

  it('runs each page in an opaque sandbox under the preview policy, with its own files and no requests', async () => {
    for (const id of Object.keys(OFFICIAL_GENERATED_RECORDS)) {
      const title = getOfficialWorkflow(id)!.title.zh;
      const mounted = withPreferences(<GeneratedOfficialDemo id={id} title={title} />);
      const frame = await screen.findByTitle(title, {}, { timeout: 5000 });
      expect(frame.tagName).toBe('IFRAME');
      expect(frame, id).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
      expect(frame).toHaveAttribute('allow', 'clipboard-write');
      expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(frame).not.toHaveAttribute('src');
      const source = frame.getAttribute('srcdoc')!;
      const preview = inertDocument(source);
      const policies = preview.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
      expect(policies, id).toHaveLength(1);
      const csp = policies[0].getAttribute('content')!;
      for (const rule of ["script-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", 'img-src data:', 'media-src data:']) {
        expect(csp, `${id}: ${rule}`).toContain(rule);
      }
      expect(preview.querySelector('script[src]'), id).toBeNull();
      expect(pageScript(preview), id).toBeDefined();
      for (const reference of Object.keys(mediaOf(id))) expect(source, `${id}: ${reference}`).not.toContain(reference);
      mounted.unmount();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a closed dialog closed and a fixed field fixed in the preview', async () => {
    withPreferences(<GeneratedOfficialDemo id={item.id} title={item.title.zh} />);
    const preview = inertDocument((await screen.findByTitle(item.title.zh)).getAttribute('srcdoc')!);
    expect(preview.querySelectorAll('[hidden]').length).toBeGreaterThan(0);
    expect(preview.querySelectorAll('textarea[readonly]').length).toBeGreaterThan(0);
  });

  it('does not let source metadata or remote script tags weaken the interactive preview policy', () => {
    const preview = inertDocument(htmlPreviewDocument('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><script src="https://example.test/remote.js"></script></head><body><button>Local control</button><script>window.sourceMarker = 1</script></body></html>', true));
    expect(preview.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(1);
    expect(preview.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("connect-src 'none'");
    expect(preview.querySelector('script[src]')).toBeNull();
    expect(pageScript(preview)?.textContent).toBe('window.sourceMarker = 1');
    expect([...preview.querySelectorAll('script')].map(script => script.textContent)).toEqual([PREVIEW_HOST_SCRIPT, 'window.sourceMarker = 1']);
    expect('sourceMarker' in window).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens the real artifact node beside the run snapshot and its provenance', async () => {
    view();
    expect(nodeButton(artifact.title.zh)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(`运行快照 · ${record.completed}/${record.total} 完成`)).toBeVisible();
    expect(screen.getByText(`${record.model} · ${record.capturedOn}`)).toBeVisible();
    expect(screen.getByText('模型生成成果')).toBeVisible();
    expect(within(left()).getByText(record.note.zh)).toBeVisible();
    fireEvent.click(screen.getByText('产物来源与校验', { exact: true }));
    expect(screen.getByText(`SHA-256 ${record.sourceSHA256}`)).toBeVisible();
    expect(screen.getByText(record.verification.zh, { exact: false })).toBeVisible();
    expect(await screen.findByTitle(item.title.zh)).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never changes captured execution statuses when playing the workflow explanation', () => {
    vi.useFakeTimers();
    view();
    const captured = JSON.stringify(record);
    fireEvent.click(screen.getByRole('button', { name: '播放编排讲解', exact: true }));
    for (let index = 0; index <= item.nodes.length; index++) act(() => { vi.runOnlyPendingTimers(); });
    expect(screen.getByRole('button', { name: '播放编排讲解', exact: true })).toBeVisible();
    expect(screen.getByText(`运行快照 · ${record.completed}/${record.total} 完成`)).toBeVisible();
    expect(JSON.stringify(record)).toBe(captured);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the same provenance in English', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    view();
    const process = screen.getByRole('region', { name: 'Orchestration process' });
    expect(within(process).getByText(record.note.en)).toBeVisible();
    expect(screen.getByText(`Run snapshot · ${record.completed}/${record.total} done`)).toBeVisible();
    expect(within(process).getByRole('button', { name: `View node: ${artifact.title.en}` })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Model-generated result')).toBeVisible();
    expect(screen.getByText(record.verification.en, { exact: false })).toBeVisible();
    expect(await screen.findByTitle(item.title.zh)).toBeVisible();
  });

  it('loads the generated result in the real gallery and keeps it across the tabs', async () => {
    withPreferences(<OfficialExamples initialId={item.id} />);
    expect(screen.getByRole('tab', { name: '同屏体验' })).toHaveAttribute('aria-selected', 'true');
    const frameTitle = `${item.title.zh} · 模型生成成果`;
    const frame = await screen.findByTitle(frameTitle);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    expect(nodeButton(artifact.title.zh)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('tab', { name: '复用指南' }));
    expect(screen.getByRole('button', { name: '下载画布 JSON' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '同屏体验' }));
    expect(screen.getByTitle(frameTitle)).toBe(frame);
    expect(screen.getByText(`运行快照 · ${record.completed}/${record.total} 完成`)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { htmlPreviewDocument } from '../src/canvas/htmlDeliverable';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import GeneratedOfficialDemo from '../src/saas/examples/GeneratedOfficialDemo';
import { OfficialExamples } from '../src/saas/examples/OfficialExamples';
import { OfficialShowcase } from '../src/saas/examples/OfficialShowcase';
import { OFFICIAL_GENERATED_RECORDS } from '../src/saas/examples/generatedRecords';
import { getOfficialWorkflow } from '../src/saas/examples/officialWorkflows';
import orbit from '../src/saas/examples/generated/orbitResult';
import game from '../src/saas/examples/generated/gameResult';
import training from '../src/saas/examples/generated/trainingResult';
import flux from '../src/saas/examples/generated/fluxResult';

const item = getOfficialWorkflow('interaction-page')!;
const record = OFFICIAL_GENERATED_RECORDS[item.id]!;
const artifact = item.nodes.find(node => node.id === 'build')!;
const failed = item.nodes.find(node => node.id === 'handoff')!;
const left = () => screen.getByRole('region', { name: '编排过程', exact: true });
const nodeButton = (title: string) => within(left()).getByRole('button', { name: `查看节点：${title}`, exact: true });

// These documents are parsed as data. No generated scripts are evaluated in jsdom.
function inertDocument(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function view() {
  return render(<SaaSPreferencesProvider><OfficialShowcase item={item} record={record}>
    <GeneratedOfficialDemo id={item.id} title={item.title.zh} />
  </OfficialShowcase></SaaSPreferencesProvider>);
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

describe('curated model-generated official results', () => {
  it('preserves the completed game run and the checksum of its layout-only QA revision', () => {
    const gameRecord = OFFICIAL_GENERATED_RECORDS['orbit-game']!;
    expect(createHash('sha256').update(game, 'utf8').digest('hex')).toBe(gameRecord.sourceSHA256);
    expect(gameRecord.originalSHA256).toBe('3fcf2394d35933a4eb27252a19f28e2a33b154265fd4755a6333bb2a64e154a7');
    expect(gameRecord.completed).toBe(6);
    expect(gameRecord.total).toBe(6);
    expect(Object.values(gameRecord.nodes)).toEqual(Array(6).fill('done'));
    expect(gameRecord.reused).toBeUndefined();
  });
  it('keeps every published record tied to existing workflow and node identifiers', () => {
    expect(Object.keys(OFFICIAL_GENERATED_RECORDS).length).toBeGreaterThan(0);
    for (const [id, value] of Object.entries(OFFICIAL_GENERATED_RECORDS)) {
      expect(value, id).toBeDefined();
      const entry = value!;
      const workflow = getOfficialWorkflow(id);
      expect(workflow, id).toBeDefined();
      const nodeIds = workflow!.nodes.map(node => node.id);
      expect(nodeIds, id).toContain(entry.artifactNodeId);
      expect(['done', 'cached']).toContain(entry.nodes[entry.artifactNodeId]);
      expect(Number.isInteger(entry.completed)).toBe(true);
      expect(Number.isInteger(entry.total)).toBe(true);
      expect(entry.completed).toBeGreaterThanOrEqual(0);
      expect(entry.completed).toBeLessThanOrEqual(entry.total);
      expect(entry.total).toBeGreaterThan(0);
      expect(entry.total).toBeLessThanOrEqual(nodeIds.length);
      expect(Object.values(entry.nodes).filter(status => status === 'done')).toHaveLength(entry.completed);
      expect(Object.values(entry.nodes).filter(status => status !== 'cached')).toHaveLength(entry.total);
      expect(Object.values(entry.nodes).filter(status => status === 'cached')).toHaveLength(entry.reused || 0);
      for (const [nodeId, status] of Object.entries(entry.nodes)) {
        expect(nodeIds, `${id}:${nodeId}`).toContain(nodeId);
        expect(['done', 'failed', 'blocked', 'canceled', 'cached']).toContain(status);
      }
      expect(entry.sourceSHA256).toMatch(/^[0-9a-f]{64}$/);
      if (entry.originalSHA256) expect(entry.originalSHA256).toMatch(/^[0-9a-f]{64}$/);
      for (const locale of ['zh', 'en'] as const) {
        expect(entry.note[locale].trim()).not.toBe('');
        expect(entry.verification[locale].trim()).not.toBe('');
      }
    }
  });

  it('matches the original Orbit HTML bytes to the public provenance checksum', () => {
    expect(createHash('sha256').update(orbit, 'utf8').digest('hex')).toBe(record.sourceSHA256);
    expect(record.originalSHA256).toBeUndefined();
    expect(record.artifactNodeId).toBe('build');
    expect(record.completed).toBe(5);
    expect(record.total).toBe(6);
    expect(Object.values(record.nodes).filter(status => status === 'done')).toHaveLength(5);
    expect(record.nodes.handoff).toBe('failed');
  });

  it('keeps the revised training artifact checksum distinct from the original model output', () => {
    const entry = OFFICIAL_GENERATED_RECORDS['model-lab']!;
    expect(createHash('sha256').update(training, 'utf8').digest('hex')).toBe(entry.sourceSHA256);
    expect(entry.originalSHA256).toBe('ad4f67cd27232d900e4fd983a896e404dbb06d04ae2392f7775632ff193d3fdb');
    expect(entry.originalSHA256).not.toBe(entry.sourceSHA256);
    expect(entry.completed).toBe(4);
    expect(entry.total).toBe(6);
    expect(entry.nodes.build).toBe('done');
    expect(entry.nodes.check).toBe('failed');
    expect(entry.nodes.card).toBe('blocked');
  });

  it('matches the revised FLUX bytes while preserving the original repair output checksum', () => {
    const entry = OFFICIAL_GENERATED_RECORDS['grid-balance']!;
    expect(createHash('sha256').update(flux, 'utf8').digest('hex')).toBe(entry.sourceSHA256);
    expect(entry.originalSHA256).toBe('2388674c6ccb4ccad8c443390cb4505c46e88448438f043317ce104604abff3a');
    expect(entry.sourceSHA256).not.toBe(entry.originalSHA256);
    expect(entry.artifactNodeId).toBe('repair');
    expect(entry.completed).toBe(2);
    expect(entry.total).toBe(4);
    expect(entry.reused).toBe(5);
    expect(entry.nodes.deliver).toBe('failed');
    expect(entry.nodes.guide).toBe('blocked');
  });

  it('preserves explicit accessible labels for all seven FLUX sliders after preview sanitization', () => {
    render(<GeneratedOfficialDemo id="grid-balance" title="FLUX result" />);
    const preview = inertDocument(screen.getByTitle('FLUX result').getAttribute('srcdoc')!);
    const controls = Array.from(preview.querySelectorAll('input[type="range"]'));
    expect(controls).toHaveLength(7);
    expect(controls.map(control => control.id)).toEqual([
      'loadScale', 'pvPeak', 'essCap', 'essPower', 'socInit', 'outageStart', 'outageEnd',
    ]);
    for (const control of controls) {
      expect(preview.querySelectorAll(`#${control.id}`)).toHaveLength(1);
      const labels = preview.querySelectorAll(`label[for="${control.id}"]`);
      expect(labels).toHaveLength(1);
      expect(labels[0].textContent?.trim()).not.toBe('');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows FLUX continuation progress separately from cached inputs and leaves out-of-scope nodes unclaimed', () => {
    const workflow = getOfficialWorkflow('grid-balance')!;
    const entry = OFFICIAL_GENERATED_RECORDS[workflow.id]!;
    render(<SaaSPreferencesProvider><OfficialShowcase item={workflow} record={entry}>
      <GeneratedOfficialDemo id={workflow.id} title={workflow.title.zh} />
    </OfficialShowcase></SaaSPreferencesProvider>);
    expect(screen.getByText('运行快照 · 2/4 完成')).toBeVisible();
    expect(screen.getByText(`${entry.model} · ${entry.capturedOn} · 5 个上游沿用`)).toBeVisible();
    expect(nodeButton(workflow.nodes.find(node => node.id === 'repair')!.title.zh)).toHaveAttribute('aria-pressed', 'true');
    expect(within(left()).getAllByText('沿用结果', { exact: true })).toHaveLength(5);
    for (const id of ['ux', 'engine', 'views']) {
      const button = nodeButton(workflow.nodes.find(node => node.id === id)!.title.zh);
      expect(within(button).queryByText(/^(完成|失败|阻断|已停止|沿用结果)$/)).toBeNull();
    }
    fireEvent.click(nodeButton(workflow.nodes.find(node => node.id === 'deliver')!.title.zh));
    expect(screen.getByText('当前节点交付 · 失败')).toBeVisible();
    expect(screen.getByText('运行快照 · 2/4 完成')).toBeVisible();
    fireEvent.click(screen.getByText('产物来源与校验', { exact: true }));
    expect(screen.getByText(`SHA-256 ${entry.sourceSHA256}`)).toBeVisible();
    expect(screen.getByText(`模型原文 SHA-256 ${entry.originalSHA256}`)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('provides a sandboxed document for every published generated case', () => {
    for (const id of Object.keys(OFFICIAL_GENERATED_RECORDS)) {
      const title = getOfficialWorkflow(id)!.title.zh;
      const mounted = render(<GeneratedOfficialDemo id={id} title={title} />);
      const frame = screen.getByTitle(title);
      expect(frame, id).toHaveAttribute('sandbox', 'allow-scripts');
      const preview = inertDocument(frame.getAttribute('srcdoc')!);
      expect(preview.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'), id).toContain("connect-src 'none'");
      expect(preview.querySelector('button, input, select, canvas'), id).not.toBeNull();
      expect(preview.querySelector('script[src]'), id).toBeNull();
      mounted.unmount();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains training controls and inline source as inert preview data', () => {
    render(<GeneratedOfficialDemo id="model-lab" title="Training result" />);
    const preview = inertDocument(screen.getByTitle('Training result').getAttribute('srcdoc')!);
    expect(preview.querySelector('#noise')?.getAttribute('min')).toBe('0');
    expect(preview.querySelector('#predCpu')?.getAttribute('max')).toBe('100');
    expect(preview.querySelector('#predQueue')?.getAttribute('max')).toBe('50');
    for (const id of ['trainBtn', 'stopBtn', 'retrainBtn', 'resetBtn', 'predictBtn']) {
      expect(preview.querySelector(`button#${id}`), id).not.toBeNull();
    }
    expect(preview.querySelectorAll('canvas')).toHaveLength(3);
    expect(preview.querySelector('script')?.textContent).toBe(inertDocument(training).querySelector('script')?.textContent);
    expect(document.querySelector('#trainBtn')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('labels QA revisions while retaining failed and blocked model statuses and both checksums', () => {
    const workflow = getOfficialWorkflow('model-lab')!;
    const entry = OFFICIAL_GENERATED_RECORDS[workflow.id]!;
    render(<SaaSPreferencesProvider><OfficialShowcase item={workflow} record={entry}>
      <GeneratedOfficialDemo id={workflow.id} title={workflow.title.zh} />
    </OfficialShowcase></SaaSPreferencesProvider>);
    expect(screen.getByText('模型生成 · 验收修订')).toBeVisible();
    expect(screen.getByText('运行快照 · 4/6 完成')).toBeVisible();
    expect(nodeButton(workflow.nodes.find(node => node.id === 'build')!.title.zh)).toHaveAttribute('aria-pressed', 'true');
    expect(within(nodeButton(workflow.nodes.find(node => node.id === 'check')!.title.zh)).getByText('失败')).toBeVisible();
    expect(within(nodeButton(workflow.nodes.find(node => node.id === 'card')!.title.zh)).getByText('阻断')).toBeVisible();
    fireEvent.click(screen.getByText('产物来源与校验', { exact: true }));
    expect(screen.getByText(`SHA-256 ${entry.sourceSHA256}`)).toBeVisible();
    expect(screen.getByText(`模型原文 SHA-256 ${entry.originalSHA256}`)).toBeVisible();
    const frame = screen.getByTitle(workflow.title.zh);
    fireEvent.click(screen.getByRole('button', { name: '专注成果', exact: true }));
    expect(screen.getByTitle(workflow.title.zh)).toBe(frame);
    fireEvent.click(screen.getByRole('button', { name: '重置成果', exact: true }));
    expect(screen.getByTitle(workflow.title.zh)).not.toBe(frame);
    expect(screen.getByText('模型生成 · 验收修订')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renders the original controls in an opaque iframe with inline scripts and no connection permission', () => {
    render(<GeneratedOfficialDemo id={item.id} title={item.title.zh} />);
    const frame = screen.getByTitle(item.title.zh);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).not.toHaveAttribute('src');
    const preview = inertDocument(frame.getAttribute('srcdoc')!);
    const original = inertDocument(orbit);
    const csp = preview.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content');
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(preview.querySelector('input[aria-label="团队人数"]')?.getAttribute('min')).toBe('1');
    expect(preview.querySelector('input[aria-label="团队人数"]')?.getAttribute('max')).toBe('30');
    expect(preview.querySelectorAll('[data-plan]').length).toBe(3);
    expect(preview.querySelectorAll('[data-cycle]').length).toBe(2);
    expect(preview.querySelector('#generate-btn')?.textContent).toBe('生成方案摘要');
    expect(preview.querySelector('script')?.textContent).toBe(original.querySelector('script')?.textContent);
    expect(document.querySelector('#generate-btn')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let source metadata or remote script tags weaken the interactive preview policy', () => {
    const preview = inertDocument(htmlPreviewDocument('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><script src="https://example.test/remote.js"></script></head><body><button>Local control</button><script>window.sourceMarker = 1</script></body></html>', true));
    expect(preview.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(1);
    expect(preview.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("connect-src 'none'");
    expect(preview.querySelector('script[src]')).toBeNull();
    expect(preview.querySelector('script')?.textContent).toBe('window.sourceMarker = 1');
    expect('sourceMarker' in window).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens the real artifact node while retaining the incomplete graph and failed handoff evidence', () => {
    view();
    expect(nodeButton(artifact.title.zh)).toHaveAttribute('aria-pressed', 'true');
    expect(within(left()).getByRole('heading', { name: artifact.title.zh, exact: true })).toBeVisible();
    expect(screen.getByText('运行快照 · 5/6 完成')).toBeVisible();
    expect(screen.getByText('模型生成成果')).toBeVisible();
    expect(within(left()).getByText(record.note.zh)).toBeVisible();
    expect(within(nodeButton(failed.title.zh)).getByText('失败', { exact: true })).toBeVisible();
    fireEvent.click(nodeButton(failed.title.zh));
    expect(screen.getByText('当前节点交付 · 失败')).toBeVisible();
    expect(screen.getByText('运行快照 · 5/6 完成')).toBeVisible();
    fireEvent.click(screen.getByText('产物来源与校验', { exact: true }));
    expect(screen.getByText(`SHA-256 ${record.sourceSHA256}`)).toBeVisible();
    expect(screen.getByText(record.verification.zh)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never changes captured execution statuses when playing the workflow explanation', () => {
    vi.useFakeTimers();
    view();
    const captured = JSON.stringify(record);
    fireEvent.click(screen.getByRole('button', { name: '播放编排讲解', exact: true }));
    for (let index = 0; index <= item.nodes.length; index++) act(() => { vi.runOnlyPendingTimers(); });
    expect(screen.getByRole('button', { name: '播放编排讲解', exact: true })).toBeVisible();
    expect(screen.getByText('运行快照 · 5/6 完成')).toBeVisible();
    expect(within(nodeButton(failed.title.zh)).getByText('失败', { exact: true })).toBeVisible();
    expect(JSON.stringify(record)).toBe(captured);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the same incomplete provenance in English', () => {
    localStorage.setItem('superclaw_locale', 'en');
    view();
    const process = screen.getByRole('region', { name: 'Orchestration process' });
    expect(within(process).getByText(record.note.en)).toBeVisible();
    expect(screen.getByText('Run snapshot · 5/6 done')).toBeVisible();
    expect(within(process).getByRole('button', { name: `View node: ${artifact.title.en}` })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Model-generated result')).toBeVisible();
    expect(screen.getByText(record.verification.en)).toBeVisible();
  });

  it('loads the generated result in the real gallery and preserves it across guide navigation', async () => {
    render(<SaaSPreferencesProvider><OfficialExamples initialId={item.id} /></SaaSPreferencesProvider>);
    expect(screen.getByRole('tab', { name: '同屏体验' })).toHaveAttribute('aria-selected', 'true');
    const frameTitle = `${item.title.zh} · 模型生成成果`;
    const frame = await screen.findByTitle(frameTitle);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(nodeButton(artifact.title.zh)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('tab', { name: '复用指南' }));
    expect(screen.getByRole('button', { name: '下载画布 JSON' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '同屏体验' }));
    expect(screen.getByTitle(frameTitle)).toBe(frame);
    expect(screen.getByText('运行快照 · 5/6 完成')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});

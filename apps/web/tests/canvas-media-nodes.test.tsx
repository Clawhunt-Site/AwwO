import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InspectorPanel, type InspectorPanelProps } from '../src/canvas/InspectorPanel';
import { createSessionNode, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { portsFor } from '../src/canvas/ports';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { LocaleProvider } from '../src/canvas/i18n';
import { invalidMediaParams, parseMediaCatalogue, withMediaParam, type MediaCatalogue } from '../src/canvas/mediaCatalog';
import { parseMediaOutput } from '../src/canvas/mediaOutput';
import { withAgentKind, type MediaCatalogueState } from '../src/canvas/MediaNodeSettings';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import type { Turn } from '../src/canvas/sessions';
import { canvasFetch, clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };

const rawCatalogue = {
  provider: 'runninghub', configured: true, available: true, limits: { runsPerDay: 30, timeoutSeconds: 1200 },
  models: [
    { id: 'rh.seedream-v5-pro', name: 'Seedream 5.0 Pro', vendor: 'bytedance', kind: 'image', mode: 'text-to-image', prompt: { minLength: 5, maxLength: 5000 },
      params: [{ name: 'resolution', type: 'enum', values: ['1k', '2k'], default: '2k', label: ['分辨率', 'Resolution'] }] },
    { id: 'rh.midjourney-v7', name: 'Midjourney V7', vendor: 'midjourney', kind: 'image', mode: 'text-to-image', prompt: { minLength: 1, maxLength: 8192 },
      params: [{ name: 'stylize', type: 'integer', min: 0, max: 1000, default: 100, label: ['风格化', 'Stylize'] },
        { name: 'raw', type: 'boolean', default: false, label: ['原始模式', 'Raw mode'] },
        { name: 'negativePrompt', type: 'text', maxLength: 20, label: ['反向提示词', 'Negative prompt'] }] },
    { id: 'rh.kling-v3-pro', name: 'Kling 3.0 Pro', vendor: 'kuaishou', kind: 'video', mode: 'text-to-video', prompt: { minLength: 1, maxLength: 2500 },
      params: [{ name: 'duration', type: 'enum', values: ['5', '10'], default: '5', label: ['时长（秒）', 'Duration (s)'] }] },
    // Malformed entries are dropped, never repaired.
    { id: 'seedream', name: 'No prefix', vendor: 'x', kind: 'image', prompt: { minLength: 1, maxLength: 9 }, params: [] },
    { id: 'rh.bad-default', name: 'Bad', vendor: 'x', kind: 'image', prompt: { minLength: 1, maxLength: 9 },
      params: [{ name: 'ratio', type: 'enum', values: ['1:1'], default: '4:3', label: ['比例', 'Ratio'] }] },
  ],
};
const catalogue = parseMediaCatalogue(rawCatalogue);
const ready: MediaCatalogueState = { status: 'ready', catalogue };

function props(overrides: Partial<InspectorPanelProps> = {}): InspectorPanelProps {
  return {
    node: { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title: '海报', persona: '核对证据' },
    liveCompanies: [{ id: 'workspace', name: '当前项目' }], apiBase: '/api',
    onSave: vi.fn(), onClose: vi.fn(), onInitialize: vi.fn(async () => {}), media: ready, ...overrides,
  };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); clearSaaSCanvas(); configureSaaSCanvasSave(null); });

describe('media catalogue', () => {
  it('keeps only well-formed models and nothing from an unconfigured service', () => {
    expect(catalogue.models.map(model => model.id)).toEqual(['rh.seedream-v5-pro', 'rh.midjourney-v7', 'rh.kling-v3-pro']);
    expect(catalogue).toMatchObject({ configured: true, available: true, runsPerDay: 30 });
    expect(parseMediaCatalogue({ ...rawCatalogue, configured: false })).toMatchObject({ configured: false, available: false, models: [] });
    expect(parseMediaCatalogue(null)).toMatchObject({ available: false, models: [] });
  });

  it('validates choices with the server rules and never stores a default', () => {
    const mj = catalogue.models[1];
    expect(invalidMediaParams(mj, { stylize: 250, raw: true })).toEqual([]);
    expect(invalidMediaParams(mj, { stylize: 1001, chaos: 1, raw: 'yes', negativePrompt: 'x'.repeat(21) })).toEqual(['stylize', 'chaos', 'raw', 'negativePrompt']);
    expect(invalidMediaParams(mj, { stylize: 2.5 })).toEqual(['stylize']);
    const stylize = mj.params[0];
    expect(withMediaParam({ raw: true }, stylize, 300)).toEqual({ raw: true, stylize: 300 });
    expect(withMediaParam({ raw: true, stylize: 300 }, stylize, 100)).toEqual({ raw: true });
    expect(withMediaParam({ negativePrompt: 'blur' }, mj.params[2], '')).toEqual({});
  });
});

describe('media nodes in the document', () => {
  it('keeps video nodes and their well-formed parameters, and types their result port', () => {
    const document = sanitizeDocument({ version: 2, nodes: [
      { ...createSessionNode('video', { x: 0, y: 0 }), id: 'v', model: 'rh.kling-v3-pro', mediaParams: { duration: '10', loud: true, 'bad key': 1, deep: { x: 1 }, nan: Number.NaN } },
      { ...createSessionNode('image', { x: 0, y: 0 }), id: 'i' },
    ], edges: [{ id: 'e', fromNode: 'v', fromPort: 'result', toNode: 'i', toPort: 'reference', dataType: 'video' }], waypoints: [], view: null });
    const video = document.nodes[0] as SessionNode;
    expect(video.agentKind).toBe('video');
    expect(video.mediaParams).toEqual({ duration: '10', loud: true });
    expect(portsFor(video).find(port => port.id === 'result')?.dataType).toBe('video');
    expect(portsFor(document.nodes[1]).find(port => port.id === 'result')?.dataType).toBe('image');
  });

  it('switches kinds without carrying settings that do not apply', () => {
    const llm: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), model: 'gpt-5', effort: 'high', templateId: 'general', taskFrame: { version: 1 } };
    llm.team = createNodeTeam(llm);
    const video = withAgentKind(llm, 'video', catalogue);
    expect(video).toMatchObject({ agentKind: 'video', model: 'rh.kling-v3-pro', effort: '' });
    for (const key of ['team', 'templateId', 'taskFrame', 'contract', 'mediaParams']) expect(video).not.toHaveProperty(key);
    const image = withAgentKind({ ...video, mediaParams: { duration: '10' } }, 'image', catalogue);
    expect(image).toMatchObject({ agentKind: 'image', model: 'rh.seedream-v5-pro' });
    expect(image).not.toHaveProperty('mediaParams');
    const back = withAgentKind({ ...image, mediaParams: { resolution: '1k' } }, 'llm', catalogue);
    expect(back).toMatchObject({ agentKind: 'llm', model: '' });
    expect(back).not.toHaveProperty('mediaParams');
    expect(withAgentKind(llm, 'coding', catalogue)).toMatchObject({ agentKind: 'coding', model: 'gpt-5', effort: 'high' });
  });
});

describe('media node configuration', () => {
  it('configures a video node from the catalogue and saves only explicit choices', async () => {
    const p = props();
    render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole('radio', { name: '视频 Agent' }));
    expect(screen.getByTestId('media-node-settings')).toBeInTheDocument();
    expect(screen.queryByLabelText('人设 / 系统提示词')).not.toBeInTheDocument();
    expect(screen.getByLabelText('模型')).toHaveValue('rh.kling-v3-pro');
    expect(screen.getByLabelText('时长（秒）')).toHaveValue('5');
    expect(screen.getByRole('option', { name: '5（默认）' })).toBeInTheDocument();
    expect(screen.getByText('每个工作区每天（UTC）最多生成 30 次。')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('时长（秒）'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(p.onInitialize).toHaveBeenCalledTimes(1));
    expect(p.onInitialize).toHaveBeenCalledWith(expect.objectContaining({ id: 'node-a', agentKind: 'video', model: 'rh.kling-v3-pro', mediaParams: { duration: '10' } }));
  });

  it('blocks a choice the model would refuse and starts a new model from its defaults', () => {
    const node: SessionNode = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'node-b', model: 'rh.midjourney-v7', mediaParams: { stylize: 300 } };
    const p = props({ node });
    render(<InspectorPanel {...p} />);
    expect(screen.getByLabelText('风格化')).toHaveValue(300);
    fireEvent.change(screen.getByLabelText('风格化'), { target: { value: '5000' } });
    expect(screen.getByRole('alert')).toHaveTextContent('以下设置不适用于该模型：风格化');
    expect(screen.getByRole('button', { name: '保存并准备运行' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('风格化'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '保存并准备运行' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'rh.seedream-v5-pro' } });
    expect(screen.getByLabelText('分辨率')).toHaveValue('2k');
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    expect(p.onInitialize).toHaveBeenCalledWith(expect.not.objectContaining({ mediaParams: expect.anything() }));
    expect(p.onInitialize).toHaveBeenCalledWith(expect.objectContaining({ model: 'rh.seedream-v5-pro' }));
  });

  it('says why media nodes are unavailable instead of offering an empty list', () => {
    const retry = vi.fn();
    const image: SessionNode = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'node-c' };
    const view = render(<InspectorPanel {...props({ node: image, media: { status: 'error' }, onRetryMedia: retry })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取图像与视频模型。');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: '视频 Agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并准备运行' })).toBeDisabled();
    view.rerender(<InspectorPanel {...props({ node: image, media: { status: 'loading' } })} />);
    expect(screen.getByText('正在读取图像与视频模型…')).toBeInTheDocument();
    view.rerender(<InspectorPanel {...props({ node: image, media: { status: 'ready', catalogue: parseMediaCatalogue({ configured: false }) } })} />);
    expect(screen.getByText('本工作区暂未开放图像与视频生成。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并准备运行' })).toBeDisabled();
  });

  it('offers no video kind outside a host that runs it', () => {
    render(<InspectorPanel {...props({ onInitialize: undefined, media: undefined })} />);
    expect(screen.getByRole('radio', { name: '图像 Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '视频 Agent' })).not.toBeInTheDocument();
  });

  it('labels media settings in English', () => {
    const node: SessionNode = { ...createSessionNode('video', { x: 0, y: 0 }), id: 'node-d', model: 'rh.kling-v3-pro' };
    render(<LocaleProvider locale="en"><InspectorPanel {...props({ node })} /></LocaleProvider>);
    expect(screen.getByLabelText('Duration (s)')).toHaveValue('5');
    expect(screen.getByRole('option', { name: '5 (default)' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Kuaishou' })).toBeInTheDocument();
  });
});

const mediaText = (kind: 'image' | 'video', contentType: string) => JSON.stringify({ type: 'awwo.media', version: 1, kind, model: 'rh.x',
  items: [{ artifactId: 'aBCDEFGHIJ0123456789_-', name: `${kind}-1`, contentType, size: 10 }] });
const agentTurn = (text: string, extra: Partial<Turn> = {}): Turn => ({ id: 't1', role: 'agent', text, ...extra }) as Turn;

describe('media results', () => {
  it('reads only the exact media record', () => {
    expect(parseMediaOutput(mediaText('image', 'image/png'))?.items[0].artifactId).toBe('aBCDEFGHIJ0123456789_-');
    expect(parseMediaOutput(mediaText('image', 'image/svg+xml'))).toBeNull();
    expect(parseMediaOutput(mediaText('image', 'video/mp4'))).toBeNull();
    expect(parseMediaOutput(mediaText('video', 'video/mp4').replace('aBCDEFGHIJ0123456789_-', '../../admin'))).toBeNull();
    expect(parseMediaOutput('{"type":"awwo.media"')).toBeNull();
    expect(parseMediaOutput('a cat {"type":"awwo.media"}')).toBeNull();
  });

  it('shows generated images and videos from the workspace, with downloads', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const view = render(<TileTranscript mediaResults turns={[agentTurn(mediaText('image', 'image/png'))]} history="loaded" streaming={false} />);
    expect(screen.getByText('已生成 1 张图片')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'image-1' })).toHaveAttribute('src', '/api/v1/tenants/tenant-a/artifacts/aBCDEFGHIJ0123456789_-/media');
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('href', '/api/v1/tenants/tenant-a/artifacts/aBCDEFGHIJ0123456789_-');
    view.rerender(<TileTranscript mediaResults turns={[agentTurn(mediaText('video', 'video/mp4'))]} history="loaded" streaming={false} />);
    const video = screen.getByLabelText('video-1');
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('src', '/api/v1/tenants/tenant-a/artifacts/aBCDEFGHIJ0123456789_-/media#t=0.1');
    view.rerender(<TileTranscript mediaResults turns={[agentTurn(mediaText('image', 'image/png'), { tone: 'error' })]} history="loaded" streaming={false} />);
    expect(screen.queryByTestId('media-result')).not.toBeInTheDocument();
  });

  it('shows a media result in the deliverables drawer instead of its record', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const node: SessionNode = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'node-e', lastOutput: { text: mediaText('image', 'image/png'), at: Date.now(), source: 'run' } };
    render(<NodeDeliverables node={node} readOnly />);
    expect(screen.getByRole('img', { name: 'image-1' })).toBeInTheDocument();
    expect(screen.queryByText(/awwo\.media/)).not.toBeInTheDocument();
  });

  it('reads media records only on image and video nodes', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    render(<TileTranscript turns={[agentTurn(mediaText('image', 'image/png'))]} history="loaded" streaming={false} />);
    expect(screen.queryByTestId('media-result')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const text: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-f', lastOutput: { text: mediaText('image', 'image/png'), at: Date.now(), source: 'run' } };
    cleanup();
    render(<NodeDeliverables node={text} readOnly />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the summary but no address without an active workspace', () => {
    render(<TileTranscript mediaResults turns={[agentTurn(mediaText('image', 'image/png'))]} history="loaded" streaming={false} />);
    expect(screen.getByText('已生成 1 张图片')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('reports the provider state while a generation runs', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    configureSaaSCanvasSave(async () => {});
    const record = mediaText('image', 'image/png');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('operationId=')) return new Response(JSON.stringify({ items: [] }));
      if (url.endsWith('/runs')) return new Response(JSON.stringify({ id: 'run-a', sessionId: 'session-a', status: 'queued' }));
      if (url.endsWith('/events')) return new Response(['{"type":"running"}', '{"type":"media_status","status":"queued"}', '{"type":"media_status","status":"running"}',
        '{"type":"media_status","status":"saving"}', '{"type":"media_status","status":"95%"}', JSON.stringify({ type: 'completed', text: record })].map(row => `data: ${row}\n\n`).join(''));
      throw new Error(`Unexpected ${url}`);
    }));
    const lang = document.documentElement.lang;
    document.documentElement.lang = 'zh-CN';
    let frames = '';
    try {
      const response = await canvasFetch('/gateway-api/conversations/tenant-a/agents/agent-a/messages', { method: 'POST', body: JSON.stringify({ message: 'a red bicycle', operationId: 'op-a', issueId: 'session-a' }) });
      frames = await response.text();
    } finally { document.documentElement.lang = lang; }
    for (const status of ['排队等待生成…', '正在生成…', '正在保存结果…']) expect(frames).toContain(`"status":"${status}"`);
    expect(frames).not.toContain('95%');
    expect(frames).toContain('"event":"done","status":"succeeded"');
  });
});

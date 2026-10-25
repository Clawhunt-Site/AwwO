import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InspectorPanel, type InspectorPanelProps } from '../src/canvas/InspectorPanel';
import { createSessionNode, emptyDocument, sanitizeDocument, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import { canConnect, portsFor, reconcileEdges } from '../src/canvas/ports';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { LocaleProvider } from '../src/canvas/i18n';
import { invalidMediaParams, parseMediaCatalogue, withMediaParam, type MediaCatalogue } from '../src/canvas/mediaCatalog';
import { parseMediaOutput } from '../src/canvas/mediaOutput';
import { replaceRetiredMediaModels } from '../src/canvas/retiredMediaModels';
import { preflightGraphIssue } from '../src/canvas/runGraph';
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
    { id: 'rh.kling-v3-pro', name: 'Kling 3.0 Pro', label: ['视频 · 标准', 'Video · Standard'], vendor: 'kuaishou', kind: 'video', mode: 'text-to-video', prompt: { minLength: 1, maxLength: 2500 },
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
  it('lets a video node keep the look of several subjects wired in, and an image or 3D node one picture', () => {
    const node = (kind: 'image' | 'video' | 'model3d', id: string, y = 0): SessionNode => ({ ...createSessionNode(kind, { x: 0, y }), id });
    const nodes = [node('image', 'hero'), node('image', 'ship', 600), node('image', 'set', 1200), node('video', 'shot'), node('image', 'edit'), node('model3d', 'model')];
    const wire = (from: string, to: string): CanvasEdge => ({ id: `${from}-${to}`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'reference', dataType: 'image' });
    let edges: CanvasEdge[] = [];
    for (const from of ['hero', 'ship', 'set']) {
      expect(canConnect(nodes, edges, { nodeId: from, portId: 'result' }, { nodeId: 'shot', portId: 'reference' }), from).toBe(true);
      edges = [...edges, wire(from, 'shot')];
    }
    expect(portsFor(nodes[3]).find(port => port.id === 'reference')?.multi).toBe(true);
    expect(reconcileEdges(nodes, edges).map(edge => edge.fromNode)).toEqual(['hero', 'ship', 'set']);
    for (const target of ['edit', 'model']) {
      expect(portsFor(nodes.find(item => item.id === target)!).find(port => port.id === 'reference')?.multi, target).toBeFalsy();
      expect(canConnect(nodes, [wire('hero', target)], { nodeId: 'ship', portId: 'result' }, { nodeId: target, portId: 'reference' }), target).toBe(false);
    }
  });

  it('lets a video node take a voice for each speaker in its own input, and never a voice where a picture goes', () => {
    const node = (kind: 'image' | 'video' | 'model3d' | 'audio', id: string, y = 0): SessionNode => ({ ...createSessionNode(kind, { x: 0, y }), id });
    const nodes = [node('audio', 'mara'), node('audio', 'kade', 600), node('audio', 'host', 1200), node('video', 'shot'), node('image', 'hero'),
      node('model3d', 'model'), node('video', 'other')];
    const wire = (from: string, to: string, dataType: CanvasEdge['dataType'] = 'audio'): CanvasEdge =>
      ({ id: `${from}-${to}`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'audio', dataType });
    expect(portsFor(nodes[3]).find(port => port.id === 'audio')).toEqual({ id: 'audio', side: 'input', dataType: 'audio', multi: true });
    let edges: CanvasEdge[] = [];
    for (const from of ['mara', 'kade', 'host']) {
      expect(canConnect(nodes, edges, { nodeId: from, portId: 'result' }, { nodeId: 'shot', portId: 'audio' }), from).toBe(true);
      edges = [...edges, wire(from, 'shot')];
    }
    expect(reconcileEdges(nodes, edges).map(edge => edge.fromNode)).toEqual(['mara', 'kade', 'host']);
    const can = (from: string, to: string, toPort: string) => canConnect(nodes, [], { nodeId: from, portId: 'result' }, { nodeId: to, portId: toPort });
    // A voice is not a picture, and a picture, a clip or a 3D model is not a voice.
    expect(can('mara', 'shot', 'reference')).toBe(false);
    for (const from of ['hero', 'other', 'model']) expect(can(from, 'shot', 'audio'), from).toBe(false);
    // Only a video node has the input.
    for (const target of ['hero', 'model', 'kade']) {
      expect(portsFor(nodes.find(item => item.id === target)!).some(port => port.id === 'audio'), target).toBe(false);
      expect(can('mara', target, 'audio'), target).toBe(false);
    }
    // A saved canvas keeps the voices, typed as their source, and drops a picture wired there.
    const document = sanitizeDocument({ version: 2, nodes, edges: [...edges, wire('hero', 'shot', 'image')], waypoints: [], view: null });
    expect(document.edges.map(edge => `${edge.fromNode}>${edge.toPort}:${edge.dataType}`)).toEqual(['mara>audio:audio', 'kade>audio:audio', 'host>audio:audio']);
  });

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
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取图像、视频与 3D 模型。');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: '视频 Agent' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '3D 模型 Agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并准备运行' })).toBeDisabled();
    view.rerender(<InspectorPanel {...props({ node: image, media: { status: 'loading' } })} />);
    expect(screen.getByText('正在读取图像、视频与 3D 模型…')).toBeInTheDocument();
    view.rerender(<InspectorPanel {...props({ node: image, media: { status: 'ready', catalogue: parseMediaCatalogue({ configured: false }) } })} />);
    expect(screen.getByText('本工作区暂未开放图像、视频与 3D 生成。')).toBeInTheDocument();
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
    // One group for every media model, each by its generic name in the reader's language, never by its maker.
    expect(screen.getByRole('group', { name: 'Media' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Kuaishou' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Video · Standard' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Kling 3.0 Pro' })).not.toBeInTheDocument();
  });

  it('shows a yes-or-no setting the catalogue adds as a checkbox, off by default and saved only once set', async () => {
    const multimodal = parseMediaCatalogue({ ...rawCatalogue, models: [{ id: 'rh.seedance-2-multimodal', name: 'Seedance 2.0 Multimodal',
      label: ['视频 · 多图参考', 'Video · From references'], vendor: 'media', kind: 'video', mode: 'multimodal-to-video', prompt: { minLength: 1, maxLength: 2000 },
      references: 9, referenceMode: 'subjects', audioReferences: 3,
      params: [{ name: 'realPersonMode', type: 'boolean', default: false, label: ['真人模式', 'Real people'] }] }] });
    expect(multimodal.models[0]).toMatchObject({ references: 9, subjectReferences: true, audioReferences: 3 });
    const node: SessionNode = { ...createSessionNode('video', { x: 0, y: 0 }), id: 'node-g', model: 'rh.seedance-2-multimodal' };
    const p = props({ node, media: { status: 'ready', catalogue: multimodal } });
    const view = render(<InspectorPanel {...p} />);
    const real = screen.getByRole('checkbox', { name: '真人模式' });
    expect(real).not.toBeChecked();
    fireEvent.click(real);
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(p.onInitialize).toHaveBeenCalledTimes(1));
    expect(p.onInitialize).toHaveBeenCalledWith(expect.objectContaining({ id: 'node-g', model: 'rh.seedance-2-multimodal', mediaParams: { realPersonMode: true } }));
    view.rerender(<LocaleProvider locale="en"><InspectorPanel {...p} /></LocaleProvider>);
    expect(screen.getByRole('checkbox', { name: 'Real people' })).toBeInTheDocument();
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

  it('says a backup model made a result, from its record, without naming any service', () => {
    const backed = mediaText('image', 'image/png').replace('"items"', '"backup":true,"items"');
    expect(parseMediaOutput(backed)?.backup).toBe(true);
    expect(parseMediaOutput(mediaText('image', 'image/png'))?.backup).toBeUndefined();
    expect(parseMediaOutput(mediaText('image', 'image/png').replace('"items"', '"backup":"yes","items"'))).toBeNull();
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const view = render(<TileTranscript mediaResults turns={[agentTurn(backed)]} history="loaded" streaming={false} />);
    expect(screen.getByRole('note')).toHaveTextContent('主通道暂不可用，这次由备用模型生成。');
    view.rerender(<TileTranscript mediaResults turns={[agentTurn(mediaText('image', 'image/png'))]} history="loaded" streaming={false} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
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

  it('says the model is thinking, from the run’s own event rather than a guess', async () => {
    // On a reasoning model the first token can be minutes away. The server sends one `thinking` event when the
    // model's reasoning actually begins; without it the node row keeps the label it falls back to, 'Sent. Waiting
    // for the agent to start…', which by then is wrong — the agent has started, and it is thinking.
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    configureSaaSCanvasSave(async () => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('operationId=')) return new Response(JSON.stringify({ items: [] }));
      if (url.endsWith('/runs')) return new Response(JSON.stringify({ id: 'run-a', sessionId: 'session-a', status: 'queued' }));
      if (url.endsWith('/events')) return new Response(['{"type":"running"}', '{"type":"reasoning_started","characters":8412}',
        '{"type":"reasoning_started","characters":9001}',
        JSON.stringify({ type: 'text_delta', delta: 'done' }), JSON.stringify({ type: 'completed', text: 'done' })].map(row => `data: ${row}\n\n`).join(''));
      throw new Error(`Unexpected ${url}`);
    }));
    const lang = document.documentElement.lang;
    document.documentElement.lang = 'zh-CN';
    let frames = '';
    try {
      const response = await canvasFetch('/gateway-api/conversations/tenant-a/agents/agent-a/messages', { method: 'POST', body: JSON.stringify({ message: 'think first', operationId: 'op-think', issueId: 'session-a' }) });
      frames = await response.text();
    } finally { document.documentElement.lang = lang; }
    expect(frames).toContain('"status":"模型正在思考…"');
    // The answer still arrives, and nothing of how much reasoning there was crosses to the page — the fixture does
    // send counts, so this assertion can actually fail.
    expect(frames).toContain('"event":"delta","text":"done"');
    expect(frames).not.toMatch(/8412|9001|characters/);
    // And the status comes down before the answer's first text, or the row under a long answer would go on saying
    // the model was thinking while the answer streamed past it.
    const rows = frames.split('\n\n').filter(Boolean).map(row => JSON.parse(row.replace(/^data: /, '')));
    const thought = rows.filter(row => row.status === '模型正在思考…');
    // Said once however many counts arrive, then put back to the run's own status — not to nothing, which is what
    // makes the transcript fall back to 'Sent. Waiting for the agent to start…'.
    const back = rows.findIndex(row => row.event === 'status' && row.status === 'running' && rows.indexOf(thought[0]) < rows.findIndex(r => r === row));
    const answered = rows.findIndex(row => row.event === 'delta' && row.text);
    expect([thought.length, back > rows.indexOf(thought[0]), back < answered]).toEqual([1, true, true]);
    expect(rows.some(row => row.event === 'status' && row.status === '')).toBe(false);
  });

  it('says when a generation moved to a backup model, and whose the states after it are', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    configureSaaSCanvasSave(async () => {});
    const record = mediaText('image', 'image/png');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('operationId=')) return new Response(JSON.stringify({ items: [] }));
      if (url.endsWith('/runs')) return new Response(JSON.stringify({ id: 'run-a', sessionId: 'session-a', status: 'queued' }));
      if (url.endsWith('/events')) return new Response(['{"type":"running"}', '{"type":"media_status","status":"queued"}', '{"type":"media_status","status":"backup"}',
        '{"type":"media_status","status":"queued"}', '{"type":"media_status","status":"running"}', '{"type":"media_status","status":"saving"}',
        JSON.stringify({ type: 'completed', text: record })].map(row => `data: ${row}\n\n`).join(''));
      throw new Error(`Unexpected ${url}`);
    }));
    const lang = document.documentElement.lang;
    document.documentElement.lang = 'zh-CN';
    let frames = '';
    try {
      const response = await canvasFetch('/gateway-api/conversations/tenant-a/agents/agent-a/messages', { method: 'POST', body: JSON.stringify({ message: 'a red bicycle', operationId: 'op-a', issueId: 'session-a' }) });
      frames = await response.text();
    } finally { document.documentElement.lang = lang; }
    const statuses = [...frames.matchAll(/"status":"([^"]+)"/g)].map(m => m[1]).filter(s => s.endsWith('…'));
    expect(statuses).toEqual(['排队等待生成…', '主通道暂不可用，已换用备用模型…', '排队等待备用模型生成…', '正在用备用模型生成…', '正在保存结果…']);
    expect(frames).toContain('"event":"done","status":"succeeded"');
  });
});

// A node is saved only with settings its model takes, so a saved setting the model refuses is one whose choices
// narrowed afterwards (an offer repointed to another generator, say). The server freezes every media node in a run's
// scope before the run starts and refuses the whole canvas for one of them, so such a node must be found before the
// run is sent, and healed where the page can heal it by itself.
describe('settings a media model no longer accepts', () => {
  // 图片 · 高清 as the offer had it when these nodes were saved, and after it was repointed to a generator whose
  // resolutions are 2K alone (2026-10-22). Its id and every other model and choice stay as they were, so nothing
  // here is a retired model: only one model's choices narrowed under nodes already holding one of them.
  const offer = (resolutions: string[]) => parseMediaCatalogue({
    configured: true, available: true, limits: { runsPerDay: 30, timeoutSeconds: 1200 },
    models: [
      { id: 'xt.seedream-5-pro', name: 'Seedream 5 Pro', label: ['图片 · 高清', 'Image · HD'], vendor: 'media', kind: 'image', mode: 'text-to-image',
        prompt: { minLength: 1, maxLength: 32000 }, params: [
          { name: 'resolution', type: 'enum', values: resolutions, default: '2K', label: ['分辨率', 'Resolution'] },
          { name: 'imageNum', type: 'integer', min: 1, max: 4, default: 1, label: ['生成张数', 'Images'] }] },
      { id: 'xt.omni-video', name: 'Omni video', label: ['视频 · 全能', 'Video · All-round'], vendor: 'media', kind: 'video', mode: 'text-to-video',
        prompt: { minLength: 1, maxLength: 2500 }, params: [
          { name: 'duration', type: 'enum', values: ['5', '10'], default: '5', label: ['时长（秒）', 'Duration (s)'] }] },
    ],
  });
  const wide = offer(['2K', '1K']);
  const narrowed = offer(['2K']);
  const bound = (id: string, title: string, kind: 'image' | 'video', model: string, mediaParams?: SessionNode['mediaParams']): SessionNode => ({
    ...createSessionNode(kind, { x: 0, y: 0 }), id, title, model, runtime: 'pi',
    binding: { companyId: 'tenant-a', agentId: `agent-${id}`, agentName: title },
    ...(mediaParams ? { mediaParams } : {}),
  });
  const poster = () => bound('img', '海报', 'image', 'xt.seedream-5-pro', { resolution: '1K', imageNum: 3 });
  const clip = () => bound('vid', '片头动画', 'video', 'xt.omni-video', { duration: '10' });

  it('refuses a run before it is sent and names every node that holds such a setting', () => {
    const nodes = [clip(), poster()];
    // Against the offer these nodes were saved under nothing is wrong, and with no catalogue to judge by (a local
    // canvas, or one not read yet) nothing is judged here: the server refuses that run and names the node itself.
    expect(preflightGraphIssue(nodes, [], undefined, { media: wide })).toBeNull();
    expect(preflightGraphIssue(nodes, [], undefined, {})).toBeNull();
    expect(preflightGraphIssue(nodes, [], undefined, { media: null })).toBeNull();
    // Against the narrowed one the node that holds the setting is named, not the other media node.
    expect(preflightGraphIssue(nodes, [], undefined, { media: narrowed })).toMatchObject({ code: 'media_params', values: { count: 1, titles: ['海报'] } });
    // Every such node at once, in canvas order, so they are fixed in one pass rather than one refusal at a time.
    const second = bound('one', '封面', 'image', 'xt.seedream-5-pro', { resolution: '1K' });
    expect(preflightGraphIssue([...nodes, second], [], undefined, { media: narrowed }))
      .toMatchObject({ code: 'media_params', values: { count: 2, titles: ['海报', '封面'] } });
    // Only the nodes that will run are judged: the same canvas run of the clip alone goes ahead.
    expect(preflightGraphIssue(nodes, [], ['vid'], { media: narrowed })).toBeNull();
    // A message typed to that node is refused too: its own Send freezes the same settings.
    expect(preflightGraphIssue(nodes, [], ['img'], { media: narrowed, conversation: true })).toMatchObject({ code: 'media_params' });
    // A model this workspace is not offered leaves its settings unjudged: there is nothing to judge them by.
    expect(preflightGraphIssue([bound('gone', '旧图', 'image', 'xt.not-offered', { resolution: '1K' })], [], undefined, { media: narrowed })).toBeNull();
    // A node that holds no settings of its own runs on the model's defaults and is never a media problem.
    expect(preflightGraphIssue([bound('plain', '插图', 'image', 'xt.seedream-5-pro')], [], undefined, { media: narrowed })).toBeNull();
  });

  // The refusal is a warning, never a change: the catalogue it is judged by is the one this page read when the canvas
  // opened, so a tab open across a release that widened a model's choices holds a stale, narrower one. Deleting a
  // setting by it would silently and permanently lose a choice the workspace accepts.
  it('leaves the canvas exactly as it is, deleting no setting a stale catalogue would refuse', () => {
    const kept = poster();
    kept.lastOutput = { text: '{"type":"awwo.media"}', at: 1, source: 'run' };
    const doc = { ...emptyDocument(), nodes: [kept, clip()] };
    for (const offer of [wide, narrowed, null]) expect(replaceRetiredMediaModels(doc, offer)).toBeNull();
    expect((doc.nodes[0] as SessionNode).mediaParams).toEqual({ resolution: '1K', imageNum: 3 });
    // And a run refused for it stays refused until the reader changes the node, rather than quietly becoming runnable.
    expect(preflightGraphIssue(doc.nodes, [], undefined, { media: narrowed })).toMatchObject({ code: 'media_params' });
  });
});

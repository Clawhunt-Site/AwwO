import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_DATA_MARKER, attachmentKind, attachmentLine, attachmentSeenBy, joinAttachments, splitAttachments } from '../src/canvas/attachments';
import { MessageWithAttachments } from '../src/canvas/ComposerAttachments';
import { mediaComposerInfo, TileComposer, type MediaComposerInfo } from '../src/canvas/TileComposer';
import { parseMediaCatalogue } from '../src/canvas/mediaCatalog';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import { portsFor } from '../src/canvas/ports';
import { CanvasAssistant, type CanvasAssistantProps } from '../src/canvas/CanvasAssistant';
import { ContractFields } from '../src/canvas/ContractFields';
import { SessionTile } from '../src/canvas/SessionTile';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import * as invalidation from '../src/canvas/invalidateOutputs';
import { CanvasUiModeProvider, type CanvasUiMode } from '../src/canvas/uiMode';
import { TileTranscript } from '../src/canvas/TileTranscript';
import type { ContractField } from '../src/canvas/nodeContracts';
import { resetAllSessions, setStreaming, type Turn } from '../src/canvas/sessions';
import { activeNodeThread, activeThreadId, getNodeThreads, selectNodeThread, updateNodeDraft, updateThreadPreview } from '../src/canvas/nodeThreads';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const ID_A = 'aUPLOADaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'aUPLOADbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A stand-in for the upload route: every request answers 201 with the next id, unless told to hold or fail. */
class FakeUpload {
  static sent: FakeUpload[] = [];
  static ids: string[] = [];
  static hold = false;
  url = ''; method = ''; body: unknown; status = 0; responseText = ''; withCredentials = false; aborted = false;
  headers: Record<string, string> = {};
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  abort() { this.aborted = true; this.onabort?.(); }
  send(body: unknown) {
    this.body = body;
    FakeUpload.sent.push(this);
    if (!FakeUpload.hold) this.finish();
  }
  finish(status = 201) {
    const file = this.body as File;
    const id = FakeUpload.ids.shift() ?? ID_A;
    this.status = status;
    this.responseText = status === 201
      ? JSON.stringify({ id, reference: `awwo-file:${id}`, name: file.name, size: file.size, contentType: file.type || 'application/octet-stream', kind: attachmentKind(file.name), inline: false })
      : JSON.stringify({ error: { code: 'upload_quota_exceeded', message: 'quota' } });
    this.onload?.();
  }
}

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  FakeUpload.sent = []; FakeUpload.ids = [ID_A, ID_B]; FakeUpload.hold = false;
  fetchMock.mockClear();
  vi.stubGlobal('XMLHttpRequest', FakeUpload);
  vi.stubGlobal('fetch', fetchMock);
  configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); resetAllSessions(); });

const deletes = () => fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'DELETE').map(call => String(call[0]));

describe('attachment lines', () => {
  it('round-trips the text a person wrote and the files it carries', () => {
    for (const body of ['', '做一张海报', '第一行\n第二行\n', '  ']) {
      const joined = joinAttachments(body, [{ id: ID_A, name: '封面.png' }, { id: ID_B, name: 'spec.docx' }], 'zh');
      const split = splitAttachments(joined);
      expect(split.body).toBe(body);
      expect(split.attachments.map(item => [item.id, item.name, item.kind])).toEqual([[ID_A, '封面.png', 'image'], [ID_B, 'spec.docx', 'document']]);
    }
    expect(joinAttachments('only words', [], 'en')).toBe('only words');
  });

  it('drops the server data block and never lets a name break its line', () => {
    const sent = `看这个\n\n${attachmentLine({ id: ID_A, name: 'a\nb · awwo-file:x.png' }, 'en')}\n\n${ATTACHMENT_DATA_MARKER}\nThe user attached…\n[{"text":"secret file text"}]`;
    const split = splitAttachments(sent);
    expect(split.body).toBe('看这个');
    expect(split.attachments).toHaveLength(1);
    expect(split.attachments[0].name).toBe('a b - x.png');
    expect(splitAttachments('a line in the middle [附件] x · awwo-file:aUPLOADaaaaaaaa\nmore').attachments).toEqual([]);
  });
});

function ComposerHost({ onSend, initial = '' }: { onSend: (text: string) => void; initial?: string }) {
  const [draft, setDraft] = useState(initial);
  return <><TileComposer streaming={false} draft={draft} onDraftChange={setDraft} onSend={onSend} attachNodeId="node-a" />
    <output data-testid="draft">{draft}</output></>;
}

describe('a media node composer', () => {
  const picture = `[附件] cat.png · awwo-file:${ID_A}`;
  const composer = (mediaNode: MediaComposerInfo) => <TileComposer streaming={false} draft={picture} onSend={vi.fn()} attachNodeId="node-a" mediaNode={mediaNode} />;

  it('says which attached picture a model uses, and which models take one when it does not', () => {
    const { rerender } = render(composer({ kind: 'model3d', references: 1, referenceModels: ['3D · 高精度'] }));
    expect(screen.getByText(/3D 模型只按这张图生成，不看文字/)).toBeInTheDocument();
    rerender(composer({ kind: 'image', references: 1, referenceModels: ['图片 · 高清'] }));
    expect(screen.getByText(/会作为参考图，按你写的文字改图/)).toBeInTheDocument();
    rerender(composer({ kind: 'image', references: 0, referenceModels: ['图片 · 高清', '图片 · 标准多张'] }));
    expect(screen.getByText('这个模型只按文字生成，附带的文件不会使用。要用参考图，请换成：图片 · 高清、图片 · 标准多张。')).toBeInTheDocument();
    rerender(composer({ kind: 'video', references: 0, referenceModels: [] }));
    expect(screen.getByText('这个节点只按你写的文字生成，附带的文件不会交给生成服务。')).toBeInTheDocument();
    rerender(composer({ kind: 'video', references: 9, referenceModels: ['视频 · 标准'] }));
    expect(screen.getByText(/它是视频的第一帧.*主体参考，最多 9 张/)).toBeInTheDocument();
    rerender(composer({ kind: 'video', references: 0, referenceModels: ['视频 · 标准'] }));
    expect(screen.getByText('这个模型只按文字生成，附带的文件不会使用。要用参考图，请换成：视频 · 标准。')).toBeInTheDocument();
    rerender(composer({ kind: 'video', references: 9, referenceModels: ['视频 · 多图参考'], subjects: true }));
    expect(screen.getByText(canvasText('zh', 'attach.mediaRefSubjects', { count: 9 }))).toBeInTheDocument();
    expect(screen.getByText(/主体参考，最多 9 张，只附一张也一样.*@Image 1/)).toBeInTheDocument();
    expect(screen.queryByText(/第一帧/)).toBeNull();
    // A model that takes voices too (M-1c): an attached MP3 or WAV is one of them, and the note says so.
    rerender(composer({ kind: 'video', references: 9, referenceModels: ['视频 · 多图参考'], subjects: true, audioReferences: 3, audioReferenceModels: ['视频 · 多图参考'] }));
    expect(screen.getByText(canvasText('zh', 'attach.mediaRefSubjectsVoices', { count: 9, voices: 3 }))).toBeInTheDocument();
    expect(screen.getByText(/附带的 MP3 或 WAV 作为声音参考（最多 3 段.*@Audio 1/)).toBeInTheDocument();
    // A video model that takes no voices keeps its note: an attached sound is not used there.
    rerender(composer({ kind: 'video', references: 9, referenceModels: ['视频 · 多图参考'], subjects: true, audioReferences: 0, audioReferenceModels: ['视频 · 多图参考'] }));
    expect(screen.getByText(canvasText('zh', 'attach.mediaRefSubjects', { count: 9 }))).toBeInTheDocument();
  });

  it('marks a model whose every picture is a subject reference, from its choice and from the catalogue', () => {
    const choices = [{ key: 'rh.seedance-2-multimodal', label: '视频 · 多图参考', available: true, references: 9, subjectReferences: true, audioReferences: 3 },
      { key: 'xt.omni-video', label: '视频 · 全能', available: true, references: 9 }];
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'video', model: 'rh.seedance-2-multimodal' }, choices))
      .toEqual({ kind: 'video', references: 9, referenceModels: ['视频 · 多图参考', '视频 · 全能'], subjects: true, audioReferences: 3, audioReferenceModels: ['视频 · 多图参考'] });
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'video', model: 'xt.omni-video' }, choices)?.subjects).toBeUndefined();
    const model = (id: string, references: unknown, referenceMode?: unknown) => ({ id, name: 'x', label: ['视频', 'Video'], vendor: 'media', kind: 'video',
      prompt: { minLength: 1, maxLength: 10 }, params: [], references, referenceMode });
    const catalogue = parseMediaCatalogue({ configured: true, available: true, models: [model('rh.a', 9, 'subjects'), model('rh.b', 9),
      model('rh.c', 0, 'subjects'), model('rh.d', 9, 'frames')] });
    expect(catalogue.models.map(m => m.subjectReferences === true)).toEqual([true, false, false, false]);
  });

  it('reads what the node model does from its choices, and only for media nodes', () => {
    const choices = [{ key: 'tripo.p1', label: '3D · 游戏低多边形', available: true, references: 1 }, { key: 'tripo.x', label: 'X', available: true }];
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'model3d', model: 'tripo.p1' }, choices)).toEqual({ kind: 'model3d', references: 1, referenceModels: ['3D · 游戏低多边形'] });
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'model3d', model: 'tripo.x' }, choices)?.references).toBe(0);
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'llm', model: 'm' }, choices)).toBeUndefined();
  });

  it('reads a model capability from the catalogue, 0 unless a whole number up to the server ceiling of 10', () => {
    const model = (references: unknown) => ({ id: 'xt.xtasy-3', name: 'x', label: ['图片', 'Image'], vendor: '媒体', kind: 'image', prompt: { minLength: 1, maxLength: 10 }, params: [], references });
    // X-tasy's video models start from up to 9 and 10 pictures (xtasy.go); the catalogue once read those as none.
    const catalogue = parseMediaCatalogue({ configured: true, available: true, models: [model(1), { ...model('2'), id: 'xt.b' }, { ...model(9), id: 'xt.c' },
      { ...model(10), id: 'xt.e' }, { ...model(11), id: 'xt.f' }, { ...model(undefined), id: 'xt.d' }] });
    expect(catalogue.models.map(m => m.references)).toEqual([1, 0, 9, 10, 0, 0]);
  });

  it('reads how many voices a model lip-syncs to from the catalogue, 0 unless a whole number up to the server ceiling of 3', () => {
    const model = (id: string, audioReferences: unknown) => ({ id, name: 'x', label: ['视频', 'Video'], vendor: '媒体', kind: 'video', prompt: { minLength: 1, maxLength: 10 },
      params: [], references: 9, audioReferences });
    const catalogue = parseMediaCatalogue({ configured: true, available: true, models: [model('rh.seedance-2-multimodal', 3), model('rh.a', 1), model('rh.b', 4),
      model('rh.c', '2'), model('rh.d', 2.5), model('rh.e', -1), model('rh.f', 0), model('rh.g', undefined)] });
    expect(catalogue.models.map(m => m.audioReferences)).toEqual([3, 1, 0, 0, 0, 0, 0, 0]);
    // A count the web cannot read costs only that count: the model and its pictures stay.
    expect(catalogue.models.map(m => m.references)).toEqual([9, 9, 9, 9, 9, 9, 9, 9]);
  });

  it('says how many voices a video node’s model lip-syncs to, and which video models take any, only on a video node', () => {
    const choices = [{ key: 'rh.seedance-2-multimodal', label: '视频 · 多图参考', available: true, references: 9, subjectReferences: true, audioReferences: 3 },
      { key: 'xt.omni-video', label: '视频 · 全能', available: true, references: 9, audioReferences: 0 }];
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'video', model: 'xt.omni-video' }, choices))
      .toMatchObject({ audioReferences: 0, audioReferenceModels: ['视频 · 多图参考'] });
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'video', model: 'xt.omni-video' }, undefined))
      .toEqual({ kind: 'video', references: 0, referenceModels: [], audioReferences: 0, audioReferenceModels: [] });
    // Only a video node has an audio input to say it of.
    for (const agentKind of ['image', 'model3d', 'audio']) {
      const info = mediaComposerInfo({ kind: 'session', agentKind, model: 'rh.seedance-2-multimodal' }, choices);
      expect(info, agentKind).not.toHaveProperty('audioReferences');
      expect(info, agentKind).not.toHaveProperty('audioReferenceModels');
    }
  });

  it('gives 3D and video nodes a reference input, as image nodes have, and text nodes none', () => {
    const ids = (agentKind: string) => portsFor({ kind: 'session', agentKind } as never).filter(p => p.side === 'input').map(p => p.id);
    expect(ids('model3d')).toEqual(['context', 'reference']);
    expect(ids('image')).toEqual(['context', 'reference']);
    expect(ids('video')).toEqual(['context', 'reference', 'audio']);
    expect(ids('llm')).not.toContain('reference');
  });
});

describe('the node composer', () => {
  it('uploads a picked file of any type, shows its chip and sends it with the words', async () => {
    const onSend = vi.fn();
    render(<ComposerHost onSend={onSend} />);
    const picker = document.querySelector('input[type=file]') as HTMLInputElement;
    expect(picker).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加文件' })).toBeEnabled();
    fireEvent.change(picker, { target: { files: [new File(['GLB'], 'robot.glb', { type: 'model/gltf-binary' })] } });
    await waitFor(() => expect(screen.getByText('robot.glb')).toBeInTheDocument());
    expect(FakeUpload.sent[0].url).toBe('/api/v1/tenants/tenant-a/canvases/canvas-a/uploads?name=robot.glb&node=node-a');
    expect(FakeUpload.sent[0].method).toBe('POST');
    // The box shows only the words; the file rides as a line at the end of the draft.
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '把这个模型放进展示页' } });
    expect(screen.getByTestId('draft').textContent).toBe(`把这个模型放进展示页\n\n[附件] robot.glb · awwo-file:${ID_A}`);
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith(`把这个模型放进展示页\n\n[附件] robot.glb · awwo-file:${ID_A}`);
    expect(screen.getByTestId('draft').textContent).toBe('');
  });

  it('takes pasted and dropped files, waits for them before sending, and deletes a chip taken back', async () => {
    FakeUpload.hold = true;
    render(<ComposerHost onSend={vi.fn()} initial="说明" />);
    const input = screen.getByTestId('composer-input');
    fireEvent.paste(input, { clipboardData: { files: [new File(['png'], 'shot.png', { type: 'image/png' })], items: [], types: ['Files'] } });
    expect(await screen.findByText('shot.png')).toBeInTheDocument();
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());
    const box = input.closest('.canvas-composer')!;
    fireEvent.drop(box, { dataTransfer: { files: [new File(['wav'], 'voice.wav', { type: 'audio/wav' })], items: [], types: ['Files'] } });
    act(() => FakeUpload.sent[1].finish());
    await waitFor(() => expect(screen.getByText('voice.wav')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '移除 shot.png' }));
    expect(screen.getByTestId('draft').textContent).toBe(`说明\n\n[附件] voice.wav · awwo-file:${ID_B}`);
    // A file taken back before it was sent is deleted from the canvas.
    expect(deletes()).toEqual([`/api/v1/tenants/tenant-a/canvases/canvas-a/uploads/${ID_A}`]);
  });

  it('says why an upload failed and keeps the words', async () => {
    FakeUpload.hold = true;
    render(<ComposerHost onSend={vi.fn()} initial="保留" />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'big.mov', { type: 'video/quicktime' })] } });
    act(() => FakeUpload.sent[0].finish(429));
    expect(await screen.findByRole('alert')).toHaveTextContent('上传失败');
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('保留');
    expect(screen.getByTestId('composer-send')).toBeEnabled();
  });

  it('keeps both of two files that land at the same moment', async () => {
    FakeUpload.hold = true;
    render(<ComposerHost onSend={vi.fn()} initial="两份" />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' })] } });
    await screen.findByText('b.png');
    act(() => { FakeUpload.sent[0].finish(); FakeUpload.sent[1].finish(); });
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(`两份\n\n[附件] a.png · awwo-file:${ID_A}\n[附件] b.png · awwo-file:${ID_B}`));
  });

  it('takes a file that lands while a reply streams at once: its draft is never locked', async () => {
    FakeUpload.hold = true;
    function Host({ streaming }: { streaming: boolean }) {
      const [draft, setDraft] = useState('');
      return <><TileComposer streaming={streaming} draft={draft} onDraftChange={setDraft} onSend={vi.fn()} attachNodeId="node-a" />
        <output data-testid="draft">{draft}</output></>;
    }
    const { rerender } = render(<Host streaming={false} />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    await screen.findByText('shot.png');
    rerender(<Host streaming />);
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(`[附件] shot.png · awwo-file:${ID_A}`));
  });

  it('offers no upload where the canvas is not a cloud canvas', () => {
    clearSaaSCanvas();
    render(<ComposerHost onSend={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '添加文件' })).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
  });
});

function assistantProps(overrides: Partial<CanvasAssistantProps> = {}): CanvasAssistantProps {
  return { mode: 'panel', messages: [], draft: '', onDraftChange: vi.fn(), busy: false, onSend: vi.fn(), onCancel: vi.fn(), ...overrides };
}

describe('the canvas assistant', () => {
  it('is a composite box: words in the field, files as chips, sent together', async () => {
    function Host({ onSend }: { onSend: () => void }) {
      const [draft, setDraft] = useState('');
      return <><CanvasAssistant {...assistantProps({ draft, onDraftChange: setDraft, onSend })} /><output data-testid="draft">{draft}</output></>;
    }
    const onSend = vi.fn();
    render(<Host onSend={onSend} />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['%PDF'], '需求.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(screen.getByText('需求.pdf')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('画布需求'), { target: { value: '按这份需求搭画布' } });
    expect(screen.getByTestId('draft').textContent).toBe(`按这份需求搭画布\n\n[附件] 需求.pdf · awwo-file:${ID_A}`);
    expect((screen.getByLabelText('画布需求') as HTMLTextAreaElement).value).toBe('按这份需求搭画布');
    fireEvent.click(screen.getByRole('button', { name: /修改画布/ }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('shows a sent message’s files as chips, not as reference lines', () => {
    const content = `参考这张图\n\n[附件] ref.png · awwo-file:${ID_A}`;
    render(<CanvasAssistant {...assistantProps({ messages: [{ id: 'm1', role: 'user', content }] })} />);
    expect(screen.getByText('参考这张图')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ref.png' })).toHaveAttribute('href', `/api/v1/tenants/tenant-a/artifacts/${ID_A}/media`);
    expect(screen.queryByText(/awwo-file:/)).toBeNull();
  });
});

describe('node inputs', () => {
  function FieldsHost({ initial }: { initial: ContractField[] }) {
    const [fields, setFields] = useState(initial);
    return <><ContractFields fields={fields} onChange={setFields} label="输入" valuesFirst /><output data-testid="raw">{JSON.stringify(fields)}</output></>;
  }
  it('uploads into a file input and keeps the file as its value', async () => {
    render(<FieldsHost initial={[{ id: 'brief', label: '素材', type: 'file', required: true, value: '' }]} />);
    expect(screen.getByText('点 + 上传文件（也可拖入），或填写文件路径、https:// 链接。')).toBeInTheDocument();
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(screen.getByText('clip.mp4')).toBeInTheDocument());
    expect(JSON.parse(screen.getByTestId('raw').textContent!)[0].value).toBe(`[附件] clip.mp4 · awwo-file:${ID_A}`);
    // Removing it from an input never deletes the file: an earlier run may have used it.
    fireEvent.click(screen.getByRole('button', { name: '移除 clip.mp4' }));
    expect(JSON.parse(screen.getByTestId('raw').textContent!)[0].value).toBe('');
    expect(deletes()).toEqual([]);
  });

  it('lets text inputs carry files too', async () => {
    render(<FieldsHost initial={[{ id: 'need', label: '需求', type: 'text', required: false, value: '做个落地页' }]} />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['a,b'], 'data.csv', { type: 'text/csv' })] } });
    await waitFor(() => expect(screen.getByText('data.csv')).toBeInTheDocument());
    expect((screen.getByLabelText('需求的值') as HTMLTextAreaElement).value).toBe('做个落地页');
    expect(JSON.parse(screen.getByTestId('raw').textContent!)[0].value).toBe(`做个落地页\n\n[附件] data.csv · awwo-file:${ID_A}`);
  });

  it('holds a file that lands while they are read-only only where their owner asks for it', async () => {
    FakeUpload.hold = true;
    const changes = vi.fn();
    const clip: ContractField = { id: 'clip', label: '素材', type: 'file', required: false, value: '' };
    const form = (readOnly: boolean, holdUploads: boolean) => <ContractFields fields={[clip]}
      onChange={changes} label="输入" valuesFirst readOnly={readOnly} holdUploads={holdUploads} />;
    for (const holdUploads of [false, true]) {
      FakeUpload.sent = []; changes.mockClear();
      const { rerender, unmount } = render(form(false, holdUploads));
      fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })] } });
      await screen.findByText('clip.mp4');
      // Read-only now (a run of their node): the file that lands then is refused as before, or waits for its 加入.
      rerender(form(true, holdUploads));
      act(() => FakeUpload.sent[0].finish());
      if (holdUploads) {
        expect(await screen.findByRole('button', { name: '加入 clip.mp4' })).toBeDisabled();
        expect(screen.getByText('已上传，可编辑时加入')).toBeVisible();
      }
      else await waitFor(() => expect(screen.queryByText('clip.mp4')).toBeNull());
      expect(changes).not.toHaveBeenCalled();
      // Editable again, an edit of the field carries no file it did not show: a refused one whose chip went (a node's
      // outputs), or one waiting for its 加入.
      rerender(form(false, holdUploads));
      fireEvent.change(screen.getByLabelText('素材的值'), { target: { value: 'docs/x.md' } });
      expect(changes.mock.lastCall![0]([clip])).toEqual([expect.objectContaining({ id: 'clip', value: 'docs/x.md' })]);
      unmount();
    }
  });

  it('lets its owner keep whether their structure is edited (so a change keeps its uploads), and shows none where it may not be', () => {
    const fields: ContractField[] = [{ id: 'need', label: '需求', type: 'text', required: false, value: '' }];
    const change = vi.fn();
    const form = (editing: boolean, structureEditable = true) => <ContractFields fields={fields} onChange={vi.fn()} label="输入" valuesFirst
      editingSchema={editing} onEditingSchemaChange={change} structureEditable={structureEditable} />;
    const { rerender } = render(form(false));
    fireEvent.click(screen.getByRole('button', { name: '编辑字段结构' }));
    expect(change).toHaveBeenLastCalledWith(true);
    expect(screen.queryByLabelText('字段 1 名称')).toBeNull();
    rerender(form(true));
    expect(screen.getByLabelText('字段 1 名称')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '完成结构编辑' }));
    expect(change).toHaveBeenLastCalledWith(false);
    rerender(form(true, false));
    expect(screen.queryByLabelText('字段 1 名称')).toBeNull();
  });
});

describe('a node’s output form', () => {
  it('takes two files that land in two fields at the same moment, from a host that takes whole nodes only, and builds on an undo after', async () => {
    FakeUpload.hold = true;
    const outputs: ContractField[] = [
      { id: 'result', label: '交付结果', type: 'markdown', required: true, value: '' },
      { id: 'notes', label: '交付说明', type: 'markdown', required: false, value: '' },
    ];
    const saves: SessionNode[] = [];
    const first: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'n', contract: { version: 1, inputs: [], outputs } };
    let put: (node: SessionNode) => void = () => {};
    function Host() {
      const [node, setNode] = useState<SessionNode>(first);
      put = setNode;
      return <NodeDeliverables node={node} readOnly={false} editorOpen onUpdateNode={next => { saves.push(next as SessionNode); setNode(next as SessionNode); }} />;
    }
    render(<Host />);
    const pickers = document.querySelectorAll('.awwo-deliverables-editor .awwo-markdown input[type=file]');
    fireEvent.change(pickers[0], { target: { files: [new File(['# a'], 'a.md', { type: 'text/markdown' })] } });
    fireEvent.change(pickers[1], { target: { files: [new File(['# b'], 'b.md', { type: 'text/markdown' })] } });
    await screen.findByText('b.md');
    // Both answers arrive before the next render: each write builds on the one before it.
    act(() => { FakeUpload.sent[0].finish(); FakeUpload.sent[1].finish(); });
    await waitFor(() => expect(screen.queryAllByText(/^上传中/)).toHaveLength(0));
    expect(saves).toHaveLength(2);
    expect(saves[1].contract!.outputs.map(field => splitAttachments(field.value).attachments.map(item => item.name))).toEqual([['a.md'], ['b.md']]);
    // The host's undo puts back the very form from before the files; the next edit builds on it, not on those writes.
    act(() => put(first));
    fireEvent.change(screen.getByLabelText('交付说明的值'), { target: { value: '见附件' } });
    expect(saves.at(-1)!.contract!.outputs.map(field => field.value)).toEqual(['', '见附件']);
  });
});

describe('the node transcript', () => {
  const turn = (text: string): Turn => ({ id: 't1', role: 'user', text, at: 1 } as Turn);
  it('shows the files a message carried and hides the quoted file data', () => {
    const sent = `总结这份文档\n\n[附件] notes.md · awwo-file:${ID_A}\n\n${ATTACHMENT_DATA_MARKER}\npolicy\n[{"text":"FILE BODY"}]`;
    render(<TileTranscript turns={[turn(sent)]} history="loaded" streaming={false} />);
    expect(screen.getByText('总结这份文档')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'notes.md' })).toHaveAttribute('href', `/api/v1/tenants/tenant-a/artifacts/${ID_A}`);
    expect(screen.queryByText(/FILE BODY/)).toBeNull();
  });
});


describe('a message whose pictures moved its run to a model that sees', () => {
  it('says which model saw them, and nothing for a message that did not move or a broken block', () => {
    const block = (items: unknown[]) => `看看这张图\n\n[附件] hero.png · awwo-file:aHero00000\n\n${ATTACHMENT_DATA_MARKER}\n说明\n${JSON.stringify(items)}\n`;
    const moved = block([{ reference: 'awwo-file:aHero00000', name: 'hero.png', kind: 'image', shown: true, seenBy: 'Claude Haiku 4.5' }]);
    expect(attachmentSeenBy(moved)).toBe('Claude Haiku 4.5');
    expect(attachmentSeenBy(block([{ name: 'hero.png', shown: true }]))).toBeUndefined();
    expect(attachmentSeenBy(`${ATTACHMENT_DATA_MARKER}\nnot json`)).toBeUndefined();
    expect(attachmentSeenBy('plain words')).toBeUndefined();
    render(<MessageWithAttachments text={moved} />);
    expect(screen.getByRole('note')).toHaveTextContent('这次换成了能看图的「Claude Haiku 4.5」来回答');
    cleanup();
    render(<MessageWithAttachments text={block([{ name: 'hero.png', shown: true }])} />);
    expect(screen.queryByRole('note')).toBeNull();
  });
});

// Seen 2026-10-20 in Chrome: an opened node's inputs closed from their own button dropped the keyboard's focus on the
// page's body, and closed any way they ended every upload in their fields, which then never landed.
describe('an opened node’s inputs', () => {
  // The general template: a file input (参考资料, `references`) and a template guide; its required task filled in.
  const templated = (): SessionNode => {
    const node = createAgentTemplate('general', { x: 0, y: 0 }, 'zh');
    return { ...node, id: 'n', contract: { ...node.contract!, inputs: node.contract!.inputs.map(field => field.id === 'brief' ? { ...field, value: '做一个关卡' } : field) } };
  };
  const updates: SessionNode[] = [];
  // Sets the hosted node from outside the tile, as the canvas's undo does.
  let setHostNode: (node: SessionNode) => void = () => {};
  function TileHost({ initial, mode = 'developer', initializeOnSend = true, inputRequest }: { initial: SessionNode; mode?: CanvasUiMode; initializeOnSend?: boolean; inputRequest?: number }) {
    const [node, setNode] = useState(initial);
    // The document's copy of the node, as the canvas keeps it (docRef): an edit applies to it at once, a part changed by
    // the card (onPatchNode) applies to it, and a result an edit makes stale is cleared as the canvas clears it.
    const live = useRef(initial);
    const save = (next: SessionNode) => {
      const doc = emptyDocument();
      const kept = invalidation.invalidateOutputs({ ...doc, nodes: [live.current] }, { ...doc, nodes: [next] }).nodes[0] as SessionNode;
      live.current = kept;
      updates.push(kept);
      setNode(kept);
    };
    setHostNode = next => { live.current = next; setNode(next); };
    return <CanvasUiModeProvider mode={mode}><SessionTile node={node} scale={1} focused initializeOnSend={initializeOnSend} onSend={vi.fn()} inputRequest={inputRequest}
      onUpdateNode={next => save(next as SessionNode)} onPatchNode={(_id, change) => save(change(live.current))} /></CanvasUiModeProvider>;
  }
  // A canvas that takes an edit only once `accept` is set (it refuses one that would clear a result a node downstream is
  // running on); every edit it is offered is in `updates`.
  let accept = false;
  function RefusingHost() {
    const [node, setNode] = useState(templated());
    const live = useRef(node);
    const offer = (next: SessionNode) => { updates.push(next); if (accept) { live.current = next; setNode(next); } };
    return <CanvasUiModeProvider mode="developer"><SessionTile node={node} scale={1} focused initializeOnSend onSend={vi.fn()}
      onUpdateNode={next => offer(next as SessionNode)} onPatchNode={(_id, change) => offer(change(live.current))} /></CanvasUiModeProvider>;
  }
  beforeEach(() => { updates.length = 0; FakeUpload.hold = true; accept = false; });
  const toggle = () => document.querySelector<HTMLButtonElement>('.awwo-input-toggle')!;
  const drawer = () => screen.queryByRole('region', { name: '输入表单' });
  const inDrawer = () => within(drawer()!);
  const held = () => document.querySelector<HTMLElement>('.awwo-input-held');
  const pick = (name = 'clip.mp4') => fireEvent.change(drawer()!.querySelector('.awwo-file-field input[type=file]')!,
    { target: { files: [new File(['mp4'], name, { type: 'video/mp4' })] } });
  const references = () => updates.at(-1)?.contract?.inputs.find(field => field.id === 'references')?.value;
  const clipLine = `[附件] clip.mp4 · awwo-file:${ID_A}`;
  const closeButton = () => inDrawer().getByRole('button', { name: '收起输入' });
  // What closed inputs come to hold, said to a screen reader (a polite live region in the chat heading).
  const spoken = () => document.querySelector('.awwo-chat-heading [aria-live=polite]')?.textContent;

  it('give the focus to the toggle that opens them again when they close from their own button', () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    closeButton().focus();
    // From the keyboard, Enter or Space on the button is its click.
    fireEvent.click(closeButton());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    // With the sessions list open, its 输入 opens them, and gets the focus back.
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表' }));
    const listInput = document.querySelector<HTMLButtonElement>('.awwo-session-input')!;
    fireEvent.click(listInput);
    closeButton().focus();
    fireEvent.click(closeButton());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(listInput);
  });

  it('leave the focus where it was when closed by a click that focused nothing, as in Safari', () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    const box = screen.getByTestId('composer-input');
    box.focus();
    fireEvent.click(closeButton());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it('give it to the message box where no toggle opens them again, else to the first control below them, else to the node menu', () => {
    // A copied case node opens on its inputs; in the simple view a node that takes none has no input toggle.
    const copied: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'c', title: '案例节点', lastOutput: { text: '完成', source: 'case', at: 1 } };
    const { unmount } = render(<TileHost initial={copied} mode="simple" />);
    expect(document.querySelector('.awwo-input-toggle')).toBeNull();
    closeButton().focus();
    fireEvent.click(closeButton());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('composer-input'));
    unmount();
    // Not set up and with no way to start it here, its message box is shut: the focus goes to its rework note's toggle.
    const reworked: SessionNode = { ...copied, taskFrame: { version: 1, source: 'manual', constraints: ['【验收返工·交付验收】交付结果没有列出检查过的文件。'], acceptanceCriteria: [] } };
    const second = render(<TileHost initial={reworked} mode="simple" initializeOnSend={false} />);
    expect(screen.getByTestId('composer-input')).toBeDisabled();
    closeButton().focus();
    fireEvent.click(closeButton());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.awwo-rework-note-toggle'));
    second.unmount();
    // With nothing below them to take it either, it goes to the node's own menu button.
    render(<TileHost initial={copied} mode="simple" initializeOnSend={false} />);
    closeButton().focus();
    fireEvent.click(closeButton());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '更多节点操作' }));
  });

  it('pass over controls the opened inputs hide, which take no focus in a browser, for the next that takes it', () => {
    // A copied case node made from a template, taking no inputs, in the simple view and with its message box shut: no
    // toggle opens its inputs again, and the first controls below them, the empty conversation's starter prompts, are
    // hidden while the inputs are open (display: none, the case intro's rule in awwo-node.css).
    const copied: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'c', title: '案例节点', templateId: 'general', lastOutput: { text: '完成', source: 'case', at: 1 } };
    render(<TileHost initial={copied} mode="simple" initializeOnSend={false} />);
    const starters = [...document.querySelectorAll<HTMLButtonElement>('.awwo-starter-prompts button')];
    expect(starters.length).toBeGreaterThan(0);
    // jsdom draws no layout, so a hidden button would still take the focus there: these refuse it, as a browser does.
    for (const button of starters) button.focus = () => {};
    closeButton().focus();
    fireEvent.click(closeButton());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '更多节点操作' }));
  });

  it.each([
    ['their own button', () => fireEvent.click(closeButton())],
    ['their toggle', () => fireEvent.click(toggle())],
    ['the template guide, which takes their place', () => fireEvent.click(screen.getByRole('button', { name: '模板指引' }))],
  ])('keep an upload going when closed from %s, and take its file when it lands', async (_how, close) => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    expect(await inDrawer().findByText('clip.mp4')).toBeVisible();
    close();
    // Closed: the fields wait hidden, without the drawer's class (so none of its layout applies), and the toggle says so.
    expect(drawer()).toBeNull();
    expect(held()).not.toBeVisible();
    expect(held()).not.toHaveClass('awwo-input-drawer');
    expect(document.querySelector('.awwo-node-chat')).not.toHaveClass('has-inputs');
    expect(toggle()).toHaveAccessibleDescription('输入：文件仍在上传');
    // Its name stays 输入 (a screen reader speaking a focused control's new name would say the state twice).
    expect(toggle()).toHaveAccessibleName('输入');
    // Described by an element of its own (its tooltip says it too, for a pointer).
    expect(document.getElementById(toggle().getAttribute('aria-describedby') ?? '')).toHaveTextContent('输入：文件仍在上传');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(FakeUpload.sent).toHaveLength(1);
    expect(FakeUpload.sent[0].aborted).toBe(false);
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(references()).toBe(clipLine));
    // The fields go once the box has said it holds nothing more (an effect after the file's render).
    await waitFor(() => expect(held()).toBeNull());
    expect(toggle()).toHaveAccessibleName('输入');
    expect(toggle()).not.toHaveAttribute('aria-describedby');
    fireEvent.click(toggle());
    expect(inDrawer().getByRole('link', { name: 'clip.mp4' })).toBeVisible();
  });

  it('hold on while any of their fields has an upload left, whichever lands first', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    fireEvent.change(drawer()!.querySelectorAll('.awwo-markdown input[type=file]')[1], { target: { files: [new File(['a,b'], 'data.csv', { type: 'text/csv' })] } });
    await inDrawer().findByText('data.csv');
    // 限制与偏好's file lands first; closed then, the inputs still hold 参考资料's upload.
    act(() => FakeUpload.sent[1].finish());
    await waitFor(() => expect(updates.at(-1)?.contract?.inputs.find(field => field.id === 'constraints')?.value).toContain('data.csv'));
    fireEvent.click(toggle());
    expect(held()).not.toBeNull();
    expect(toggle()).toHaveAccessibleDescription('输入：文件仍在上传');
    expect(FakeUpload.sent[0].aborted).toBe(false);
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(splitAttachments(references() ?? '').attachments.map(item => item.name)).toEqual(['clip.mp4']));
    await waitFor(() => expect(held()).toBeNull());
  });

  it('show the upload they hold when opened again, as it goes', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    fireEvent.click(toggle());
    act(() => FakeUpload.sent[0].upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 } as ProgressEvent));
    fireEvent.click(toggle());
    // The same upload, not a new one: its progress came in while they were closed.
    expect(inDrawer().getByText(/^上传中 25%/)).toBeVisible();
    expect(FakeUpload.sent).toHaveLength(1);
    act(() => FakeUpload.sent[0].finish());
    expect(await inDrawer().findByRole('link', { name: 'clip.mp4' })).toBeVisible();
    expect(references()).toBe(clipLine);
  });

  it('keep a failed upload until it is read, and the toggle says one failed', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    fireEvent.click(toggle());
    act(() => FakeUpload.sent[0].finish(429));
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription('输入：有文件上传失败'));
    expect(spoken()).toBe('输入：有文件上传失败');
    expect(held()).not.toBeVisible();
    expect(toggle().querySelector('.awwo-input-upload-failed')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(toggle());
    expect(inDrawer().getByRole('alert')).toHaveTextContent('上传失败');
    fireEvent.click(inDrawer().getByRole('button', { name: '关闭 clip.mp4' }));
    fireEvent.click(toggle());
    expect(held()).toBeNull();
    expect(toggle()).toHaveAccessibleName('输入');
    expect(updates.some(node => node.contract?.inputs.some(field => field.value.includes('awwo-file:')))).toBe(false);
  });

  it('keep a file that lands while the node works on its chip, for 加入 once they can be edited again, open or closed', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    // A reply streams in, so the inputs are locked: a file that lands now waits on its chip, its 加入 not yet pressable.
    act(() => { setStreaming('n', true); });
    act(() => FakeUpload.sent[0].finish());
    // Its chip says why its 加入 cannot be pressed yet (a disabled button takes no focus, so a tooltip would not do).
    expect(await inDrawer().findByText('已上传，可编辑时加入')).toBeVisible();
    const add = (name = 'clip.mp4') => inDrawer().getByRole('button', { name: `加入 ${name}` });
    expect(add()).toBeDisabled();
    // Unlocked, nothing is added behind the reader's back (it would change the inputs, which clears a run's result).
    act(() => { setStreaming('n', false); });
    expect(inDrawer().getByText('已上传，未加入')).toBeVisible();
    expect(add()).toBeEnabled();
    expect(add()).toHaveAccessibleDescription('加入会改动输入：这个节点和它后面的节点需要重新运行。');
    // Described by an element of its own, not only by its tooltip (which touch and some screen readers never show).
    expect(document.getElementById(add().getAttribute('aria-describedby') ?? '')).toHaveTextContent('加入会改动输入');
    expect(references()).toBeUndefined();
    // Pressed twice before a render (a double click), it is added once.
    const button = add();
    act(() => { button.click(); button.click(); });
    expect(references()).toBe(clipLine);
    expect(await inDrawer().findByRole('link', { name: 'clip.mp4' })).toBeVisible();
    expect(inDrawer().queryByText('已上传，未加入')).toBeNull();
    // Closed while the next one goes on: it waits hidden through the reply, and the toggle and a status say so.
    pick('cut.mp4');
    await inDrawer().findByText('cut.mp4');
    fireEvent.click(toggle());
    act(() => { setStreaming('n', true); });
    act(() => FakeUpload.sent[1].finish());
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription('输入：有文件等待加入'));
    expect(toggle().querySelector('.awwo-attachment-spin')).toBeNull();
    expect(spoken()).toBe('输入：有文件等待加入');
    act(() => { setStreaming('n', false); });
    expect(held()).not.toBeNull();
    expect(splitAttachments(references()!).attachments.map(item => item.name)).toEqual(['clip.mp4']);
    fireEvent.click(toggle());
    fireEvent.click(add('cut.mp4'));
    expect(splitAttachments(references()!).attachments.map(item => item.name)).toEqual(['clip.mp4', 'cut.mp4']);
    await waitFor(() => expect(inDrawer().queryByText('已上传，未加入')).toBeNull());
    fireEvent.click(toggle());
    expect(held()).toBeNull();
    expect(spoken()).toBe('');
  });

  it('keep a file whose upload outlasted a lock on its chip too: a run may have gone by without it', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    fireEvent.click(toggle());
    // A reply streams and ends while the file still uploads; it lands after, with the inputs editable again.
    act(() => { setStreaming('n', true); });
    act(() => { setStreaming('n', false); });
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription('输入：有文件等待加入'));
    expect(spoken()).toBe('输入：有文件等待加入');
    expect(references()).toBeUndefined();
    fireEvent.click(toggle());
    fireEvent.click(inDrawer().getByRole('button', { name: '加入 clip.mp4' }));
    expect(references()).toBe(clipLine);
  });

  it('keep a file on its chip when the canvas refuses it as it lands, and hand the focus on when 加入 adds it', async () => {
    render(<RefusingHost />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    act(() => FakeUpload.sent[0].finish());
    // It was tried at once and refused: the file stays on its chip, 加入 ready, and closed inputs keep it.
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(await inDrawer().findByText('已上传，未加入')).toBeVisible();
    fireEvent.click(toggle());
    expect(held()).not.toBeNull();
    expect(toggle()).toHaveAccessibleDescription('输入：有文件等待加入');
    // Accepted later, 加入 from the keyboard adds it, and the focus goes to the added file, not to the page's body.
    accept = true;
    fireEvent.click(toggle());
    const add = inDrawer().getByRole('button', { name: '加入 clip.mp4' });
    add.focus();
    fireEvent.click(add);
    expect(document.activeElement).toBe(inDrawer().getByRole('link', { name: 'clip.mp4' }));
    expect(inDrawer().queryByText('已上传，未加入')).toBeNull();
  });

  it('add a file the canvas refused only with its 加入: not with an edit of its field, nor with taking another file out', async () => {
    render(<RefusingHost />);
    fireEvent.click(toggle());
    accept = true;
    pick('cut.mp4');
    await inDrawer().findByText('cut.mp4');
    act(() => FakeUpload.sent[0].finish());
    expect(await inDrawer().findByRole('link', { name: 'cut.mp4' })).toBeVisible();
    // The next file is refused as it lands, and again by the keyboard's 加入.
    accept = false;
    pick('clip.mp4');
    await inDrawer().findByText('clip.mp4');
    act(() => FakeUpload.sent[1].finish());
    const add = await inDrawer().findByRole('button', { name: '加入 clip.mp4' });
    add.focus();
    fireEvent.click(add);
    // Editable again: typing in the field, or taking cut.mp4 out, leaves clip.mp4 waiting, and the focus where it went.
    accept = true;
    const text = inDrawer().getByLabelText('参考资料的值');
    text.focus();
    fireEvent.change(text, { target: { value: 'docs/关卡素材.md' } });
    expect(splitAttachments(references() ?? '').attachments.map(item => item.name)).toEqual(['cut.mp4']);
    expect(document.activeElement).toBe(text);
    fireEvent.click(inDrawer().getByRole('button', { name: '移除 cut.mp4' }));
    expect(splitAttachments(references() ?? '')).toEqual({ body: 'docs/关卡素材.md', attachments: [] });
    expect(inDrawer().getByText('已上传，未加入')).toBeVisible();
    fireEvent.click(inDrawer().getByRole('button', { name: '加入 clip.mp4' }));
    expect(splitAttachments(references() ?? '').attachments.map(item => item.name)).toEqual(['clip.mp4']);
  });

  it('keep a waiting file on its chip when adding it is refused, to try again', async () => {
    // The canvas refuses the edit (as it does one that would clear a result a node downstream is running on).
    const refused = vi.fn();
    render(<CanvasUiModeProvider mode="developer"><SessionTile node={templated()} scale={1} focused initializeOnSend onSend={vi.fn()} onUpdateNode={refused} /></CanvasUiModeProvider>);
    fireEvent.click(toggle());
    pick('kept.mp4');
    await inDrawer().findByText('kept.mp4');
    act(() => { setStreaming('n', true); });
    act(() => FakeUpload.sent[0].finish());
    await inDrawer().findByText('已上传，可编辑时加入');
    act(() => { setStreaming('n', false); });
    fireEvent.click(inDrawer().getByRole('button', { name: '加入 kept.mp4' }));
    expect(refused).toHaveBeenCalledTimes(1);
    expect(inDrawer().getByRole('button', { name: '加入 kept.mp4' })).toBeEnabled();
    fireEvent.click(toggle());
    expect(held()).not.toBeNull();
  });

  it('take two files that land in two fields at the same moment, neither dropping the other', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    fireEvent.change(drawer()!.querySelectorAll('.awwo-markdown input[type=file]')[1], { target: { files: [new File(['a,b'], 'data.csv', { type: 'text/csv' })] } });
    await inDrawer().findByText('data.csv');
    // Both answers arrive before the next render: each field's write builds on the other's.
    act(() => { FakeUpload.sent[0].finish(); FakeUpload.sent[1].finish(); });
    await waitFor(() => expect(inDrawer().queryAllByText(/^上传中/)).toHaveLength(0));
    const inputs = updates.at(-1)!.contract!.inputs;
    expect(splitAttachments(inputs.find(field => field.id === 'references')!.value).attachments.map(item => item.name)).toEqual(['clip.mp4']);
    expect(splitAttachments(inputs.find(field => field.id === 'constraints')!.value).attachments.map(item => item.name)).toEqual(['data.csv']);
  });

  it('take two files picked together into one field, answered at the same moment, both', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    fireEvent.change(drawer()!.querySelector('.awwo-file-field input[type=file]')!,
      { target: { files: [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' }), new File(['mp4'], 'cut.mp4', { type: 'video/mp4' })] } });
    await inDrawer().findByText('cut.mp4');
    act(() => { FakeUpload.sent[0].finish(); FakeUpload.sent[1].finish(); });
    await waitFor(() => expect(splitAttachments(references() ?? '').attachments.map(item => item.name)).toEqual(['clip.mp4', 'cut.mp4']));
    // Neither waits for 加入: no lock came.
    expect(inDrawer().queryByText('已上传，未加入')).toBeNull();
    fireEvent.click(toggle());
    expect(held()).toBeNull();
  });

  it.each([
    ['the output’s first', [1, 0]],
    ['the input’s first', [0, 1]],
  ])('keep an input’s file and an output’s that land at the same moment, %s, the inputs closed, and let the result they make stale go', async (_order, order) => {
    // The node holds a result published by hand, which the canvas clears once an input changes.
    render(<TileHost initial={{ ...templated(), lastOutput: { text: JSON.stringify({ result: '已交付关卡说明。', followups: '' }), at: 1, source: 'manual' } }} />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    fireEvent.click(toggle());
    expect(held()).not.toBeNull();
    // Meanwhile a file is picked into the outputs editor (交付物 → 编辑输出表单, open by itself beside a result), into 交付结果.
    const openDeliverables = screen.queryByRole('button', { name: '展开交付物' });
    if (openDeliverables) fireEvent.click(openDeliverables);
    const editor = [...document.querySelectorAll('.awwo-deliverables-editor')].find(element => element.querySelector('.awwo-contract-fields'))!;
    fireEvent.change(editor.querySelector('.awwo-markdown input[type=file]')!, { target: { files: [new File(['# out'], 'out.md', { type: 'text/markdown' })] } });
    await within(editor as HTMLElement).findByText('out.md');
    // Both answers arrive before the next render; each owner's write is built from that render's node.
    act(() => { for (const index of order) FakeUpload.sent[index].finish(); });
    await waitFor(() => expect(held()).toBeNull());
    const saved = updates.at(-1)!;
    expect(splitAttachments(saved.contract!.inputs.find(field => field.id === 'references')!.value).attachments.map(item => item.name)).toEqual(['clip.mp4']);
    expect(splitAttachments(saved.contract!.outputs.find(field => field.id === 'result')!.value).attachments.map(item => item.name)).toEqual(['out.md']);
    // Cleared by the input's change, and not brought back by the other write as if it had been published again.
    expect(saved.lastOutput ?? null).toBeNull();
    // The delivery drawer that opened by itself beside the result is held open at the delivery's share whichever lands
    // first: the input's change keeps it as an edit of the inputs does, keyed to the output form the document holds.
    expect(saved).not.toHaveProperty('deliverablesOpen');
    expect(screen.getByRole('region', { name: '交付物' })).toBeTruthy();
    const tile = screen.getByTestId('canvas-tile-n');
    expect([tile.dataset.content, tile.style.getPropertyValue('--awwo-drawer-width')]).toEqual(['delivery', '52%']);
  });

  // A file's answer comes in a task of its own and the render that draws it in a later one, so a click can come between
  // them, its handler reading the node that render drew. Here the answer's write is made (a timer waited, so however many
  // steps the answer takes; checked: one more write) and the click comes before the render (both inside one act, which
  // holds every render until it ends).
  const names = (value: string | undefined) => splitAttachments(value ?? '').attachments.map(item => item.name);
  const input = (node: SessionNode | undefined, id: string) => node?.contract?.inputs.find(field => field.id === id);
  const clickAfterAnswer = (index: number, click: () => void, writes = () => updates.length) => act(async () => {
    const before = writes();
    FakeUpload.sent[index].finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes()).toBe(before + 1);
    click();
  });

  it.each([
    ['is added', () => fireEvent.click(inDrawer().getByRole('button', { name: '添加字段' })), 4],
    ['is taken out', () => fireEvent.click(inDrawer().getByRole('button', { name: '删除限制与偏好' })), 2],
  ])('keep a file that lands as a field %s before its render', async (_how, click, count) => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    fireEvent.click(inDrawer().getByRole('button', { name: '编辑字段结构' }));
    pick();
    await inDrawer().findByText('clip.mp4');
    await clickAfterAnswer(0, click);
    const inputs = updates.at(-1)!.contract!.inputs;
    expect(inputs).toHaveLength(count);
    expect(names(input(updates.at(-1), 'references')?.value)).toEqual(['clip.mp4']);
    expect(await inDrawer().findByRole('link', { name: 'clip.mp4' })).toBeVisible();
  });

  it('keep a file the canvas refused in one field out of another field’s write before the next render: it waits for its 加入', async () => {
    render(<RefusingHost />);
    fireEvent.click(toggle());
    pick();
    fireEvent.change(drawer()!.querySelectorAll('.awwo-markdown input[type=file]')[1], { target: { files: [new File(['a,b'], 'data.csv', { type: 'text/csv' })] } });
    await inDrawer().findByText('data.csv');
    // 参考资料's file is refused as it lands; then the canvas takes edits again, and 限制与偏好's lands, before a render.
    await act(async () => {
      FakeUpload.sent[0].finish();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(updates).toHaveLength(1);
      accept = true;
      FakeUpload.sent[1].finish();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(updates).toHaveLength(2);
    expect(names(input(updates[1], 'constraints')?.value)).toEqual(['data.csv']);
    expect(names(input(updates[1], 'references')?.value)).toEqual([]);
    expect(inDrawer().getByText('已上传，未加入')).toBeVisible();
    expect(inDrawer().getByRole('button', { name: '加入 clip.mp4' })).toBeEnabled();
  });

  it('keep an output’s file that lands as a requirement is added to the output form before its render', async () => {
    render(<TileHost initial={templated()} />);
    const openDeliverables = screen.queryByRole('button', { name: '展开交付物' });
    if (openDeliverables) fireEvent.click(openDeliverables);
    fireEvent.click(screen.getByText('添加交付要求'));
    const editor = [...document.querySelectorAll('.awwo-deliverables-editor')].find(element => element.querySelector('.awwo-contract-fields'))!;
    fireEvent.change(editor.querySelector('.awwo-markdown input[type=file]')!, { target: { files: [new File(['# out'], 'out.md', { type: 'text/markdown' })] } });
    await within(editor as HTMLElement).findByText('out.md');
    await clickAfterAnswer(0, () => fireEvent.click(screen.getByRole('button', { name: '添加到交付' })));
    const outputs = updates.at(-1)!.contract!.outputs;
    expect(names(outputs.find(field => field.id === 'result')?.value)).toEqual(['out.md']);
    expect(outputs.map(field => field.id)).toEqual(['result', 'followups', 'delivery_web']);
  });

  it('keep the delivery drawer open through an output’s file and an edit of another output made before the next render', async () => {
    // A node that has delivered from a run, its drawer open by itself beside the conversation (deliverablesShown); an
    // edit of its output form takes that delivery back (invalidateOutputs) and holds the drawer open while it lasts.
    const delivered = { ...templated(), lastOutput: { text: JSON.stringify({ result: '已交付关卡说明。', followups: '' }), at: 1, source: 'run' as const } };
    render(<TileHost initial={{ ...delivered, threads: getNodeThreads(delivered) }} />);
    const drawer = screen.getByRole('region', { name: '交付物' });
    fireEvent.click(within(drawer).getByText('编辑输出表单'));
    fireEvent.change(within(drawer).getByLabelText('交付结果的值').closest('.awwo-markdown')!.querySelector('input[type=file]')!,
      { target: { files: [new File(['# out'], 'out.md', { type: 'text/markdown' })] } });
    await within(drawer).findByText('out.md');
    await clickAfterAnswer(0, () => fireEvent.change(within(drawer).getByLabelText('后续事项的值'), { target: { value: '下一步：联调' } }));
    const saved = updates.at(-1)!;
    expect(saved.lastOutput ?? null).toBeNull();
    expect(names(saved.contract!.outputs.find(field => field.id === 'result')?.value)).toEqual(['out.md']);
    expect(saved.contract!.outputs.find(field => field.id === 'followups')?.value).toBe('下一步：联调');
    // The edit in progress is the form as the node holds it, the file in it: the drawer and its editor stay.
    expect(screen.getByRole('region', { name: '交付物' })).toBe(drawer);
    expect(within(drawer).getByText('编辑输出表单').closest('details')).toHaveAttribute('open');
  });

  it.each([
    ['a new conversation', false, '新建 Session'],
    ['an earlier conversation', true, '打开 对话 1'],
  ])('open %s from the node the document holds, not the one this render drew: a file that landed, a preview and a draft the canvas wrote', async (_what, earlier, target) => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表' }));
    if (earlier) {
      fireEvent.click(screen.getByRole('button', { name: '新建 Session' }));
      expect(getNodeThreads(updates.at(-1)!)).toHaveLength(2);
    }
    const left = activeThreadId(updates.at(-1) ?? templated());
    fireEvent.click(document.querySelector<HTMLButtonElement>('.awwo-session-input')!);
    pick();
    await inDrawer().findByText('clip.mp4');
    await clickAfterAnswer(0, () => {
      // Meanwhile the canvas writes the conversation's preview line, as a reply's text comes in, and a draft into it (as
      // another tab's document brings one): this box never changed that draft, so it keeps the canvas's.
      setHostNode(updateNodeDraft(updateThreadPreview(updates.at(-1)!, left, '关卡草图已收到'), '另一页写下的草稿', left));
      fireEvent.click(screen.getByRole('button', { name: target }));
    });
    const saved = updates.at(-1)!;
    expect(activeThreadId(saved)).not.toBe(left);
    expect(getNodeThreads(saved)).toHaveLength(2);
    expect(names(input(saved, 'references')?.value)).toEqual(['clip.mp4']);
    expect(getNodeThreads(saved).find(thread => thread.id === left)).toMatchObject({ preview: '关卡草图已收到', draft: '另一页写下的草稿' });
  });

  it('keep a file that lands in the message box as another conversation opens before its render, in the conversation it went to', async () => {
    // As the canvas: the box's drafts are saved to the node as its document holds it (persistDraft), the card's changes too.
    const saves: SessionNode[] = [];
    function DraftHost() {
      const [node, setNode] = useState(templated());
      const live = useRef(node);
      const save = (next: SessionNode) => { live.current = next; saves.push(next); setNode(next); };
      return <CanvasUiModeProvider mode="developer"><SessionTile node={node} scale={1} focused initializeOnSend onSend={vi.fn()}
        onUpdateNode={next => save(next as SessionNode)} onPatchNode={(_id, change) => save(change(live.current))}
        onDraftChange={(_id, thread, draft) => save(updateNodeDraft(live.current, draft, thread))} /></CanvasUiModeProvider>;
    }
    render(<DraftHost />);
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表' }));
    fireEvent.change(screen.getByTestId('composer-input').closest('.canvas-composer')!.querySelector('input[type=file]')!,
      { target: { files: [new File(['png'], 'map.png', { type: 'image/png' })] } });
    await screen.findByText('map.png');
    // The file goes into the box's draft, saved at once; the click's handler runs before the render that draws it.
    await clickAfterAnswer(0, () => fireEvent.click(screen.getByRole('button', { name: '新建 Session' })), () => saves.length);
    const threads = getNodeThreads(saves.at(-1)!);
    expect(threads).toHaveLength(2);
    expect(names(threads.find(thread => thread.id === 'default')?.draft)).toEqual(['map.png']);
  });

  it.each([
    ['a keystroke in the message box', () => fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '先看参考资料' } }),
      (saved: SessionNode) => expect(activeNodeThread(saved).draft).toBe('先看参考资料')],
    ['the delivery drawer opened', () => fireEvent.click(screen.getByRole('button', { name: '展开交付物' })),
      (saved: SessionNode) => expect(saved.deliverablesOpen).toBe(true)],
  ])('keep a file that lands in the inputs as %s before its render, where the canvas does not handle it itself', async (_what, act2, check) => {
    // TileHost passes neither onDraftChange nor onToggleDeliverables: the tile writes the draft and the drawer itself.
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    await clickAfterAnswer(0, act2);
    const saved = updates.at(-1)!;
    check(saved);
    expect(names(input(saved, 'references')?.value)).toEqual(['clip.mp4']);
  });

  it('take two files that land in two fields at the same moment from a host that takes whole nodes only, and build on an undo after', async () => {
    // Without onPatchNode the tile writes whole nodes: each built on the ones made since its render.
    const saves: SessionNode[] = [];
    const first = templated();
    let put: (node: SessionNode) => void = () => {};
    function WholeNodeHost() {
      const [node, setNode] = useState(first);
      put = setNode;
      return <CanvasUiModeProvider mode="developer"><SessionTile node={node} scale={1} focused initializeOnSend onSend={vi.fn()}
        onUpdateNode={next => { saves.push(next as SessionNode); setNode(next as SessionNode); }} /></CanvasUiModeProvider>;
    }
    render(<WholeNodeHost />);
    fireEvent.click(toggle());
    pick();
    fireEvent.change(drawer()!.querySelectorAll('.awwo-markdown input[type=file]')[1], { target: { files: [new File(['a,b'], 'data.csv', { type: 'text/csv' })] } });
    await inDrawer().findByText('data.csv');
    act(() => { FakeUpload.sent[0].finish(); FakeUpload.sent[1].finish(); });
    await waitFor(() => expect(inDrawer().queryAllByText(/^上传中/)).toHaveLength(0));
    expect(saves).toHaveLength(2);
    expect(names(input(saves[1], 'references')?.value)).toEqual(['clip.mp4']);
    expect(names(input(saves[1], 'constraints')?.value)).toEqual(['data.csv']);
    // The host's undo puts back the very node from before the files; the next edit builds on it, not on those writes.
    act(() => put(first));
    fireEvent.change(inDrawer().getByLabelText('参考资料的值'), { target: { value: 'docs/关卡素材.md' } });
    expect(input(saves.at(-1), 'references')?.value).toBe('docs/关卡素材.md');
    expect(names(input(saves.at(-1), 'constraints')?.value)).toEqual([]);
  });

  it('build no change on one a host that takes whole nodes refused and drew nothing for', () => {
    // The host takes changes only once `accept` is set, and draws nothing for one it refuses.
    const offered: SessionNode[] = [];
    function RefusingWholeNodeHost() {
      const [node, setNode] = useState(templated());
      return <CanvasUiModeProvider mode="developer"><SessionTile node={node} scale={1} focused initializeOnSend onSend={vi.fn()}
        onUpdateNode={next => { offered.push(next as SessionNode); if (accept) setNode(next as SessionNode); }} /></CanvasUiModeProvider>;
    }
    render(<RefusingWholeNodeHost />);
    fireEvent.click(toggle());
    fireEvent.click(inDrawer().getByRole('button', { name: '编辑字段结构' }));
    fireEvent.click(inDrawer().getByRole('button', { name: '添加字段' }));
    expect(offered.at(-1)!.contract!.inputs).toHaveLength(4);
    accept = true;
    fireEvent.change(inDrawer().getByLabelText('任务要求的值'), { target: { value: '做两个关卡' } });
    expect(offered.at(-1)!.contract!.inputs).toHaveLength(3);
    expect(input(offered.at(-1), 'brief')?.value).toBe('做两个关卡');
  });

  it('keep the draft in its box with its conversation when another opens, where the host saves no draft as it is typed', () => {
    // The host hears each draft (onDraftChange) and keeps none of them in the node: the switch saves the box's.
    render(<CanvasUiModeProvider mode="developer"><SessionTile node={templated()} scale={1} focused initializeOnSend onSend={vi.fn()}
      onUpdateNode={next => updates.push(next as SessionNode)} onDraftChange={vi.fn()} /></CanvasUiModeProvider>);
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表' }));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '先看参考资料' } });
    expect(updates).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '新建 Session' }));
    expect(getNodeThreads(updates.at(-1)!).find(thread => thread.id === 'default')?.draft).toBe('先看参考资料');
  });

  it('leave the draft in its box with the conversation the box showed, when the canvas changed conversations before the render', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表' }));
    fireEvent.click(screen.getByRole('button', { name: '新建 Session' }));
    const second = activeThreadId(updates.at(-1)!);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '第二个对话的草稿' } });
    await act(async () => {
      // The canvas goes back to Session 1 (an undo, another tab's document); the reader still sees Session 2.
      setHostNode(selectNodeThread(updates.at(-1)!, 'default'));
      fireEvent.click(screen.getByRole('button', { name: '新建 Session' }));
    });
    const threads = getNodeThreads(updates.at(-1)!);
    expect(threads).toHaveLength(3);
    expect(threads.find(thread => thread.id === second)?.draft).toBe('第二个对话的草稿');
    expect(threads.find(thread => thread.id === 'default')?.draft ?? '').toBe('');
  });

  it('bring back no file an undo took out of a field: the next edit there builds on what the undo left', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    act(() => FakeUpload.sent[0].finish());
    expect(await inDrawer().findByRole('link', { name: 'clip.mp4' })).toBeVisible();
    // The canvas's undo puts back the node from before the file; then the reader types in the same field.
    act(() => setHostNode(templated()));
    expect(inDrawer().queryByRole('link', { name: 'clip.mp4' })).toBeNull();
    fireEvent.change(inDrawer().getByLabelText('参考资料的值'), { target: { value: 'docs/关卡素材.md' } });
    expect(splitAttachments(references() ?? '')).toEqual({ body: 'docs/关卡素材.md', attachments: [] });
  });

  it('name every state they hold when closed, and speak a failure while another file still uploads', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    fireEvent.change(drawer()!.querySelectorAll('.awwo-markdown input[type=file]')[1], { target: { files: [new File(['a,b'], 'data.csv', { type: 'text/csv' })] } });
    await inDrawer().findByText('data.csv');
    fireEvent.click(toggle());
    act(() => FakeUpload.sent[1].finish(429));
    // One still uploads, one failed: the description says both, the icon marks the failure, the live region speaks it.
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription('输入：文件仍在上传，有文件上传失败'));
    expect(toggle().querySelector('.awwo-input-upload-failed')).not.toBeNull();
    expect(spoken()).toBe('输入：有文件上传失败');
    // The other lands during a reply, so it waits for 加入: waiting and failed, both said.
    act(() => { setStreaming('n', true); });
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription('输入：有文件等待加入，有文件上传失败'));
    expect(spoken()).toBe('输入：有文件等待加入，有文件上传失败');
  });

  it('name the states in English too, in words true of one file or several', async () => {
    render(<LocaleProvider locale="en"><TileHost initial={templated()} /></LocaleProvider>);
    fireEvent.click(toggle());
    const form = screen.getByRole('region', { name: 'Input form' });
    fireEvent.change(form.querySelector('.awwo-file-field input[type=file]')!, { target: { files: [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })] } });
    fireEvent.change(form.querySelectorAll('.awwo-markdown input[type=file]')[1], { target: { files: [new File(['a,b'], 'data.csv', { type: 'text/csv' })] } });
    await within(form).findByText('data.csv');
    fireEvent.click(toggle());
    act(() => FakeUpload.sent[1].finish(429));
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription('Input: file(s) still uploading, upload(s) failed'));
    expect(toggle()).toHaveAccessibleName('Input');
    expect(spoken()).toBe('Input: upload(s) failed');
    act(() => { setStreaming('n', true); });
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription('Input: file(s) waiting to be added, upload(s) failed'));
  });

  it('pull no focus later when a 加入 pressed from the keyboard was refused', async () => {
    render(<RefusingHost />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    act(() => FakeUpload.sent[0].finish());
    await inDrawer().findByText('已上传，未加入');
    const add = inDrawer().getByRole('button', { name: '加入 clip.mp4' });
    add.focus();
    fireEvent.click(add);
    expect(inDrawer().getByText('已上传，未加入')).toBeVisible();
    // The reader moves on to type elsewhere; later a click that focused nothing (as in Safari) adds the file.
    const box = screen.getByTestId('composer-input');
    box.focus();
    accept = true;
    fireEvent.click(inDrawer().getByRole('button', { name: '加入 clip.mp4' }));
    expect(inDrawer().getByRole('link', { name: 'clip.mp4' })).toBeVisible();
    expect(document.activeElement).toBe(box);
  });

  it('add only the file whose 加入 is pressed, and move no focus for a click that focused nothing, after a refused 加入 from the keyboard', async () => {
    render(<RefusingHost />);
    fireEvent.click(toggle());
    fireEvent.change(drawer()!.querySelector('.awwo-file-field input[type=file]')!,
      { target: { files: [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' }), new File(['mp4'], 'cut.mp4', { type: 'video/mp4' })] } });
    await inDrawer().findByText('cut.mp4');
    act(() => { FakeUpload.sent[0].finish(); FakeUpload.sent[1].finish(); });
    await waitFor(() => expect(inDrawer().getAllByText('已上传，未加入')).toHaveLength(2));
    const add = (name: string) => inDrawer().getByRole('button', { name: `加入 ${name}` });
    add('clip.mp4').focus();
    fireEvent.click(add('clip.mp4'));
    // Then a mouse press in Safari, whose buttons take no focus from a click: the focus leaves for the page's body first.
    add('clip.mp4').blur();
    accept = true;
    fireEvent.click(add('cut.mp4'));
    expect(inDrawer().getByRole('link', { name: 'cut.mp4' })).toBeVisible();
    expect(splitAttachments(references() ?? '').attachments.map(item => item.name)).toEqual(['cut.mp4']);
    expect(add('clip.mp4')).toBeEnabled();
    expect(document.activeElement).toBe(document.body);
  });

  it('keep an upload they hold when a run asks for them, or the template guide opens their structure', async () => {
    const { rerender } = render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    pick();
    await inDrawer().findByText('clip.mp4');
    fireEvent.click(toggle());
    expect(held()).not.toBeNull();
    // Still uploading is said by the toggle's name; the live region speaks only what comes after.
    expect(spoken()).toBe('');
    // A run that needs them opens them on their values: the same upload.
    rerender(<TileHost initial={templated()} inputRequest={1} />);
    expect(inDrawer().getByText('clip.mp4')).toBeVisible();
    // Closed again, then opened on their structure from the template guide: still the same upload.
    fireEvent.click(screen.getByRole('button', { name: '模板指引' }));
    expect(held()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: canvasText('zh', 'template.editInputsLabel') }));
    expect(inDrawer().getByRole('button', { name: '完成结构编辑' })).toBeTruthy();
    expect(inDrawer().getByText('clip.mp4')).toBeVisible();
    expect(FakeUpload.sent.map(upload => upload.aborted)).toEqual([false]);
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(references()).toBe(clipLine));
  });

  it('change between values and their structure without ending an upload', async () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(screen.getByRole('button', { name: '模板指引' }));
    fireEvent.click(screen.getByRole('button', { name: canvasText('zh', 'template.editInputsLabel') }));
    pick();
    await inDrawer().findByText('clip.mp4');
    fireEvent.click(inDrawer().getByRole('button', { name: '完成结构编辑' }));
    fireEvent.click(inDrawer().getByRole('button', { name: '编辑字段结构' }));
    // Closed in their structure and opened the ordinary way, they show values again: still the same upload.
    fireEvent.click(closeButton());
    fireEvent.click(toggle());
    expect(inDrawer().getByRole('button', { name: '编辑字段结构' })).toBeTruthy();
    expect(inDrawer().getByText('clip.mp4')).toBeVisible();
    expect(FakeUpload.sent.map(upload => upload.aborted)).toEqual([false]);
    act(() => FakeUpload.sent[0].finish());
    await waitFor(() => expect(references()).toBe(clipLine));
  });
});

// The same race on the canvas itself (CanvasSurface's onPatchNode, its invalidateOutputs and its saved document), not
// through a test host's stand-in for it.
describe('the canvas, saving an opened node’s inputs and deliverables', () => {
  beforeEach(() => {
    localStorage.clear();
    FakeUpload.hold = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
  });
  const saved = () => (JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes[0] as SessionNode;
  const names = (value: string | undefined) => splitAttachments(value ?? '').attachments.map(item => item.name);

  it.each([
    ['the output’s first', [1, 0]],
    ['the input’s first', [0, 1]],
  ])('keep an input’s file and an output’s that land at the same moment, %s, and the result they make stale cleared', async (_order, order) => {
    const general = createAgentTemplate('general', { x: 0, y: 0 }, 'zh');
    const node: SessionNode = { ...general, id: 'n', contract: { ...general.contract!, inputs: general.contract!.inputs.map(field => field.id === 'brief' ? { ...field, value: '做一个关卡' } : field) },
      lastOutput: { text: JSON.stringify({ result: '已交付关卡说明。', followups: '' }), at: 1, source: 'manual' } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node] }));
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: `打开 ${node.title}`, exact: true }));
    // Opened, and its camera's glide (260 ms) landed: a card still opening may draw its body anew, which ends an upload.
    const tile = await screen.findByTestId('canvas-tile-n');
    await waitFor(() => expect(tile.dataset.lod).toBe('focus'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    const toggle = await waitFor(() => { const found = document.querySelector<HTMLButtonElement>('.awwo-input-toggle'); expect(found).not.toBeNull(); return found!; });
    fireEvent.click(toggle);
    fireEvent.change(document.querySelector('.awwo-input-drawer .awwo-file-field input[type=file]')!, { target: { files: [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })] } });
    await screen.findByText('clip.mp4');
    fireEvent.click(toggle);
    expect(document.querySelector('.awwo-input-held')).not.toBeNull();
    const openDeliverables = screen.queryByRole('button', { name: '展开交付物' });
    if (openDeliverables) fireEvent.click(openDeliverables);
    const editor = [...document.querySelectorAll('.awwo-deliverables-editor')].find(element => element.querySelector('.awwo-contract-fields'))!;
    fireEvent.change(editor.querySelector('.awwo-markdown input[type=file]')!, { target: { files: [new File(['# out'], 'out.md', { type: 'text/markdown' })] } });
    await within(editor as HTMLElement).findByText('out.md');
    expect(FakeUpload.sent.map(upload => upload.aborted)).toEqual([false, false]);
    act(() => { for (const index of order) FakeUpload.sent[index].finish(); });
    await waitFor(() => {
      const kept = saved();
      expect(names(kept.contract!.inputs.find(field => field.id === 'references')!.value)).toEqual(['clip.mp4']);
      expect(names(kept.contract!.outputs.find(field => field.id === 'result')!.value)).toEqual(['out.md']);
      expect(kept.lastOutput ?? null).toBeNull();
    }, { timeout: 4000 });
    // The delivery drawer that opened by itself beside the result is held open at the delivery's share whichever lands
    // first, nothing recorded about it.
    expect(saved()).not.toHaveProperty('deliverablesOpen');
    const opened = screen.getByTestId('canvas-tile-n');
    expect(within(opened).getByRole('region', { name: '交付物' })).toBeTruthy();
    expect([opened.dataset.content, opened.style.getPropertyValue('--awwo-drawer-width')]).toEqual(['delivery', '52%']);
  });

  it.each([
    ['another conversation opens', '新建 Session', (kept: SessionNode) => expect(kept.threads).toHaveLength(2)],
    ['a field is added', '添加字段', (kept: SessionNode) => expect(kept.contract!.inputs).toHaveLength(4)],
  ])('keep an input’s file that lands as %s before its render', async (_how, button, check) => {
    const general = createAgentTemplate('general', { x: 0, y: 0 }, 'zh');
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [{ ...general, id: 'n' }] }));
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: `打开 ${general.title}`, exact: true }));
    const tile = await screen.findByTestId('canvas-tile-n');
    await waitFor(() => expect(tile.dataset.lod).toBe('focus'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    // The inputs opened from the sessions list, on their structure.
    fireEvent.click(await screen.findByRole('button', { name: '展开 Session 列表' }));
    fireEvent.click(document.querySelector<HTMLButtonElement>('.awwo-session-input')!);
    fireEvent.click(screen.getByRole('button', { name: '编辑字段结构' }));
    fireEvent.change(document.querySelector('.awwo-input-drawer .awwo-file-field input[type=file]')!, { target: { files: [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })] } });
    await screen.findByText('clip.mp4');
    // The answer's write is made (the canvas runs each edit of its document through invalidateOutputs: one more call), and
    // the click's handler runs before the render that draws it (one act holds both).
    const edits = vi.spyOn(invalidation, 'invalidateOutputs');
    try {
      await act(async () => {
        const before = edits.mock.calls.length;
        FakeUpload.sent[0].finish();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(edits.mock.calls.length).toBe(before + 1);
        fireEvent.click(screen.getByRole('button', { name: button }));
      });
    } finally {
      edits.mockRestore();
    }
    await waitFor(() => {
      const kept = saved();
      check(kept);
      expect(names(kept.contract!.inputs.find(field => field.id === 'references')!.value)).toEqual(['clip.mp4']);
    }, { timeout: 4000 });
  });
});

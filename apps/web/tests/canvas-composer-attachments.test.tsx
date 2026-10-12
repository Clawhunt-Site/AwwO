import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_DATA_MARKER, attachmentKind, attachmentLine, attachmentSeenBy, joinAttachments, splitAttachments } from '../src/canvas/attachments';
import { MessageWithAttachments } from '../src/canvas/ComposerAttachments';
import { mediaComposerInfo, TileComposer, type MediaComposerInfo } from '../src/canvas/TileComposer';
import { parseMediaCatalogue } from '../src/canvas/mediaCatalog';
import { portsFor } from '../src/canvas/ports';
import { CanvasAssistant, type CanvasAssistantProps } from '../src/canvas/CanvasAssistant';
import { ContractFields } from '../src/canvas/ContractFields';
import { TileTranscript } from '../src/canvas/TileTranscript';
import type { ContractField } from '../src/canvas/nodeContracts';
import type { Turn } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const ID_A = 'aUPLOADaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'aUPLOADbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A stand-in for the upload route: every request answers 201 with the next id, unless told to hold or fail. */
class FakeUpload {
  static sent: FakeUpload[] = [];
  static ids: string[] = [];
  static hold = false;
  url = ''; method = ''; body: unknown; status = 0; responseText = ''; withCredentials = false;
  headers: Record<string, string> = {};
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  abort() { this.onabort?.(); }
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
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); });

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
  });

  it('reads what the node model does from its choices, and only for media nodes', () => {
    const choices = [{ key: 'tripo.p1', label: '3D · 游戏低多边形', available: true, references: 1 }, { key: 'tripo.x', label: 'X', available: true }];
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'model3d', model: 'tripo.p1' }, choices)).toEqual({ kind: 'model3d', references: 1, referenceModels: ['3D · 游戏低多边形'] });
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'model3d', model: 'tripo.x' }, choices)?.references).toBe(0);
    expect(mediaComposerInfo({ kind: 'session', agentKind: 'llm', model: 'm' }, choices)).toBeUndefined();
  });

  it('reads a model capability from the catalogue, 0 unless a small whole number', () => {
    const model = (references: unknown) => ({ id: 'xt.xtasy-3', name: 'x', label: ['图片', 'Image'], vendor: '媒体', kind: 'image', prompt: { minLength: 1, maxLength: 10 }, params: [], references });
    const catalogue = parseMediaCatalogue({ configured: true, available: true, models: [model(1), { ...model('2'), id: 'xt.b' }, { ...model(9), id: 'xt.c' }, { ...model(undefined), id: 'xt.d' }] });
    expect(catalogue.models.map(m => m.references)).toEqual([1, 0, 0, 0]);
  });

  it('gives 3D and video nodes a reference input, as image nodes have, and text nodes none', () => {
    const ids = (agentKind: string) => portsFor({ kind: 'session', agentKind } as never).filter(p => p.side === 'input').map(p => p.id);
    expect(ids('model3d')).toEqual(['context', 'reference']);
    expect(ids('image')).toEqual(['context', 'reference']);
    expect(ids('video')).toEqual(['context', 'reference']);
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

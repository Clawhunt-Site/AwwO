import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/saas/canvasBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/saas/canvasBridge')>()),
  uploadFileToCanvas: vi.fn(),
}));

import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { SaaSApiError, type CanvasRecord, type Identity, type Tenant } from '../src/saas/api';
import { uploadFileToCanvas } from '../src/saas/canvasBridge';
import { PLAN_HANDOFF_PREFIX, takePlanHandoff } from '../src/saas/planHandoff';
import type { UploadedCanvasFile } from '../src/canvas/attachments';

// The workspace home's request box takes files of any type, pictures, video, audio and 3D included, and hands them to
// the canvas it creates (owner request 2026-10-13).
const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
const ready = { available: true, configured: true, plannerAvailable: true, models: [{ id: 'fixture-model' }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const record = (id: string, name: string): CanvasRecord =>
  ({ id, tenantId: tenant.id, name, version: 1, document: { nodes: [] }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' });
const handoffs = () => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter(key => key?.startsWith(PLAN_HANDOFF_PREFIX));
const upload = vi.mocked(uploadFileToCanvas);
const ids: Record<string, string> = { 'cover.png': 'aCOVER00000001', 'demo.mp4': 'aDEMO000000002', 'chair.glb': 'aCHAIR00000003', 'voice.mp3': 'aVOICE00000004' };
const stored = (file: File): UploadedCanvasFile => ({ id: ids[file.name], reference: `awwo-file:${ids[file.name]}`, name: file.name, size: file.size,
  contentType: file.type, kind: 'file', inline: false });
const file = (name: string, type: string, size?: number) => {
  const made = new File(['bytes'], name, { type });
  if (size !== undefined) Object.defineProperty(made, 'size', { value: size });
  return made;
};

function server() {
  const posts: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('/runtime')) return json(ready);
    if (url.pathname.endsWith('/canvases') && init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      posts.push(body);
      return json({ ...record('new-canvas', body.name), document: body.document }, 201);
    }
    if (url.pathname.endsWith('/canvases')) return json({ items: [record('old', 'An older canvas')], nextCursor: null });
    return json({ error: { message: `Unexpected ${url.pathname}` } }, 404);
  }));
  return { posts };
}
const view = (onOpen = vi.fn()) => render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
const box = () => screen.getByRole('textbox', { name: '画布需求' });
const picker = () => document.querySelector<HTMLInputElement>('form.saas-home-composer input[type="file"]')!;
const attach = (...files: File[]) => fireEvent.change(picker(), { target: { files } });
const chips = () => within(screen.getByRole('list', { name: '要一起发送的文件' })).getAllByRole('listitem');

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); upload.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('keeps one list of canvases on the home: 继续工作, without 最近的成果', async () => {
  server();
  view();
  expect(await screen.findByRole('heading', { name: '继续工作' })).toBeVisible();
  expect(await screen.findByRole('heading', { name: 'An older canvas' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '最近的成果' })).toBeNull();
});

it('takes files of any type, uploads them to the canvas it creates, and hands the request over with their lines', async () => {
  const { posts } = server();
  upload.mockImplementation(async (_tenant, _canvas, picked, options) => { options?.onProgress?.(1); return stored(picked); });
  const onOpen = vi.fn();
  view(onOpen);
  const addButton = screen.getByRole('button', { name: '添加文件' });
  expect(addButton).toHaveAttribute('title', expect.stringContaining('图片、视频、音频、3D'));
  // Any type: the input names none.
  expect(picker()).not.toHaveAttribute('accept');
  expect(picker()).toHaveAttribute('multiple');
  attach(file('cover.png', 'image/png'), file('demo.mp4', 'video/mp4'), file('chair.glb', 'model/gltf-binary'), file('voice.mp3', 'audio/mpeg'));
  expect(chips().map(item => item.textContent)).toEqual([
    expect.stringContaining('cover.png'), expect.stringContaining('demo.mp4'), expect.stringContaining('chair.glb'), expect.stringContaining('voice.mp3')]);
  expect(chips().map(item => item.className)).toEqual([expect.stringContaining('is-image'), expect.stringContaining('is-video'),
    expect.stringContaining('is-model3d'), expect.stringContaining('is-audio')]);
  // Files alone are not a request yet: the box asks what to do with them, and sending waits for words.
  expect(box()).toHaveAttribute('placeholder', '写一句想用这些文件做什么…');
  expect(screen.getByRole('button', { name: '生成画布' })).toBeDisabled();
  // Nothing is uploaded before the request is sent: there is no canvas to hold the files yet.
  expect(upload).not.toHaveBeenCalled();

  fireEvent.change(box(), { target: { value: '用这些素材做一个产品介绍页' } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('new-canvas'));
  expect(posts).toHaveLength(1);
  expect(posts[0].name).toBe('用这些素材做一个产品介绍页');
  expect(upload.mock.calls.map(([tenantId, canvasId, picked]) => [tenantId, canvasId, picked.name])).toEqual([
    ['tenant-a', 'new-canvas', 'cover.png'], ['tenant-a', 'new-canvas', 'demo.mp4'], ['tenant-a', 'new-canvas', 'chair.glb'], ['tenant-a', 'new-canvas', 'voice.mp3']]);
  // The lines the canvas assistant's own box writes, so the planner gets the files exactly as if attached there.
  expect(takePlanHandoff({ user: 'user-a', tenant: 'tenant-a', canvas: 'new-canvas' })?.prompt).toBe('用这些素材做一个产品介绍页\n\n'
    + '[附件] cover.png · awwo-file:aCOVER00000001\n[附件] demo.mp4 · awwo-file:aDEMO000000002\n'
    + '[附件] chair.glb · awwo-file:aCHAIR00000003\n[附件] voice.mp3 · awwo-file:aVOICE00000004');
});

it('keeps the page, the canvas and what uploaded when a file fails, and the next send uploads only what is missing', async () => {
  const { posts } = server();
  upload.mockImplementation(async (_tenant, _canvas, picked) => {
    if (picked.name === 'demo.mp4') throw new SaaSApiError(413, 'upload_too_large', 'too large');
    return stored(picked);
  });
  const onOpen = vi.fn();
  view(onOpen);
  attach(file('cover.png', 'image/png'), file('demo.mp4', 'video/mp4'));
  fireEvent.change(box(), { target: { value: '做一个产品介绍页' } });
  fireEvent.click(screen.getByRole('button', { name: '生成画布' }));
  const alert = await screen.findByText(/「demo\.mp4」没有上传成功：文件太大：每个文件最多 64 MB。/);
  expect(alert).toHaveTextContent('画布已经建好，再点「生成画布」会接着上传没传上的文件');
  expect(onOpen).not.toHaveBeenCalled();
  expect(handoffs()).toEqual([]);
  expect(box()).toHaveValue('做一个产品介绍页');
  expect(chips()[0]).toHaveTextContent('已上传');
  expect(chips()[1]).toHaveTextContent('没有传上去');

  upload.mockImplementation(async (_tenant, _canvas, picked) => stored(picked));
  fireEvent.click(screen.getByRole('button', { name: '生成画布' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('new-canvas'));
  // The same canvas, and the picture that already went is not sent again.
  expect(posts).toHaveLength(1);
  expect(upload.mock.calls.map(([, canvasId, picked]) => `${canvasId}:${picked.name}`)).toEqual(['new-canvas:cover.png', 'new-canvas:demo.mp4', 'new-canvas:demo.mp4']);
  expect(takePlanHandoff({ user: 'user-a', tenant: 'tenant-a', canvas: 'new-canvas' })?.prompt)
    .toBe('做一个产品介绍页\n\n[附件] cover.png · awwo-file:aCOVER00000001\n[附件] demo.mp4 · awwo-file:aDEMO000000002');
});

it('says before creating anything when the request, with its files’ lines, is longer than planning takes', async () => {
  const { posts } = server();
  view();
  // 2,700 Chinese characters are 8,100 bytes: over the planner's 8,000 on their own.
  fireEvent.change(box(), { target: { value: '需'.repeat(2700) } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  expect(await screen.findByRole('alert')).toHaveTextContent('需求超过了画布规划能接收的长度（8000 字节，约 2600 个汉字）');
  // 2,660 fit alone (7,980 bytes), but not with a file's line (about 74 bytes more).
  fireEvent.change(box(), { target: { value: '需'.repeat(2660) } });
  attach(file('cover.png', 'image/png'));
  fireEvent.keyDown(box(), { key: 'Enter' });
  expect(await screen.findByRole('alert')).toHaveTextContent('需求加上附件的说明行，超过了画布规划能接收的长度（8000 字节）');
  expect(posts).toHaveLength(0);
  expect(upload).not.toHaveBeenCalled();
});

it('refuses files over 64 MB, empty files and more than ten, saying which and why', () => {
  server();
  view();
  attach(file('huge.mov', 'video/quicktime', 65 * 1024 * 1024), file('empty.txt', 'text/plain', 0), file('cover.png', 'image/png'));
  expect(chips()).toHaveLength(1);
  expect(screen.getByText(/「huge\.mov」超过 64 MB，没有添加。 「empty\.txt」是空文件，没有添加。/)).toBeVisible();
  attach(...Array.from({ length: 12 }, (_, index) => file(`page-${index}.pdf`, 'application/pdf')));
  expect(chips()).toHaveLength(10);
  expect(screen.getByText('最多带 10 个文件。')).toBeVisible();
  expect(screen.getByRole('button', { name: '添加文件' })).toBeDisabled();
  // Taking one back makes room again.
  fireEvent.click(screen.getByRole('button', { name: '移除「cover.png」' }));
  expect(chips()).toHaveLength(9);
  expect(screen.getByRole('button', { name: '添加文件' })).toBeEnabled();
});

it('takes files dropped on the box or pasted into it, and a blank canvas takes none', async () => {
  server();
  const onOpen = vi.fn();
  view(onOpen);
  const form = box().closest('form')!;
  const dropped = file('cover.png', 'image/png');
  fireEvent.dragEnter(form, { dataTransfer: { files: [dropped], types: ['Files'], items: [] } });
  expect(screen.getByText('松开即可添加文件')).toBeInTheDocument();
  fireEvent.drop(form, { dataTransfer: { files: [dropped], types: ['Files'], items: [] } });
  expect(screen.queryByText('松开即可添加文件')).toBeNull();
  fireEvent.paste(box(), { clipboardData: { files: [file('demo.mp4', 'video/mp4')], types: ['Files'], items: [] } });
  expect(chips().map(item => item.textContent)).toEqual([expect.stringContaining('cover.png'), expect.stringContaining('demo.mp4')]);
  fireEvent.click(screen.getByRole('button', { name: '空白画布' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('new-canvas'));
  expect(upload).not.toHaveBeenCalled();
  expect(handoffs()).toEqual([]);
});

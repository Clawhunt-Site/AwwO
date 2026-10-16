// 从网址读取 in simple mode (CanvasWebReader): offered only when the server reads the web, one page read into the
// workspace's knowledge, cited by the next task through the canvas's knowledge references, refusals said in words,
// the dialog held while a read is in flight, and the day's allowance respected.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => {
  const state = { ids: [] as string[], listeners: new Set<() => void>() };
  return {
    state,
    canvasKnowledgeRevisionIds: vi.fn(() => [...state.ids]),
    configureCanvasKnowledge: vi.fn((ids: readonly string[]) => { state.ids = [...ids]; state.listeners.forEach(listener => listener()); }),
    subscribeCanvasKnowledge: vi.fn((listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; }),
  };
});
vi.mock('../src/saas/canvasBridge', () => ({
  canvasKnowledgeRevisionIds: bridge.canvasKnowledgeRevisionIds,
  configureCanvasKnowledge: bridge.configureCanvasKnowledge,
  subscribeCanvasKnowledge: bridge.subscribeCanvasKnowledge,
}));

import { CanvasWebReader } from '../src/saas/CanvasWebReader';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const tenant = '/api/v1/tenants/tenant-a';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Call = { url: string; method: string; body: any };
function server(routes: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return (await routes(call)) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
  return calls;
}
const capabilities = (webReader: { enabled: boolean; usedToday?: number } = { enabled: true }) => ({
  skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: true, maxRunItems: 12, maxRunBytes: 4096, maxPerScope: 200 },
  webReader: { enabled: webReader.enabled, perDay: 30, usedToday: webReader.usedToday ?? 2 },
  render: { enabled: false, perDay: 20, usedToday: 0, limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 6291456 } },
});
const page = (patch: Record<string, unknown> = {}) => ({ id: 'web-a', kind: 'source', title: 'Example page', content: 'An example page.\n\nWith   two paragraphs.', version: 1,
  currentRevisionId: 'revision-web', contentHash: 'hash-web', sourceUri: 'https://example.com/a', provenance: { origin: 'web' },
  createdAt: '2026-10-16T06:00:00Z', updatedAt: '2026-10-16T06:00:00Z', ...patch });
const wrap = (node: React.ReactNode) => <SaaSPreferencesProvider>{node}</SaaSPreferencesProvider>;
/** The server's check of a proposed selection: the context those exact revisions give, in order. */
const contextOf = (url: string) => {
  const ids = (new URL(url, 'https://awwo.test').searchParams.get('revisionIds') ?? '').split(',').filter(Boolean);
  return json({ text: 'Quoted knowledge evidence', truncated: false, items: ids.map(id => ({ documentId: `doc-${id}`, revisionId: id, title: id, kind: 'source',
    contentHash: `hash-${id}`, content: 'text', sourceUri: '', provenance: {} })) });
};
const isContext = (call: Call) => call.url.includes('/knowledge/context?revisionIds=');

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  bridge.state.ids = []; bridge.state.listeners.clear();
  bridge.configureCanvasKnowledge.mockClear(); bridge.canvasKnowledgeRevisionIds.mockClear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
// No restoreAllMocks: the bridge mocks keep their implementations from one test to the next.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const openReader = async () => {
  fireEvent.click(await screen.findByRole('button', { name: '从网址读取' }));
  return screen.findByRole('dialog', { name: '从网址读取' });
};

describe('从网址读取 in simple mode', () => {
  it('is not offered when the server does not read the web', async () => {
    const calls = server(call => call.url.endsWith('/capabilities') ? json(capabilities({ enabled: false })) : undefined);
    const { container } = render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" />));
    await waitFor(() => expect(calls.some(call => call.url === `${tenant}/capabilities`)).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: '从网址读取' })).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('reads one page into the workspace knowledge and cites it in the next task', async () => {
    let used = 2;
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities({ enabled: true, usedToday: used }));
      if (call.url.endsWith('/knowledge/sources/web')) { used += 1; return json(page(), 201); }
      if (isContext(call)) return contextOf(call.url);
    });
    const drafts: { id: string; prompt: string }[] = [];
    render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={draft => drafts.push(draft)} />));
    const dialog = await openReader();
    expect(dialog).toHaveTextContent('今天已用 2 / 30 次');
    const read = within(dialog).getByRole('button', { name: '读取并保存' });
    expect(read).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'not a web address' } });
    expect(read).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: '  https://example.com/a  ' } });
    fireEvent.click(read);
    const result = await within(dialog).findByRole('region', { name: '已保存的网页' });
    expect(result).toHaveTextContent('Example page');
    expect(result).toHaveTextContent('example.com');
    expect(result).toHaveTextContent('An example page. With two paragraphs.');
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ url: `${tenant}/knowledge/sources/web`, method: 'POST',
      body: { url: 'https://example.com/a', operationId: expect.stringMatching(/^knowledge-/) } }]);
    await waitFor(() => expect(dialog).toHaveTextContent('今天已用 3 / 30 次'));
    fireEvent.click(within(result).getByRole('button', { name: '加入任务' }));
    await waitFor(() => expect(bridge.configureCanvasKnowledge).toHaveBeenLastCalledWith(['revision-web']));
    expect(calls.filter(isContext).map(call => call.url)).toEqual([`${tenant}/knowledge/context?revisionIds=revision-web`]);
    expect(drafts).toEqual([{ id: expect.any(String), prompt: '请结合网页「Example page」完成任务：' }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '从网址读取' })).toBeNull());
    const chip = screen.getByTitle('已引用 1 份知识');
    fireEvent.click(within(chip).getByRole('button', { name: '清除任务知识引用' }));
    expect(bridge.configureCanvasKnowledge).toHaveBeenLastCalledWith([]);
    await waitFor(() => expect(screen.queryByTitle('已引用 1 份知识')).toBeNull());
  });

  it('adds the page to the references already chosen, and says so when eight are already cited', async () => {
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities());
      if (call.url.endsWith('/knowledge/sources/web')) return json(page(), 201);
      if (isContext(call)) return contextOf(call.url);
    });
    bridge.state.ids = ['revision-1', 'revision-2'];
    const drafts: unknown[] = [];
    render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={draft => drafts.push(draft)} />));
    expect(await screen.findByTitle('已引用 2 份知识')).toBeVisible();
    let dialog = await openReader();
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '读取并保存' }));
    expect(await within(dialog).findByText(/加入任务会把这份网页加到已引用的 2 份知识里/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '加入任务' }));
    await waitFor(() => expect(bridge.configureCanvasKnowledge).toHaveBeenLastCalledWith(['revision-1', 'revision-2', 'revision-web']));
    expect(calls.filter(isContext).map(call => call.url)).toEqual([`${tenant}/knowledge/context?revisionIds=revision-1%2Crevision-2%2Crevision-web`]);
    expect(await screen.findByTitle('已引用 3 份知识')).toBeVisible();

    bridge.configureCanvasKnowledge(Array.from({ length: 8 }, (_, i) => `revision-${i + 1}`));
    bridge.configureCanvasKnowledge.mockClear();
    dialog = await openReader();
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '读取并保存' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '加入任务' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('一次任务最多引用 8 份知识');
    expect(bridge.configureCanvasKnowledge).not.toHaveBeenCalled();
    expect(drafts).toHaveLength(1);
  });

  it('says a refusal in words and keeps the address to fix', async () => {
    server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities());
      if (call.url.endsWith('/knowledge/sources/web')) return json({ error: { code: 'web_blocked_host', message: 'blocked' } }, 400);
    });
    render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" />));
    const dialog = await openReader();
    const address = within(dialog).getByLabelText('网页地址');
    fireEvent.change(address, { target: { value: 'http://10.0.0.1/' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '读取并保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('出于安全原因，不能读取本机、内网或保留地址。');
    expect(address).toHaveValue('http://10.0.0.1/');
    expect(within(dialog).getByRole('button', { name: '读取并保存' })).toBeEnabled();
    expect(within(dialog).queryByRole('region', { name: '已保存的网页' })).toBeNull();
  });

  it('holds the dialog while the page is read and asks once for a second click', async () => {
    let answer: (value: Response) => void = () => {};
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities());
      if (call.url.endsWith('/knowledge/sources/web')) return new Promise<Response>(resolve => { answer = resolve; });
    });
    render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" />));
    const dialog = await openReader();
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '读取并保存' }));
    const busy = await within(dialog).findByRole('button', { name: '读取中…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '从网址读取' })).toBeVisible();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    answer(json(page(), 201));
    expect(await within(dialog).findByRole('region', { name: '已保存的网页' })).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '完成' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '从网址读取' })).toBeNull());
    expect(bridge.configureCanvasKnowledge).not.toHaveBeenCalled();
  });

  it('says a page is too large to carry before citing it, and changes nothing', async () => {
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities());
      if (call.url.endsWith('/knowledge/sources/web')) return json(page(), 201);
      if (isContext(call)) return json({ error: { code: 'knowledge_context_limit', message: 'Selected knowledge exceeds 64 KiB' } }, 413);
    });
    const drafts: unknown[] = [];
    render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={draft => drafts.push(draft)} />));
    const dialog = await openReader();
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '读取并保存' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '加入任务' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('选中的知识合计超过 64 KiB');
    expect(calls.filter(isContext)).toHaveLength(1);
    expect(bridge.configureCanvasKnowledge).not.toHaveBeenCalled();
    expect(drafts).toEqual([]);
    expect(within(dialog).getByRole('button', { name: '加入任务' })).toBeEnabled();
  });

  it('shows the allowance as the server counts it: a refused read may not count', async () => {
    server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities({ enabled: true, usedToday: 29 }));
      if (call.url.endsWith('/knowledge/sources/web')) return json({ error: { code: 'web_blocked_host', message: 'blocked' } }, 400);
    });
    render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" />));
    const dialog = await openReader();
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'http://10.0.0.1/' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '读取并保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('出于安全原因');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(dialog).toHaveTextContent('今天已用 29 / 30 次');
    expect(dialog).not.toHaveTextContent('今天的网页读取次数已用完');
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/b' } });
    expect(within(dialog).getByRole('button', { name: '读取并保存' })).toBeEnabled();
  });

  it('reads the allowance again on opening, and while used up, so the next UTC day’s reset shows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let used = 30;
      const calls = server(call => call.url.endsWith('/capabilities') ? json(capabilities({ enabled: true, usedToday: used })) : undefined);
      render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" />));
      const reads = () => calls.filter(call => call.url.endsWith('/capabilities')).length;
      await screen.findByRole('button', { name: '从网址读取' });
      const before = reads();
      const dialog = await openReader();
      await waitFor(() => expect(reads()).toBe(before + 1));
      expect(dialog).toHaveTextContent('今天的网页读取次数已用完');
      used = 0;
      await vi.advanceTimersByTimeAsync(61_000);
      await waitFor(() => expect(dialog).toHaveTextContent('今天已用 0 / 30 次'));
      expect(dialog).not.toHaveTextContent('今天的网页读取次数已用完');
      fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
      expect(within(dialog).getByRole('button', { name: '读取并保存' })).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });

  it('drops a read that answers after the canvas changed: no saved page, no reference, no draft', async () => {
    let answer: (value: Response) => void = () => {};
    server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities());
      if (call.url.endsWith('/knowledge/sources/web')) return new Promise<Response>(resolve => { answer = resolve; });
      if (isContext(call)) return contextOf(call.url);
    });
    const drafts: unknown[] = [];
    const view = render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={draft => drafts.push(draft)} />));
    const dialog = await openReader();
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '读取并保存' }));
    await within(dialog).findByRole('button', { name: '读取中…' });
    view.rerender(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-b" onTaskDraft={draft => drafts.push(draft)} />));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '从网址读取' })).toBeNull());
    answer(json(page(), 201));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByRole('region', { name: '已保存的网页' })).toBeNull();
    expect(bridge.configureCanvasKnowledge).not.toHaveBeenCalled();
    expect(drafts).toEqual([]);
    expect(await screen.findByRole('button', { name: '从网址读取' })).toBeVisible();
  });

  it('offers no read once the day’s allowance is used up', async () => {
    const calls = server(call => call.url.endsWith('/capabilities') ? json(capabilities({ enabled: true, usedToday: 30 })) : undefined);
    render(wrap(<CanvasWebReader tenantId="tenant-a" canvasId="canvas-a" />));
    const dialog = await openReader();
    expect(dialog).toHaveTextContent('今天已用 30 / 30 次');
    expect(dialog).toHaveTextContent('今天的网页读取次数已用完');
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
    expect(within(dialog).getByRole('button', { name: '读取并保存' })).toBeDisabled();
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });
});

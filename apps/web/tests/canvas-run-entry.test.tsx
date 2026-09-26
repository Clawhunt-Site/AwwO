import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasPlanRevision, type CanvasPlan } from '../src/canvas/canvasPlan';
import { resetAllSessions } from '../src/canvas/sessions';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal } from '../src/canvas/runJournal';
import { activeNodeThread, getNodeThreads } from '../src/canvas/nodeThreads';

const execute = vi.fn(async (node: SessionNode) => ({ ok: true,
  output: JSON.stringify(Object.fromEntries((node.contract?.outputs ?? []).map(field => [field.id, `Result from ${node.title}`]))) }));
const hire = vi.fn();
vi.mock('../src/canvas/runTransport', () => ({
  createGatewayExecutor: (options: Parameters<typeof import('../src/canvas/runTransport').createGatewayExecutor>[0]) =>
    async (node: SessionNode) => {
      const identity = { issueId: `issue-${node.id}`, runId: `run-${node.id}` };
      options.onIssueId?.(node.id, identity.issueId);
      options.onRunAccepted?.(node.id, identity);
      return execute(node);
    },
}));
vi.mock('../src/canvasHire', async original => ({
  ...await original<typeof import('../src/canvasHire')>(),
  hireAgentIntoCompany: (...args: unknown[]) => hire(...args),
}));

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks(); execute.mockClear(); hire.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => new Response(JSON.stringify(
    String(input).endsWith('/settle') && init?.method === 'POST'
      ? { confirmed: true, status: 'succeeded', holdId: `hold-${JSON.parse(String(init.body)).runId}` }
      : String(input).endsWith('/companies') ? [{ id: 'company', name: 'Test workspace' }] : {},
  ), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { cleanup(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const plan: CanvasPlan = { version: 1, summary: 'Two connected agents', operations: [
  { type: 'add_node', ref: 'a', templateId: 'general', title: 'A', persona: '', inputValues: { brief: 'Produce the upstream result' } },
  { type: 'add_node', ref: 'b', templateId: 'general', title: 'B', persona: '' },
  { type: 'connect', fromNode: 'a', fromField: 'result', toNode: 'b', toField: 'brief' },
] };
const runtimeReadJson = async (path: string) => path === '/api/agents'
  ? { agents: [{ name: 'pi', supports_model_selection: true }] }
  : { models: ['fixture-model'] };

async function bind(title: string) {
  fireEvent.click(screen.getByRole('button', { name: `打开 ${title}`, exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Runtime', exact: true }));
  fireEvent.click(screen.getByRole('option', { name: 'Pi', exact: true }));
  hire.mockResolvedValueOnce({ outcome: 'created', agentId: `agent-${title}`, status: 'idle' });
  fireEvent.click(await screen.findByRole('button', { name: '绑定并创建真实 Agent' }));
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.find(node => node.title === title))
    .toMatchObject({ binding: { agentId: `agent-${title}` } }));
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
}

describe('canvas run entry document freshness', () => {
  it('runs a newly planned graph on the first click after binding and saving in the same page', async () => {
    render(<CanvasSurface runtimeReadJson={runtimeReadJson} planRequest={async () => plan} />);
    fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: 'Create A then B' } });
    fireEvent.click(screen.getByRole('button', { name: '生成画布', exact: true }));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await bind('A');
    await bind('B');
    // The same-page save writes factory-created nodes without lastOutput, while loading the
    // exact same bytes supplies null. That representation change is not another tab's edit.
    const raw = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!);
    expect(raw.nodes.every((node: SessionNode) => node.lastOutput === undefined)).toBe(true);
    expect(loadDocumentWithStatus().doc.nodes.every(node => node.lastOutput === null)).toBe(true);
    expect(loadDocumentWithStatus().doc.nodes).toEqual(raw.nodes.map((node: SessionNode) => ({ ...node, lastOutput: null })));
    expect(canvasPlanRevision(raw)).not.toBe(canvasPlanRevision(loadDocumentWithStatus().doc));
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/画布已在其他标签页更新/)).toBeNull();
    expect(execute.mock.calls.map(([node]) => node.title)).toEqual(['A', 'B']);
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    const settlementCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/settle'));
    expect(settlementCalls.map(([, init]) => JSON.parse(String(init?.body)).runId))
      .toEqual(execute.mock.calls.map(([node]) => `run-${node.id}`));
  });

  it('still stops before dispatch when another tab changes the persisted graph', async () => {
    const node = { ...createSessionNode('llm', { x: 0, y: 0 }), title: 'Original', runtime: 'pi',
      binding: { companyId: 'company', agentId: 'agent', agentName: 'Original' } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node] }));
    render(<CanvasSurface />);
    const otherTab = loadDocumentWithStatus().doc;
    otherTab.nodes[0].title = 'Changed in another tab';
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(otherTab));
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('画布已在其他标签页更新');
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '打开 Changed in another tab', exact: true })).toBeTruthy();
  });
});

function seedManualDrafts() {
  const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'manual', title: 'Manual', runtime: 'pi',
    binding: { companyId: 'company', agentId: 'agent-manual', agentName: 'Manual' }, activeThreadId: 'second',
    threads: [
      { id: 'default', title: 'Session 1', draft: 'Keep the first Session draft', issueId: null, preview: '', createdAt: 1 },
      { id: 'second', title: 'Session 2', draft: '', issueId: null, preview: '', createdAt: 2 },
    ] };
  const other: SessionNode = { ...createSessionNode('llm', { x: 600, y: 0 }), id: 'other', title: 'Other',
    threads: [{ id: 'default', title: 'Session 1', draft: 'Keep the other node draft', issueId: null, preview: '', createdAt: 1 }] };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node, other] }));
}

function storedManual() {
  return loadDocumentWithStatus().doc.nodes.find(node => node.id === 'manual') as SessionNode;
}

function openManualAndType() {
  fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Send this once' } });
  expect(activeNodeThread(storedManual()).draft).toBe('Send this once');
}

describe('manual run acceptance persists composer drafts', () => {
  it('clears only the accepted Session draft before dispatch and keeps it empty after reload recovery', async () => {
    seedManualDrafts();
    // Detaching observation leaves the run unconfirmed and releases the old page's Web Lock.
    // The remounted page must recover the same operation, without dispatching again.
    let detach!: (result: { ok: boolean; output: string; unconfirmed?: boolean }) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { detach = resolve; }));
    const firstPage = render(<CanvasSurface />);
    openManualAndType();
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    expect(loadRunJournal()).toMatchObject({ manual: true, manualMessage: 'Send this once' });
    expect(activeNodeThread(storedManual()).draft).toBe('');
    expect(getNodeThreads(storedManual()).find(thread => thread.id === 'default')?.draft).toBe('Keep the first Session draft');
    expect(activeNodeThread(loadDocumentWithStatus().doc.nodes.find(node => node.id === 'other') as SessionNode).draft).toBe('Keep the other node draft');

    const operationId = loadRunJournal()!.nodes.manual.operationId;
    await act(async () => { detach({ ok: false, output: '', unconfirmed: true }); });
    firstPage.unmount(); resetAllSessions();
    const settlementPath = '/conversations/company/agents/agent-manual/issues/issue-manual/settle';
    let confirmSettlement!: (response: Response) => void;
    const settlement = new Promise<Response>(resolve => { confirmSettlement = resolve; });
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith(settlementPath) && init?.method === 'POST') return settlement;
      return new Response(JSON.stringify(
        String(input).endsWith(`/operations/${operationId}`)
          ? { operationId, state: 'terminal', issueId: 'issue-manual', runId: 'run-manual', terminal: true,
            status: 'succeeded', output: 'Recovered reply', outputAvailable: true, detail: null }
          : String(input).endsWith('/companies') ? [{ id: 'company', name: 'Test workspace' }] : {},
      ), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CanvasSurface />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(settlementPath),
      expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ runId: 'run-manual' }) })));
    // A terminal read does not unlock the native run before the same turn is explicitly parked.
    expect(loadRunJournal()?.nodes.manual.operationId).toBe(operationId);
    expect(execute).toHaveBeenCalledOnce();
    await act(async () => confirmSettlement(new Response(JSON.stringify({
      confirmed: true, status: 'succeeded', holdId: 'hold-manual',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/operations/${operationId}`))).toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(settlementPath))).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    expect(screen.getByText('Recovered reply')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '打开 Session 1', exact: true }));
    expect(screen.getByTestId('composer-input')).toHaveValue('Keep the first Session draft');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps the draft when a changed persisted graph refuses manual dispatch', async () => {
    seedManualDrafts();
    render(<CanvasSurface />);
    openManualAndType();
    const external = loadDocumentWithStatus().doc;
    external.nodes.find(node => node.id === 'other')!.title = 'Changed elsewhere';
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(external));
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(await screen.findByRole('alert')).toHaveTextContent('画布已在其他标签页更新');
    expect(screen.getByTestId('composer-input')).toHaveValue('Send this once');
    expect(activeNodeThread(storedManual()).draft).toBe('Send this once');
    expect(loadRunJournal()).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([CANVAS_STORAGE_KEY, CANVAS_RUN_JOURNAL_KEY])('keeps the draft if accepting the run cannot persist %s', async failedKey => {
    seedManualDrafts();
    render(<CanvasSurface />);
    openManualAndType();
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === failedKey) throw new DOMException('Storage is full', 'QuotaExceededError');
      setItem(key, value);
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(await screen.findByRole('alert')).toHaveTextContent('本地存储不可用，尚未启动任务。');
    expect(screen.getByTestId('composer-input')).toHaveValue('Send this once');
    expect(activeNodeThread(storedManual()).draft).toBe('Send this once');
    expect(loadRunJournal()).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});

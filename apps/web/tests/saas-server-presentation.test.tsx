import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { beginConversationPresentation, updateConversationPresentation } from '../src/canvas/conversationPresentation';
import { LocaleProvider } from '../src/canvas/i18n';
import { readableOutput } from '../src/canvas/readableTranscript';
import { forgetNode, restoreHistory } from '../src/canvas/sessionTransport';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { fetchConversationMessages } from '../src/canvasAgentChat';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const tenant = { id: 'tenant-a', name: 'Workspace', role: 'owner', status: 'active' };
const raw = '  {"result":"# Historical result\\n\\n**Readable evidence**"}\n';
const historicalContract = { version: 1 as const, inputs: [], outputs: [{ id: 'result', label: 'Historical deliverable', type: 'markdown' as const, required: true, value: '' }] };
const metadata = { runId: 'run-a', sessionId: 'session-a', nodeId: 'node-a', outputState: 'final', outputContract: historicalContract };
const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', issueId: 'session-a',
  binding: { companyId: tenant.id, agentId: 'agent-a', agentName: 'Agent' },
  contract: { version: 1, inputs: [], outputs: [{ id: 'current', label: 'Changed canvas field', type: 'number', required: true, value: '' }] },
};
const respond = (items: unknown[]) => {
  const fetcher = vi.fn(async (input: unknown, _init?: RequestInit) => new Response(JSON.stringify(String(input).includes('/sessions?')
    ? { items: [{ id: 'session-a', agentId: 'agent-a', title: 'Node Session' }] } : { items })));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
const cacheFinal = () => {
  const storage = canvasStorage();
  beginConversationPresentation(node, 'old-operation', 'Original graph request', { outputState: 'final', outputContract: historicalContract }, storage);
  updateConversationPresentation(node, 'old-operation', { runId: 'run-a', outputText: raw, outputState: 'final' }, storage);
};
beforeEach(() => {
  localStorage.clear(); resetAllSessions(); forgetNode(node.id);
  configureCanvasStorage('server-user', tenant.id, 'canvas-a');
  configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); forgetNode(node.id); vi.unstubAllGlobals(); localStorage.clear(); });

it('restores readable graph history on a fresh client through the bridge without changing raw messages or current contracts', async () => {
  const fetcher = respond([
    { role: 'user', runId: 'run-a', content: 'Original graph request' },
    { role: 'assistant', runId: 'run-a', content: raw, presentation: metadata },
  ]);
  await restoreHistory({ gatewayBase: '', node });
  const session = getSnapshot(node.id);
  expect(session.history).toBe('loaded');
  expect(session.turns[0].presentation).toBeUndefined();
  expect(session.turns[1]).toMatchObject({ text: raw, runId: 'run-a', nativeRunId: 'run-a', presentation: { outputState: 'final', outputContract: historicalContract } });
  expect(readableOutput(session.turns[1]).fields).toHaveLength(1);
  render(<LocaleProvider locale="en"><TileTranscript turns={session.turns} history="loaded" streaming={false} limit={Infinity} /></LocaleProvider>);
  expect(screen.getByRole('heading', { name: 'Historical result' })).toBeVisible();
  expect(screen.getByText('Readable evidence').tagName).toBe('STRONG');
  expect(screen.getByText('View original response').closest('details')!.querySelector('pre')!.textContent).toBe(raw);
  expect(node.contract!.outputs[0].id).toBe('current');
  expect(fetcher.mock.calls.every(call => !(call[1] as RequestInit | undefined)?.method)).toBe(true);
});

it.each(['final', 'failed', 'streaming'] as const)('keeps authoritative server %s state over a stale local graph presentation', async outputState => {
  const storage = canvasStorage();
  beginConversationPresentation(node, 'old-operation', 'Original graph request', { outputState: 'streaming', outputContract: node.contract }, storage);
  updateConversationPresentation(node, 'old-operation', { runId: 'run-a', outputText: raw, outputState: outputState === 'final' ? 'streaming' : 'final' }, storage);
  respond([{ role: 'assistant', runId: 'run-a', content: raw, presentation: { ...metadata, outputState } }]);
  await restoreHistory({ gatewayBase: '', node });
  const turn = getSnapshot(node.id).turns[0];
  expect(turn.presentation).toEqual({ outputState, outputContract: historicalContract });
  expect(readableOutput(turn).fields).toHaveLength(outputState === 'final' ? 1 : 0);
});

it('does not attach output contracts to manual, candidate, user, or legacy messages based on content', async () => {
  respond([
    { role: 'assistant', runId: 'manual', content: raw },
    { role: 'assistant', runId: 'proposal', content: raw },
    { role: 'user', runId: 'run-a', content: raw, presentation: metadata },
    { role: 'assistant', content: raw, presentation: metadata },
  ]);
  await restoreHistory({ gatewayBase: '', node });
  expect(getSnapshot(node.id).turns).toHaveLength(4);
  for (const turn of getSnapshot(node.id).turns) {
    expect(turn.presentation).toBeUndefined();
    expect(turn.serverPresentation).toBeUndefined();
    expect(turn.text).toBe(raw);
  }
});

it.each(['run', 'session', 'node', 'contract', 'state'] as const)('rejects server metadata with mismatched %s despite a stale local final result', async mismatch => {
  cacheFinal();
  const presentation = { ...metadata, ...(mismatch === 'run' ? { runId: 'other' } : mismatch === 'session' ? { sessionId: 'other' }
    : mismatch === 'node' ? { nodeId: 'other' } : mismatch === 'contract' ? { outputContract: { version: 99, inputs: [], outputs: [] } }
      : { outputState: 'candidate' }) };
  respond([{ role: 'assistant', runId: 'run-a', content: raw, presentation }]);
  await restoreHistory({ gatewayBase: '', node });
  const turn = getSnapshot(node.id).turns[0];
  expect(turn.text).toBe(raw);
  expect(turn.presentation).toBeUndefined();
  expect(readableOutput(turn).fields).toEqual([]);
});

it.each([null, false, 0, '', {}, []])('keeps explicit invalid server metadata %j raw instead of treating it as an absent legacy field', async presentation => {
  cacheFinal();
  respond([{ role: 'assistant', runId: 'run-a', content: raw, presentation }]);
  await restoreHistory({ gatewayBase: '', node });
  const turn = getSnapshot(node.id).turns[0];
  expect(turn.text).toBe(raw);
  expect(turn.presentationRejected).toBe(true);
  expect(turn.presentation).toBeUndefined();
  expect(readableOutput(turn).fields).toEqual([]);
});

it('retains verified local presentation compatibility when the server property is truly absent', async () => {
  cacheFinal();
  respond([{ role: 'assistant', runId: 'run-a', content: raw }]);
  await restoreHistory({ gatewayBase: '', node });
  const turn = getSnapshot(node.id).turns[0];
  expect(turn.presentationRejected).toBeUndefined();
  expect(turn.presentation).toEqual({ outputState: 'final', outputContract: historicalContract });
  expect(readableOutput(turn).fields).toHaveLength(1);
});

it('rejects conflicting native run identifiers before preserving server presentation', async () => {
  clearSaaSCanvas();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ complete: true, messages: [
    { body: raw, authorAgentId: 'agent-a', runId: 'run-a', createdByRunId: 'other-run', presentation: metadata },
  ] }))));
  const turns = await fetchConversationMessages('', tenant.id, 'session-a');
  expect(turns![0].text).toBe(raw);
  expect(turns![0].serverPresentation).toBeUndefined();
});

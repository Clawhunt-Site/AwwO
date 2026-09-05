import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createSessionNode, type CanvasEdge, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';
import { SessionTile } from '../src/canvas/SessionTile';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import * as gateway from '../src/canvasAgentChat';

afterEach(() => { cleanup(); resetAllSessions(); vi.restoreAllMocks(); });

function agent(id: string, value = ''): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }), id, title: `Agent ${id}`,
    binding: { agentId: id, companyId: 'company', agentName: id },
    contract: {
      version: 1,
      inputs: [{ id: 'brief', label: '需求正文', type: 'markdown', required: true, value }],
      outputs: [{ id: 'result', label: '执行结果', type: 'text', required: true, value: '' }],
    },
  };
}

function edge(): CanvasEdge {
  return { id: 'handoff', fromNode: 'source', fromPort: 'out:result', toNode: 'sink', toPort: 'in:brief', dataType: 'text' };
}

function source(): SessionNode {
  const node = agent('source');
  return { ...node, contract: { ...node.contract!, inputs: [], outputs: [
    ...node.contract!.outputs,
    { id: 'notes', label: '内部备注', type: 'text', required: true, value: '' },
  ] }, lastOutput: { text: '{"result":"Connected brief","notes":"Do not forward"}', source: 'manual', at: 1 } };
}

describe('node conversation input context', () => {
  it('keeps legacy chat text untouched', () => {
    expect(prepareNodeConversation(createSessionNode('llm', { x: 0, y: 0 }))).toEqual({ messagePrefix: '' });
  });

  it('includes local input and the declared output instructions', () => {
    const node = agent('local', '# Local specification');
    const context = prepareNodeConversation(node);
    expect(context.error).toBeUndefined();
    expect(context.messagePrefix).toContain('# Local specification');
    expect(context.messagePrefix).toContain('需求正文');
    expect(context.messagePrefix).toContain('执行结果');
    expect(context.inputs?.[0].value).toBe('# Local specification');
    expect(context.inputs?.[0]).not.toBe(node.contract!.inputs[0]);
    expect(context.sources).toEqual({});
  });

  it('blocks missing required local fields', () => {
    const context = prepareNodeConversation(agent('local'));
    expect(context.messagePrefix).toBe('');
    expect(context.error).toContain('需求正文');
  });

  it('uses only the selected currently published upstream output field', () => {
    const upstream = source();
    const sink = agent('sink', 'Overridden local input');
    const context = prepareNodeConversation(sink, [upstream, sink], [edge()]);
    expect(context.error).toBeUndefined();
    expect(context.messagePrefix).toContain('Connected brief');
    expect(context.messagePrefix).not.toContain('Do not forward');
    expect(context.messagePrefix).not.toContain('Overridden local input');
    expect(context.inputs?.[0]).toEqual({ id: 'brief', label: '需求正文', type: 'markdown', required: true, value: 'Connected brief' });
    expect(context.sources).toEqual({ brief: 'Agent source' });
    expect(sink.contract!.inputs[0].value).toBe('Overridden local input');
    expect(upstream.lastOutput?.text).toBe('{"result":"Connected brief","notes":"Do not forward"}');
  });

  it.each([
    ['missing', null],
    ['partial', { text: '{"result":"Incomplete","notes":"Notes"}', source: 'run' as const, at: 2, partial: true }],
    ['invalid', { text: '{"result":"Missing the other required field"}', source: 'run' as const, at: 2 }],
  ])('blocks %s upstream output despite a filled local fallback', (_label, lastOutput) => {
    const upstream = { ...source(), lastOutput };
    const sink = agent('sink', 'Local fallback');
    const context = prepareNodeConversation(sink, [upstream, sink], [edge()]);
    expect(context.messagePrefix).toBe('');
    expect(context.error).toContain('Agent source');
    expect(context.sources).toEqual({ brief: 'Agent source' });
    expect(context.inputs).toBeUndefined();
  });

  it('retains source names for other connected fields when an earlier upstream is not ready', () => {
    const unavailable = { ...source(), lastOutput: null };
    const ready = { ...source(), id: 'ready', title: 'Ready Agent' };
    const sink = agent('sink');
    sink.contract!.inputs.push({ id: 'other', label: 'Other input', type: 'text', required: true, value: '' });
    const context = prepareNodeConversation(sink, [unavailable, ready, sink], [edge(), { ...edge(), id: 'other-edge', fromNode: 'ready', toPort: 'in:other' }]);
    expect(context.error).toContain('Agent source');
    expect(context.sources).toEqual({ brief: 'Agent source', other: 'Ready Agent' });
    expect(context.inputs).toBeUndefined();
  });

  it('rejects stale ports and incompatible wire types', () => {
    const upstream = source();
    const sink = agent('sink', 'Local fallback');
    expect(prepareNodeConversation(sink, [upstream, sink], [{ ...edge(), fromPort: 'out:removed' }]).error).toBeTruthy();
    const numeric = { ...sink, contract: { ...sink.contract!, inputs: [{ ...sink.contract!.inputs[0], type: 'number' as const }] } };
    expect(prepareNodeConversation(numeric, [upstream, numeric], [edge()]).error).toBeTruthy();
  });
});

describe('contract-aware tile conversations', () => {
  it('sends contract context over the default transport without publishing a chat reply as a node output', async () => {
    const node = agent('local', '# Runtime input');
    const requests: string[] = [];
    const updates: CanvasNode[] = [];
    vi.spyOn(gateway, 'streamAgentConversation').mockImplementation(async (_base, _company, _agent, message, onFrame) => {
      requests.push(message);
      onFrame({ event: 'delta', text: 'A conversational reply' });
      onFrame({ event: 'done', status: 'succeeded' });
    });
    render(createElement(SessionTile, { node, scale: 1, focused: true, gatewayBase: '/local-fixture', onUpdateNode: (next) => updates.push(next) }));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Discuss this input' } });
    await act(async () => { fireEvent.click(screen.getByTestId('composer-send')); });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('# Runtime input');
    expect(requests[0]).toContain('Discuss this input');
    expect(getSnapshot(node.id).turns.at(-1)?.text).toBe('A conversational reply');
    // Persisting a typed draft is allowed; a conversation reply must never become a published
    // node output, including a hidden historical delivery on one of its Sessions.
    expect(updates.every(update => update.lastOutput == null
      && (update.kind !== 'session' || (update.threads || []).every(thread => thread.lastOutput == null)))).toBe(true);
    expect(node.lastOutput).toBeUndefined();
  });

  it('sends local contract context with the user message through the override path', () => {
    const node = agent('local', '# Local brief');
    const messages: string[] = [];
    render(createElement(SessionTile, { node, scale: 1, focused: true, onSend: (_node, text) => messages.push(text) }));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Please implement it' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('# Local brief');
    expect(messages[0]).toContain('Please implement it');
    expect(messages[0]).toContain('执行结果');
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    expect(node.lastOutput).toBeUndefined();
  });

  it('uses the supplied graph context instead of the local-only fallback', () => {
    const upstream = source();
    const node = agent('sink');
    const messages: string[] = [];
    const conversationContext = prepareNodeConversation(node, [upstream, node], [edge()]);
    render(createElement(SessionTile, { node, conversationContext, scale: 1, focused: true, onSend: (_node, text) => messages.push(text) }));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Continue from that brief' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Connected brief');
    expect(messages[0]).not.toContain('Do not forward');
    expect(messages[0]).toContain('Continue from that brief');
  });

  it('keeps a typed draft when its input becomes blocked and can send it after the input is fixed', () => {
    const node = agent('local', 'Ready input');
    const messages: string[] = [];
    const onSend = (_node: SessionNode, text: string) => { messages.push(text); };
    const view = render(createElement(SessionTile, { node, scale: 1, focused: true, onSend }));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Keep this draft' } });
    view.rerender(createElement(SessionTile, { node: agent('local'), scale: 1, focused: true, onSend }));
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent('需求正文');
    expect(screen.getByTestId('composer-input')).toHaveValue('Keep this draft');
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(messages).toEqual([]);
    view.rerender(createElement(SessionTile, { node, scale: 1, focused: true, onSend }));
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(messages[0]).toContain('Keep this draft');
  });

  it('shows upstream readiness errors from the graph context', () => {
    const node = agent('sink', 'A local value cannot replace a wired dependency');
    const upstream = { ...source(), lastOutput: null };
    render(createElement(SessionTile, {
      node, scale: 1, focused: true, onSend: () => {},
      conversationContext: prepareNodeConversation(node, [upstream, node], [edge()]),
    }));
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent('Agent source');
    expect(screen.getByTestId('composer-send')).toBeDisabled();
  });
});

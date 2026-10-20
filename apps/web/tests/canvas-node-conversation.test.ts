import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createEditNode, createSessionNode, type CanvasEdge, type CanvasNode, type EditNode, type SessionNode } from '../src/canvas/canvasDoc';
import { LocaleProvider } from '../src/canvas/i18n';
import { mediaMissingText } from '../src/canvas/mediaOutput';
import { validateContractFields } from '../src/canvas/nodeContracts';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';
import { buildNodeMessage } from '../src/canvas/runGraph';
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

  it('shows what every upstream delivered when a value does not fit its field, so the form can name it', () => {
    // The upstream delivered, without the optional output this input is wired to.
    const base = source();
    const upstream = { ...base, contract: { ...base.contract!, outputs: [...base.contract!.outputs, { id: 'extra', label: 'Extra', type: 'text' as const, required: false, value: '' }] } };
    const sink = agent('sink');
    const context = prepareNodeConversation(sink, [upstream, sink], [{ ...edge(), fromPort: 'out:extra' }]);
    expect(context.messagePrefix).toBe('');
    expect(context.error).toContain('需求正文');
    expect(context.sources).toEqual({ brief: 'Agent source' });
    expect(context.inputs?.[0]).toEqual({ ...sink.contract!.inputs[0], value: '' });
    expect(validateContractFields(context.inputs!, 'en')).toEqual(['“需求正文” is required.']);
  });

  it('keeps a delivered wired value, and what it came from, beside a local field that is missing', () => {
    const sink = agent('sink');
    sink.contract!.inputs.push({ id: 'other', label: 'Other input', type: 'text', required: true, value: '' });
    const recording = { ...source(), lastOutput: { ...source().lastOutput!, source: 'case' as const } };
    const context = prepareNodeConversation(sink, [recording, sink], [edge()]);
    expect(context.error).toContain('Other input');
    expect(context.inputs?.map(input => input.value)).toEqual(['Connected brief', '']);
    expect(context.recorded).toEqual({ brief: true });
    expect(validateContractFields(context.inputs!, 'en')).toEqual(['“Other input” is required.']);
  });

  it('shows no value for an input with two delivered wires, as for any other broken wiring', () => {
    const other = { ...source(), id: 'other', title: 'Other Agent' };
    const context = prepareNodeConversation(agent('sink'), [source(), other, agent('sink')], [edge(), { ...edge(), id: 'second', fromNode: 'other' }]);
    expect(context.error).toContain('只能连接一个来源');
    expect(context.inputs).toBeUndefined();
    expect(context.sources).toEqual({ brief: 'Other Agent' });
  });

  it('names an untitled upstream by its id, so its wired input is still read as wired', () => {
    const context = prepareNodeConversation(agent('sink'), [{ ...source(), title: '', lastOutput: null }, agent('sink')], [edge()]);
    expect(context.sources).toEqual({ brief: 'source' });
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

describe('an input wired from a media node that has made no file', () => {
  const RECORD = JSON.stringify({ type: 'awwo.media', version: 1, kind: 'image', model: 'xt.seedream-5-pro',
    items: [{ artifactId: 'aAAAAAAAAAAA', name: 'image-1.png', contentType: 'image/png', size: 2048 }] });
  function media(id: string, kind: 'image' | 'video' | 'model3d' | 'audio' = 'image', lastOutput?: SessionNode['lastOutput']): SessionNode {
    return { ...createSessionNode(kind, { x: 0, y: 0 }), id, title: `Media ${id}`, ...(lastOutput !== undefined ? { lastOutput } : {}) };
  }
  // A page whose brief is filled in here and whose key art is wired from a media node (a soft feed: ports.ts).
  function page(): SessionNode {
    const node = agent('sink', '# Local brief');
    return { ...node, contract: { ...node.contract!, inputs: [...node.contract!.inputs, { id: 'art', label: 'Key art', type: 'markdown', required: true, value: '' }] } };
  }
  const wire = (from: string, dataType: CanvasEdge['dataType'] = 'image'): CanvasEdge =>
    ({ id: `${from}->art`, fromNode: from, fromPort: 'result', toNode: 'sink', toPort: 'in:art', dataType });

  it('hands the agent its note as before, and marks the input for the form', () => {
    const hero = media('hero'), sink = page();
    const context = prepareNodeConversation(sink, [hero, sink], [wire('hero')]);
    expect(context.error).toBeUndefined();
    // What the agent reads does not change: the input's value is the note, in the same message, word for word.
    expect(context.inputs?.find(input => input.id === 'art')?.value).toBe(mediaMissingText(hero));
    expect(context.messagePrefix).toBe(buildNodeMessage(sink, [{ fromTitle: 'Media hero', toPort: 'in:art', output: mediaMissingText(hero) }]));
    expect(context.sources).toEqual({ art: 'Media hero' });
    expect(context.mediaMissing).toEqual({ art: 'image' });
    expect(context.recorded).toEqual({});
  });

  it.each([
    ['absent', undefined],
    ['empty', { text: '  ', source: 'run' as const, at: 1 }],
    ['partial', { text: RECORD, source: 'run' as const, at: 1, partial: true }],
    ['not a media record', { text: 'A picture of the hero', source: 'run' as const, at: 1 }],
  ])('marks an input whose media output is %s', (_label, lastOutput) => {
    const hero = media('hero', 'image', lastOutput), sink = page();
    expect(prepareNodeConversation(sink, [hero, sink], [wire('hero')]).mediaMissing).toEqual({ art: 'image' });
  });

  it('names what each media upstream makes, an edit node a video', () => {
    for (const kind of ['video', 'model3d', 'audio'] as const) {
      const sink = page();
      expect(prepareNodeConversation(sink, [media('m', kind), sink], [wire('m', kind === 'model3d' ? 'file' : kind)]).mediaMissing, kind).toEqual({ art: kind });
    }
    const film: EditNode = { ...createEditNode({ x: 0, y: 0 }, 'en'), id: 'cut', title: 'Final cut' };
    const sink = page();
    const context = prepareNodeConversation(sink, [film, sink], [wire('cut', 'video')]);
    expect(context.mediaMissing).toEqual({ art: 'video' });
    expect(context.inputs?.find(input => input.id === 'art')?.value).toBe(mediaMissingText(film));
  });

  it('does not mark an input whose picture was made', () => {
    const sink = page();
    const context = prepareNodeConversation(sink, [media('hero', 'image', { text: RECORD, source: 'run', at: 1 }), sink], [wire('hero')]);
    expect(context.mediaMissing).toEqual({});
    expect(context.inputs?.find(input => input.id === 'art')?.value).toContain('- hero/image-1.png');
  });

  it('keeps the mark when another value does not fit, and gives none while another upstream is not ready', () => {
    const hero = media('hero'), sink = page();
    sink.contract!.inputs[0].value = '';
    const unfit = prepareNodeConversation(sink, [hero, sink], [wire('hero')]);
    expect(unfit.error).toContain('需求正文');
    expect(unfit.mediaMissing).toEqual({ art: 'image' });
    expect(unfit.inputs?.find(input => input.id === 'art')?.value).toBe(mediaMissingText(hero));
    // Until every other upstream has delivered, the form shows no values and every wired input waits.
    const other = page();
    const waiting = prepareNodeConversation(other, [hero, { ...source(), lastOutput: null }, other], [wire('hero'), edge()]);
    expect(waiting.inputs).toBeUndefined();
    expect(waiting.mediaMissing).toBeUndefined();
    expect(waiting.sources).toEqual({ art: 'Media hero', brief: 'Agent source' });
  });

  it('shows the note in the page’s language on the opened node, and sends the agent its own', () => {
    const hero = media('hero'), sink = page();
    const messages: string[] = [];
    const conversationContext = prepareNodeConversation(sink, [hero, sink], [wire('hero')]);
    render(createElement(LocaleProvider, { locale: 'en', children: createElement(SessionTile, {
      node: sink, conversationContext, scale: 1, focused: true, onSend: (_node, text) => { messages.push(text); },
    }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Input' }));
    const form = screen.getByRole('region', { name: 'Input form' });
    expect(screen.getByText('No image file from “Media hero” yet. If it makes none, this node goes on without it. Disconnect the wire to enter a value manually.')).toBeVisible();
    expect(screen.getByLabelText('Key art value')).toHaveValue('');
    expect(form.textContent).not.toContain('没有可以引用的路径');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Make the page' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(messages).toHaveLength(1);
    expect(messages[0].startsWith(`${conversationContext.messagePrefix}\n\n`)).toBe(true);
    expect(messages[0]).toContain(mediaMissingText(hero));
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
    render(createElement(SessionTile, { node, scale: 1, focused: true, onSend: (_node, text, accepted) => { messages.push(text); accepted?.(); } }));
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

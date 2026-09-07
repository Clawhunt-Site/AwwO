import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { beginConversationPresentation, nativeConversationOperation, projectConversationTurns, updateConversationPresentation } from '../src/canvas/conversationPresentation';
import type { NodeContract } from '../src/canvas/nodeContracts';
import type { Turn, TurnPresentation } from '../src/canvas/sessions';

type NativeTurn = Omit<Turn, 'id'>;
const rawInput = '完整执行输入\n【用户消息】改成抽屉\n';
const rawOutput = '{"result":"已改成抽屉"}';

function store() {
  const values = new Map<string, string>();
  return { values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

function node(over: Partial<SessionNode> = {}): SessionNode {
  return { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'node-1', issueId: 'issue-1',
    binding: { companyId: 'company-1', agentId: 'agent-1', agentName: 'Agent' }, ...over };
}

function presentation(): TurnPresentation {
  return { inputKind: 'manual', displayText: '改成抽屉', outputState: 'streaming', outputContract: {
    version: 1, inputs: [], outputs: [{ id: 'result', label: '本轮成果', type: 'markdown', required: true, value: '' }],
  } };
}

function saved(current = node(), cache = store(), operationId = 'operation-1', runId = 'run-1') {
  expect(beginConversationPresentation(current, operationId, rawInput, presentation(), cache)).toBe(true);
  expect(updateConversationPresentation(current, operationId, { runId, outputState: 'final', outputText: rawOutput }, cache)).toBe(true);
  return { current, cache };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('conversation presentation identity', () => {
  it('restores by the native operation/run markers and preserves exact raw text and comment identity', () => {
    const { current, cache } = saved();
    const turns: NativeTurn[] = [
      { role: 'user', text: rawInput, nativeOperationId: 'operation-1', nativeCommentId: 'comment-user', createdAt: 1 },
      { role: 'agent', text: rawOutput, nativeRunId: 'run-1', nativeCommentId: 'comment-agent', createdAt: 2 },
    ];
    const projected = projectConversationTurns(current, turns, cache);
    expect(projected[0]).toEqual({ ...turns[0], presentation: { inputKind: 'manual', displayText: '改成抽屉' } });
    expect(projected[1]).toEqual({ ...turns[1], presentation: { outputState: 'final', outputContract: presentation().outputContract } });
    expect(turns.every(turn => !turn.presentation)).toBe(true);
  });

  it('restores by recovery identities with the same raw-text requirement', () => {
    const { current, cache } = saved();
    const turns: NativeTurn[] = [
      { role: 'user', text: rawInput, recoveryOperationId: 'operation-1' },
      { role: 'agent', text: rawOutput, recoveryOperationId: 'operation-1', recoveryRunId: 'run-1' },
    ];
    expect(projectConversationTurns(current, turns, cache).map(turn => turn.presentation)).toEqual([
      { inputKind: 'manual', displayText: '改成抽屉' },
      { outputState: 'final', outputContract: presentation().outputContract },
    ]);
  });

  it('requires exact bytes and stable markers instead of text or display-text similarity', () => {
    const { current, cache } = saved();
    const turns: NativeTurn[] = [
      { role: 'user', text: rawInput },
      { role: 'user', text: rawInput.trim(), nativeOperationId: 'operation-1' },
      { role: 'user', text: '改成抽屉', nativeOperationId: 'operation-1' },
      { role: 'agent', text: `${rawOutput}\n`, nativeRunId: 'run-1' },
      { role: 'user', text: rawInput, nativeRunId: 'run-1' },
      { role: 'system', text: rawInput, nativeOperationId: 'operation-1' },
    ];
    projectConversationTurns(current, turns, cache).forEach((turn, index) => expect(turn).toBe(turns[index]));
  });

  it('keeps repeated identical requests from different operations separate', () => {
    const { current, cache } = saved();
    expect(beginConversationPresentation(current, 'operation-2', rawInput, { ...presentation(), displayText: '同一句需求再次执行' }, cache)).toBe(true);
    const turns: NativeTurn[] = ['operation-1', 'operation-2'].map(nativeOperationId => ({ role: 'user', text: rawInput, nativeOperationId }));
    const projected = projectConversationTurns(current, turns, cache);
    expect(projected).toHaveLength(2);
    expect(projected.map(turn => turn.presentation?.displayText)).toEqual(['改成抽屉', '同一句需求再次执行']);
  });

  it('is idempotent only for the original execution text and never rewrites its display mapping', () => {
    const { current, cache } = saved();
    const writes = cache.setItem.mock.calls.length;
    expect(beginConversationPresentation(current, 'operation-1', rawInput, { ...presentation(), displayText: '替换后的文字' }, cache)).toBe(true);
    expect(beginConversationPresentation(current, 'operation-1', `${rawInput}不同`, presentation(), cache)).toBe(false);
    expect(cache.setItem).toHaveBeenCalledTimes(writes);
    const [turn] = projectConversationTurns(current, [{ role: 'user', text: rawInput, nativeOperationId: 'operation-1' }], cache);
    expect(turn.presentation?.displayText).toBe('改成抽屉');
  });

  it.each(['company', 'agent', 'node', 'thread', 'issue', 'unbound'] as const)('isolates the %s identity', dimension => {
    const { current, cache } = saved();
    let other = { ...current };
    if (dimension === 'company') other.binding = { ...current.binding!, companyId: 'company-2' };
    if (dimension === 'agent') other.binding = { ...current.binding!, agentId: 'agent-2' };
    if (dimension === 'node') other.id = 'node-2';
    if (dimension === 'thread') other.activeThreadId = 'thread-2';
    if (dimension === 'issue') other.issueId = 'issue-2';
    if (dimension === 'unbound') other.binding = null;
    const turn: NativeTurn = { role: 'user', text: rawInput, nativeOperationId: 'operation-1' };
    expect(projectConversationTurns(other, [turn], cache)[0]).toBe(turn);
  });

  it('records a newly accepted issue before projecting restored comments', () => {
    const current = node({ issueId: null });
    const cache = store();
    expect(beginConversationPresentation(current, 'operation-1', rawInput, presentation(), cache)).toBe(true);
    const accepted = { ...current, issueId: 'new-issue' };
    const turn: NativeTurn = { role: 'user', text: rawInput, nativeOperationId: 'operation-1' };
    expect(projectConversationTurns(accepted, [turn], cache)[0]).toBe(turn);
    expect(updateConversationPresentation(current, 'operation-1', { issueId: 'new-issue', runId: 'new-run' }, cache)).toBe(true);
    expect(projectConversationTurns(accepted, [turn], cache)[0].presentation?.displayText).toBe('改成抽屉');
  });

  it('rejects ambiguous or contradictory operation/run markers', () => {
    const { current, cache } = saved();
    const turns: NativeTurn[] = [
      { role: 'agent', text: rawOutput, nativeOperationId: 'operation-1', nativeRunId: 'different-run' },
      { role: 'agent', text: rawOutput, nativeOperationId: 'operation-1', recoveryOperationId: 'different-operation' },
      { role: 'agent', text: rawOutput, nativeRunId: 'run-1', recoveryRunId: 'different-run' },
    ];
    projectConversationTurns(current, turns, cache).forEach((turn, index) => expect(turn).toBe(turns[index]));
    expect(beginConversationPresentation(current, 'operation-2', rawInput, presentation(), cache)).toBe(true);
    expect(updateConversationPresentation(current, 'operation-2', { runId: 'run-1', outputState: 'final', outputText: rawOutput }, cache)).toBe(true);
    const runOnly: NativeTurn = { role: 'agent', text: rawOutput, nativeRunId: 'run-1' };
    expect(projectConversationTurns(current, [runOnly], cache)[0]).toBe(runOnly);
  });

  it('freezes the submitted contract independently of later node and caller changes', () => {
    const current = node();
    const cache = store();
    const original = presentation();
    current.contract = original.outputContract;
    expect(beginConversationPresentation(current, 'operation-1', rawInput, original, cache)).toBe(true);
    original.outputContract!.outputs[0].label = '后来改过的标题';
    original.outputContract!.outputs.push({ id: 'new', label: '新增字段', type: 'number', required: true, value: '' });
    updateConversationPresentation(current, 'operation-1', { runId: 'run-1', outputState: 'final', outputText: rawOutput }, cache);
    const turn: NativeTurn = { role: 'agent', text: rawOutput, nativeRunId: 'run-1' };
    const [projected] = projectConversationTurns(current, [turn], cache);
    expect(projected.presentation?.outputContract).toEqual(presentation().outputContract);
    projected.presentation!.outputContract!.outputs[0].label = '修改显示对象';
    expect(projectConversationTurns(current, [turn], cache)[0].presentation?.outputContract?.outputs[0].label).toBe('本轮成果');
  });

  it('allows input-only metadata and valid legacy histories without guessing from their bodies', () => {
    const cache = store();
    const current = node();
    const longBody = `AwwO conversation Operation: operation-1\n${rawInput.repeat(100)}`;
    beginConversationPresentation(current, 'operation-1', rawInput, { inputKind: 'manual', displayText: '原话' }, cache);
    const turns: NativeTurn[] = [
      { role: 'user', text: rawInput, nativeOperationId: 'operation-1' },
      { role: 'user', text: longBody },
      { role: 'agent', text: rawOutput },
    ];
    const projected = projectConversationTurns(current, turns, cache);
    expect(projected[0].presentation).toEqual({ inputKind: 'manual', displayText: '原话' });
    expect(projected[1]).toBe(turns[1]);
    expect(projected[2]).toBe(turns[2]);
  });
});

describe('optional presentation storage', () => {
  it.each(['get', 'set'] as const)('contains a throwing %sItem without touching the raw history', failure => {
    const current = node();
    const cache = store();
    if (failure === 'get') cache.getItem.mockImplementation(() => { throw new Error('Storage blocked'); });
    else cache.setItem.mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    expect(beginConversationPresentation(current, 'operation-1', rawInput, presentation(), cache)).toBe(false);
    expect(updateConversationPresentation(current, 'operation-1', { outputState: 'final' }, cache)).toBe(false);
    const turn: NativeTurn = { role: 'user', text: rawInput, nativeOperationId: 'operation-1' };
    expect(projectConversationTurns(current, [turn], cache)[0]).toBe(turn);
    if (failure === 'get') expect(cache.setItem).not.toHaveBeenCalled();
  });

  it('returns false on quota failure while preserving the previous valid cached state', () => {
    const { current, cache } = saved();
    const snapshot = [...cache.values.entries()];
    cache.setItem.mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(updateConversationPresentation(current, 'operation-1', { outputState: 'failed' }, cache)).toBe(false);
    expect([...cache.values.entries()]).toEqual(snapshot);
    const [projected] = projectConversationTurns(current, [{ role: 'agent', text: rawOutput, nativeRunId: 'run-1' }], cache);
    expect(projected.presentation?.outputState).toBe('final');
  });

  it.each(['undefined', 'getter'] as const)('handles globally unavailable localStorage (%s) before default argument evaluation', mode => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    if (mode === 'undefined') Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); } });
    try {
      const current = node();
      expect(beginConversationPresentation(current, 'operation-1', rawInput, presentation())).toBe(false);
      expect(updateConversationPresentation(current, 'operation-1', { outputState: 'final' })).toBe(false);
      const turn: NativeTurn = { role: 'user', text: rawInput, nativeOperationId: 'operation-1' };
      expect(projectConversationTurns(current, [turn])[0]).toBe(turn);
      // Explicit adapters still work in browser contexts that prohibit localStorage.
      const cache = store();
      expect(beginConversationPresentation(current, 'operation-1', rawInput, presentation(), cache)).toBe(true);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it.each(['not json', '{"version":2,"records":[]}', '{"version":1,"records":[{}]}', 'x'.repeat(1_000_001)])('falls back safely for a corrupt or oversized cache (case %#)', source => {
    const cache = store();
    cache.getItem.mockReturnValue(source);
    const turn: NativeTurn = { role: 'user', text: rawInput, nativeOperationId: 'operation-1' };
    expect(projectConversationTurns(node(), [turn], cache)[0]).toBe(turn);
  });

  it('rejects invalid stored presentation states and contract shapes', () => {
    const { current, cache } = saved();
    const [name, value] = [...cache.values.entries()][0];
    const original = JSON.parse(value);
    for (const invalid of [
      { outputState: 'succeeded' },
      { inputKind: 'guessed-from-text' },
      { displayText: 1 },
      { outputContract: { version: 900, inputs: [], outputs: [] } },
    ]) {
      const bad = structuredClone(original);
      Object.assign(bad.records[0].presentation, invalid);
      cache.values.set(name, JSON.stringify(bad));
      const turn: NativeTurn = { role: 'agent', text: rawOutput, nativeRunId: 'run-1' };
      expect(projectConversationTurns(current, [turn], cache)[0]).toBe(turn);
    }
  });

  it('contains unserializable or invalid presentation data instead of blocking dispatch', () => {
    const cache = store();
    const cyclic = presentation();
    (cyclic as unknown as { loop: unknown }).loop = cyclic;
    expect(beginConversationPresentation(node(), 'operation-1', rawInput, cyclic, cache)).toBe(false);
    expect(beginConversationPresentation(node(), 'operation-1', rawInput, { outputContract: { version: 2 } as unknown as NodeContract }, cache)).toBe(false);
    expect(cache.setItem).not.toHaveBeenCalled();
  });
});

describe('native operation metadata', () => {
  const metadata = (operation = 'operation-1') => ({ version: 1, sections: [{ title: 'AwwO conversation', rows: [{ type: 'key_value', label: 'Operation', value: operation }] }] });

  it('reads the single exact gateway operation marker', () => {
    expect(nativeConversationOperation(metadata())).toBe('operation-1');
  });

  it.each([
    'AwwO conversation\nOperation: operation-1',
    { body: JSON.stringify(metadata()) },
    { version: 2, sections: metadata().sections },
    { version: 1, sections: [{ title: 'User message', rows: metadata().sections[0].rows }] },
    { version: 1, sections: [{ title: 'AwwO conversation', rows: [{ type: 'text', label: 'Operation', value: 'operation-1' }] }] },
    { version: 1, sections: [{ title: 'AwwO conversation', rows: [{ type: 'key_value', label: 'operation', value: 'operation-1' }] }] },
    metadata(''),
    null,
  ])('does not infer identity from the message body or an invalid metadata shape (case %#)', value => {
    expect(nativeConversationOperation(value)).toBeUndefined();
  });

  it('rejects duplicate identity rows even if their strings agree', () => {
    const duplicate = metadata();
    duplicate.sections[0].rows.push({ ...duplicate.sections[0].rows[0] });
    expect(nativeConversationOperation(duplicate)).toBeUndefined();
  });
});

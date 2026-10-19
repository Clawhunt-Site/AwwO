import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedCall, approvalDisplay, cardCall } from './runtime.ts';
import type { CapturedCall } from './transport.ts';
import { WorkerError } from './protocol.ts';

// A card is paired with the call it is for by the core's own record of the calls it has taken (runtime.ts cardCall);
// the whole broker against a core is in approval-pairing.test.ts.
const activity = (itemId: string) => ({ id: `a-${itemId}`, role: 'bot', kind: 'activity', tool: { name: 'awwo_workspace_write', itemId } });
const write = (id: string, path: string, content: string, extra: Record<string, unknown> = {}): CapturedCall => ({ id, tool: 'awwo_workspace_write', arguments: { path, content, ...extra } });
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof WorkerError ? error.code : String(error); } return 'paired'; };

test('a card is paired with the first call the core has not taken, by the model\'s call id', () => {
  const decoy = write('c1', 'notes.txt', 'decoy', { mode: 'append' }), real = write('c2', 'index.html', '<h1>real</h1>');
  // The core refused the decoy (its schema has no `mode`): its activity is written before the real call's card.
  assert.equal(cardCall([decoy, real], [activity('c1')], 'awwo_workspace_write'), real);
  // The same across answers: a refusal in an earlier answer never shifts a later card.
  const later = write('c3', 'b.txt', 'two');
  assert.equal(cardCall([decoy, real, later], [activity('c1'), activity('c2')], 'awwo_workspace_write'), later);
  // A call already paired with a card is passed over while its own card is open (its activity comes after the answer).
  real.card = 'request-1';
  assert.equal(cardCall([decoy, real, later], [activity('c1')], 'awwo_workspace_write'), later);
  // Activities without the call's id, and other messages, take nothing.
  const fresh = [write('c1', 'a.txt', 'one'), write('c2', 'b.txt', 'two')];
  assert.equal(cardCall(fresh, [{ kind: 'text', tool: { itemId: 'c1' } }, { kind: 'activity', tool: { name: 'error: x' } }, null, 'x'], 'awwo_workspace_write'), fresh[0]);
});

test('a card whose call is not the first open call, or has no readable arguments, is never paired', () => {
  const big: CapturedCall = { id: 'c1', tool: 'awwo_workspace_write' }, real = write('c2', 'index.html', '<h1>real</h1>');
  // Too large to capture: the core's card is for it, and the readable call after it is never shown in its place.
  assert.equal(code(() => cardCall([big, real], [], 'awwo_workspace_write')), 'APPROVAL_ARGUMENTS_UNAVAILABLE');
  // The first open call is another tool: never skip ahead to a later call of the card's tool.
  const exec: CapturedCall = { id: 'c3', tool: 'awwo_workspace_exec', arguments: { command: 'ls' } };
  assert.equal(code(() => cardCall([exec, real], [], 'awwo_workspace_write')), 'APPROVAL_CALL_UNMATCHED');
  // No open call, or a card that names no tool.
  assert.equal(code(() => cardCall([real], [activity('c2')], 'awwo_workspace_write')), 'APPROVAL_CALL_UNMATCHED');
  assert.equal(code(() => cardCall([], [], 'awwo_workspace_write')), 'APPROVAL_CALL_UNMATCHED');
  assert.equal(code(() => cardCall([real], [], undefined)), 'APPROVAL_CALL_UNMATCHED');
});

test('a call to a tool the core does not advertise is passed over, and an id two captured calls share pairs with neither', () => {
  // The core refuses x__ask_bot before any card and writes no activity for it (server/index.ts): the write's card is the write's.
  const unadvertised: CapturedCall = { id: 'c1', tool: 'x__ask_bot', arguments: {} }, real = write('c2', 'index.html', '<h1>real</h1>');
  assert.equal(cardCall([unadvertised, real], [], 'awwo_workspace_write'), real);
  // An open question is the core's next step (it writes the question's activity before its card): no tool card comes first.
  const ask: CapturedCall = { id: 'c0', tool: 'ask_user', arguments: { questions: [] } };
  assert.equal(code(() => cardCall([ask, real], [], 'awwo_workspace_write')), 'APPROVAL_CALL_UNMATCHED');
  // Two captured calls with one id, whichever comes first: never paired.
  const ghost = write('c2', 'index.html', 'ghost');
  assert.equal(code(() => cardCall([ghost, real], [], 'awwo_workspace_write')), 'APPROVAL_CALL_UNMATCHED');
  assert.equal(code(() => cardCall([real, ghost], [], 'awwo_workspace_write')), 'APPROVAL_CALL_UNMATCHED');
});

test('an allow runs only its own call: the same tool with exactly its arguments', () => {
  const allowed = new Set([write('c1', 'index.html', '<h1>real</h1>')]);
  assert.equal(allowedCall(allowed, 'write', { path: 'index.html', content: '<h1>real</h1>' }), [...allowed][0]);
  // The same value is the same arguments, whatever order its keys come in.
  assert.equal(allowedCall(allowed, 'write', { content: '<h1>real</h1>', path: 'index.html' }), [...allowed][0]);
  for (const [name, args] of [['write', { path: 'index.html', content: 'other' }], ['write', { path: 'index.html' }], ['write', { path: 'index.html', content: '<h1>real</h1>', mode: 'append' }],
    ['exec', { path: 'index.html', content: '<h1>real</h1>' }], ['write', null], ['write', 'index.html']] as const) {
    assert.equal(allowedCall(allowed, name, args), undefined, JSON.stringify([name, args]));
  }
  assert.equal(allowedCall(new Set(), 'write', { path: 'index.html', content: '<h1>real</h1>' }), undefined);
});

test('tool approval displays its real tool name without duplicating complete command arguments', () => {
  const argumentsValue = { command: 'python3 -c "print(42)"\n' + '# actual source\n'.repeat(1000) };
  const card = { title: 'Approval needed', subtitle: JSON.stringify(argumentsValue, null, 2), tool: 'awwo_workspace_exec' };
  const before = JSON.stringify(argumentsValue);
  const display = approvalDisplay('approval', card, 'awwo_workspace_exec', []);
  const event = { ...display, arguments: argumentsValue };
  assert.equal(display.title, 'awwo_workspace_exec');
  assert.ok(display.description.includes('完整参数'));
  assert.ok(!display.description.includes('python3'));
  assert.ok(Buffer.byteLength(display.description) < 200);
  assert.equal(display.truncated, false);
  assert.equal(event.arguments, argumentsValue);
  assert.equal(JSON.stringify(event.arguments), before);
});

test('question title and human-facing question remain unchanged', () => {
  const display = approvalDisplay('question', { title: '保留生成文件？', subtitle: '请选择保留或重新生成。' }, 'ask_user', []);
  assert.equal(display.title, '保留生成文件？');
  assert.equal(display.description, '请选择保留或重新生成。');
  assert.equal(display.truncated, false);
});

test('truncated tool JSON is not repeated, and question display retains byte bounds and redaction', () => {
  assert.ok(!approvalDisplay('approval', { title: 'Approval needed', subtitle: '{"command":"secret partial...' }, 'awwo_workspace_exec', []).description.includes('command'));
  const question = approvalDisplay('question', { title: '问题'.repeat(200), subtitle: 'TOKEN-SECRET' + '中文'.repeat(5000) }, 'ask_user', ['TOKEN-SECRET']);
  assert.ok(Buffer.byteLength(question.title) <= 200); assert.ok(Buffer.byteLength(question.description) <= 8192);
  assert.equal(question.truncated, true); assert.ok(!question.description.includes('TOKEN-SECRET')); assert.ok(question.description.includes('[redacted]'));
});

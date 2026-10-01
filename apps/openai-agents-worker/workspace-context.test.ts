import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import type { Model } from '@openai/agents';
import { fitWorkspaceContext, workspaceContextSize } from './workspace-context.ts';
import { errorDiagnostic } from './errors.mjs';
import { executeWorkspaceAgent } from './workspace-runtime.ts';

type Request = Parameters<Model['getStreamedResponse']>[0];
type Item = Exclude<Request['input'], string>[number];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
const user: Item = { type: 'message', role: 'user', content: 'Build the authorized game. Preserve the original requirements and do not invent successful tests.' };
const call = (id: string, name: string, args: Record<string, unknown>): Item => ({ type: 'function_call', callId: id, name, arguments: JSON.stringify(args) });
const output = (id: string, name: string, result: unknown): Item => ({ type: 'function_call_result', callId: id, name, output: JSON.stringify(result), status: 'completed' });
const reasoning = (id: string, length = 1200): Item => ({ type: 'reasoning', id, content: [], rawContent: [{ type: 'reasoning_text', text: 'private-reasoning-' + id + '-'.repeat(length) }] });
const request = (input: Item[]): Request => ({ systemInstructions: 'Original developer requirements must remain byte-for-byte.', input, modelSettings: { maxTokens: 4096 }, tools: [], outputType: 'text', handoffs: [], tracing: false });
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
function checkpoint(request: Request): string {
  assert.ok(Array.isArray(request.input));
  return request.input.flatMap(item => item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)
    ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n');
}
function assertPairs(input: Request['input']) {
  assert.ok(Array.isArray(input));
  for (const [index, item] of input.entries()) {
    if (item.type === 'function_call') assert.ok(input.some((result, next) => next > index && result.type === 'function_call_result' && result.callId === item.callId && result.name === item.name));
    if (item.type === 'function_call_result') assert.ok(input.some((previous, earlier) => earlier < index && previous.type === 'function_call' && previous.callId === item.callId && previous.name === item.name));
  }
}

test('under budget context is returned untouched', () => {
  const source = deepFreeze(request([user]));
  assert.equal(fitWorkspaceContext(source, bytes(source)), source);
});

test('compaction retains original task and latest pair without mutating SDK history', () => {
  const oldSource = '<html>' + 'old-source'.repeat(1200) + '</html>';
  const oldCall = call('old', 'workspace_write', { path: 'index.html', content: oldSource });
  const oldResult = output('old', 'workspace_write', { written: 'index.html', bytes: oldSource.length, sha256: checksum(oldSource) });
  const lastCall = call('recent', 'workspace_exec', { command: 'node --test test.mjs' });
  const lastResult = output('recent', 'workspace_exec', { exitCode: 1, stdout: '1 failed test', stderr: 'required behaviour missing', truncated: false });
  const original = deepFreeze(request([user, oldCall, oldResult, lastCall, lastResult]));
  const originalJSON = JSON.stringify(original);
  const result = fitWorkspaceContext(original, 2500);
  assert.ok(bytes(result) <= 2500); assert.notEqual(result, original);
  assert.equal(JSON.stringify(original), originalJSON);
  assert.equal(result.systemInstructions, original.systemInstructions);
  assert.ok(Array.isArray(result.input));
  assert.deepEqual(result.input[0], user); assert.deepEqual(result.input.slice(-2), [lastCall, lastResult]);
  assertPairs(result.input);
  assert.ok(checkpoint(result).includes(checksum(oldSource)) && !checkpoint(result).includes(oldSource));
  assert.ok(checkpoint(result).includes('Re-read a file') && checkpoint(result).includes('not a claim that tests passed'));
});

test('checkpoint records the actual failed command, exit code and explicit log truncation', () => {
  const original = request([user,
    call('failure', 'workspace_exec', { command: 'node --test failing.mjs' }),
    output('failure', 'workspace_exec', { exitCode: 1, stdout: 'failed assertion\n' + 'x'.repeat(8000), stderr: 'invalid state', truncated: false }),
    call('recent', 'workspace_list', { path: '.' }), output('recent', 'workspace_list', [])]);
  const result = fitWorkspaceContext(original, 4000);
  const text = checkpoint(result);
  assert.ok(text.includes('node --test failing.mjs')); assert.ok(text.includes('"exitCode":1'));
  assert.ok(text.includes('"stdoutExcerpt":true')); assert.ok(text.includes('invalid state'));
  assertPairs(result.input);
});

test('unknown tools, incomplete calls, mismatched names and human instructions are never silently elided', () => {
  for (const oldPair of [
    [call('old', 'external_action', { content: 'x'.repeat(8000) }), output('old', 'external_action', { ok: true })],
    [call('old', 'workspace_write', { content: 'x'.repeat(8000) })],
    [call('old', 'workspace_write', { content: 'x'.repeat(8000) }), output('old', 'workspace_read', { ok: true })],
  ]) {
    const source = deepFreeze(request([user, ...oldPair, call('recent', 'workspace_list', { path: '.' }), output('recent', 'workspace_list', [])]));
    assert.throws(() => fitWorkspaceContext(source, 1500), /context exceeds/);
  }
  const hugeHuman = request([{ type: 'message', role: 'user', content: 'important human requirements'.repeat(1000) }]);
  assert.throws(() => fitWorkspaceContext(hugeHuman, 1000), /context exceeds/);
});

test('an oversized latest read preserves its pair and verified identity with an explicit bounded UTF-8 preview', () => {
  const content = '游戏中文🙂'.repeat(9000);
  const source = deepFreeze(request([user, call('latest', 'workspace_read', { path: 'large.txt' }), output('latest', 'workspace_read', { path: 'large.txt', content, encoding: 'utf8', byteLength: Buffer.byteLength(content), sha256: checksum(content) })]));
  const before = JSON.stringify(source);
  const compact = fitWorkspaceContext(source, 2500);
  assert.equal(JSON.stringify(source), before); assert.ok(bytes(compact) <= 2500); assertPairs(compact.input);
  assert.ok(Array.isArray(compact.input)); assert.deepEqual(compact.input[0], user);
  const result = compact.input.at(-1); assert.equal(result?.type, 'function_call_result');
  assert.ok(result?.type === 'function_call_result');
  const preview = JSON.parse(String(result.output));
  assert.equal(preview.contextTruncated, true); assert.equal(preview.contentOmitted, true); assert.equal(preview.content, undefined);
  assert.equal(preview.sha256, checksum(content)); assert.equal(preview.byteLength, Buffer.byteLength(content));
  assert.equal(Buffer.byteLength(preview.contentPreview), preview.previewBytes); assert.ok(content.startsWith(preview.contentPreview));
  assert.ok(preview.nextRead.includes('4096 bytes') && preview.nextRead.includes('explicit byte offset'));
  assert.equal(compact.systemInstructions, source.systemInstructions);
});

test('a large binary read omits base64 rather than pretending its prefix is the complete file', () => {
  const content = Buffer.alloc(80_000, 123).toString('base64');
  const source = request([user, call('binary', 'workspace_read', { path: 'project.zip' }), output('binary', 'workspace_read', { path: 'project.zip', content, encoding: 'base64', byteLength: 80_000, sha256: 'a'.repeat(64) })]);
  const compact = fitWorkspaceContext(source, 2500); assertPairs(compact.input); assert.ok(bytes(compact) <= 2500);
  assert.ok(Array.isArray(compact.input)); const result = compact.input.at(-1); assert.ok(result?.type === 'function_call_result');
  const preview = JSON.parse(String(result.output));
  assert.equal(preview.encoding, 'base64'); assert.equal(preview.byteLength, 80_000);
  assert.equal(preview.content, undefined); assert.equal(preview.contentPreview, undefined); assert.equal(preview.contentOmitted, true);
});

test('oversized latest terminal logs retain the real failing exit code and label excerpts', () => {
  const source = request([user, call('terminal', 'workspace_exec', { command: 'node --test large-output.test.mjs' }), output('terminal', 'workspace_exec', { exitCode: 1, stdout: 'failed assertion\n' + 'x'.repeat(60_000), stderr: 'failure details\n' + 'y'.repeat(20_000), truncated: true })]);
  const compact = fitWorkspaceContext(source, 4000); assertPairs(compact.input); assert.ok(bytes(compact) <= 4000);
  assert.ok(Array.isArray(compact.input)); const result = compact.input.at(-1); assert.ok(result?.type === 'function_call_result');
  const preview = JSON.parse(String(result.output));
  assert.equal(preview.exitCode, 1); assert.equal(preview.truncated, true); assert.equal(preview.contextTruncated, true);
  assert.equal(preview.stdoutExcerpt, true); assert.equal(preview.stderrExcerpt, true);
  assert.ok(preview.stdout.startsWith('failed assertion')); assert.ok(preview.stderr.startsWith('failure details'));
  assert.ok(preview.outputNotice.includes('omitted logs do not imply success'));
});

test('an oversized completed latest write becomes an explicit receipt without modifying real source history', () => {
  const content = 'function game() {}\n'.repeat(3000);
  const source = deepFreeze(request([user, call('write', 'workspace_write', { path: 'game.js', content }), output('write', 'workspace_write', { written: 'game.js', bytes: Buffer.byteLength(content), sha256: checksum(content) })]));
  const before = JSON.stringify(source); const compact = fitWorkspaceContext(source, 2500);
  assert.equal(JSON.stringify(source), before); assert.ok(bytes(compact) <= 2500); assertPairs(compact.input);
  const summary = checkpoint(compact); assert.ok(summary.includes('"latestInteraction":true') && summary.includes(checksum(content)));
  assert.ok(summary.includes('"sourceOmitted":true') && summary.includes('game.js')); assert.ok(!summary.includes(content));
});

test('a completed batch execution with large source arguments preserves command identity and actual failure evidence', () => {
  const command = "python3 - <<'PY'\n# model/report/agent source batch\n" + '# actual project source\n'.repeat(3000) + "print('generated files')\nPY";
  const source = deepFreeze(request([user, call('batch', 'workspace_exec', { command }), output('batch', 'workspace_exec', { exitCode: 1, stdout: 'created model.glb, report.md, agent.py\n', stderr: 'agent test failed: expected 4, got 3', truncated: false })]));
  const before = JSON.stringify(source); const compact = fitWorkspaceContext(source, 5000);
  assert.equal(JSON.stringify(source), before); assert.ok(bytes(compact) <= 5000); assertPairs(compact.input);
  const summary = checkpoint(compact);
  assert.ok(summary.includes('"latestInteraction":true') && summary.includes('"commandExcerpt":true'));
  assert.ok(summary.includes(checksum(command)) && summary.includes('"exitCode":1'));
  assert.ok(summary.includes('agent test failed: expected 4, got 3'));
  assert.ok(!summary.includes(command)); assert.equal(compact.systemInstructions, source.systemInstructions);
});

test('an impossible budget or uncompleted latest tool still fails instead of silently losing the original task', () => {
  const source = request([user, call('latest', 'workspace_read', { path: 'large.txt' }), output('latest', 'workspace_read', { content: 'x'.repeat(9000), encoding: 'utf8' })]);
  assert.throws(() => fitWorkspaceContext(source, 100), /context exceeds/);
  assert.throws(() => fitWorkspaceContext(request([user, call('write', 'workspace_write', { path: 'a', content: 'x'.repeat(40_000) })]), 2500), /context exceeds/);
});

test('context-limit diagnostics identify byte pressure without revealing task text, command, file path or content', () => {
  const privateText = 'private-model-prompt-source-path-key';
  const command = privateText.repeat(2000);
  const source = request([{ type: 'message', role: 'user', content: privateText.repeat(3000) },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'tool discussion'.repeat(500) }] },
    call('latest', 'workspace_exec', { command }), output('latest', 'workspace_exec', { exitCode: 1, stdout: privateText, stderr: '', truncated: false })]);
  assert.throws(() => fitWorkspaceContext(source, 3000), (error: unknown) => {
    const diagnostic = errorDiagnostic(error);
    assert.equal(diagnostic.category, 'budget');
    assert.ok('contextSize' in diagnostic);
    const counts = diagnostic.contextSize as Record<string, number>;
    assert.equal(counts.budgetBytes, 3000); assert.equal(counts.requestBytes, bytes(source));
    assert.ok(counts.latestArgumentsBytes > 60_000 && counts.userMessageBytes > 90_000);
    assert.ok(counts.assistantMessageBytes > 6000 && counts.projectedBytes < counts.requestBytes);
    assert.ok(Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0));
    assert.ok(!JSON.stringify(diagnostic).includes(privateText));
    return true;
  });
  assert.equal(workspaceContextSize({ ...source, tools: undefined } as unknown as Request, 3000).toolDefinitionsBytes, 0);
  const broken = { ...source, input: undefined } as unknown as Request;
  Object.defineProperty(broken, 'input', { get() { throw new Error('malformed SDK value'); } });
  assert.deepEqual(workspaceContextSize(broken, 3000), {});
});

test('aggregate completed receipts tighten their excerpts to fit while preserving original task and actual execution evidence', () => {
  const task: Item = { type: 'message', role: 'user', content: 'U'.repeat(6702) };
  const entries = Array.from({ length: 9 }, (_, index) => {
    const command = `python3 - <<'PY'\n# delivery stage ${index}\n` + '# source\n'.repeat(180) + '\nPY';
    return { command, pair: [call('step-' + index, 'workspace_exec', { command }), output('step-' + index, 'workspace_exec', { exitCode: index === 3 ? 1 : 0, stdout: 'actual command output ' + 'x'.repeat(1100), stderr: index === 3 ? 'test assertion failed' : '', truncated: false })] };
  });
  const source = deepFreeze({ ...request([task, ...entries.flatMap(item => item.pair)]), systemInstructions: 'D'.repeat(10_047) });
  const before = JSON.stringify(source);
  const compact = fitWorkspaceContext(source, 28_416);
  assert.ok(bytes(compact) <= 28_416); assert.equal(JSON.stringify(source), before); assertPairs(compact.input);
  assert.ok(Array.isArray(compact.input)); assert.deepEqual(compact.input[0], task);
  assert.deepEqual(compact.input.slice(-2), entries.at(-1)?.pair); assert.equal(compact.systemInstructions, source.systemInstructions);
  const text = checkpoint(compact); assert.match(text, /Excerpt budget per command\/log: (512|128|0) bytes/);
  for (const entry of entries.slice(0, -1)) { assert.ok(text.includes(checksum(entry.command))); assert.ok(text.includes('"commandBytes":' + Buffer.byteLength(entry.command))); }
  assert.ok(text.includes('"exitCode":1') && text.includes('test assertion failed'));
  assert.ok(text.includes('"commandExcerpt":true') && text.includes('"stdoutExcerpt":true'));
  // A tighter but still viable envelope reaches metadata-only receipts; missing
  // excerpts remain explicit, and original failing exit codes are still present.
  const metadataOnly = fitWorkspaceContext(source, 22_000);
  assert.ok(bytes(metadataOnly) <= 22_000); assertPairs(metadataOnly.input);
  const minimal = checkpoint(metadataOnly); assert.ok(minimal.includes('Excerpt budget per command/log: 0 bytes'));
  assert.ok(minimal.includes('"commandOmitted":true') && minimal.includes('"stdoutOmitted":true') && minimal.includes('"exitCode":1'));
});

test('accumulated completed reasoning is omitted with its checkpointed tools while the latest group stays intact', () => {
  const task: Item = { type: 'message', role: 'user', content: 'U'.repeat(6702) };
  const groups = Array.from({ length: 9 }, (_, index) => [reasoning('thinking-' + index),
    call('step-' + index, 'workspace_exec', { command: 'python3 - <<\'PY\'\n' + '# generated source\n'.repeat(100) + '\nPY' }),
    output('step-' + index, 'workspace_exec', { exitCode: index === 3 ? 1 : 0, stdout: 'actual output\n' + 'x'.repeat(1100), stderr: index === 3 ? 'assertion failed' : '', truncated: false })]);
  const original = deepFreeze({ ...request([task, ...groups.flat()]), systemInstructions: 'D'.repeat(10_047) });
  const before = JSON.stringify(original); const compact = fitWorkspaceContext(original, 28_416);
  assert.ok(bytes(compact) <= 28_416); assert.equal(JSON.stringify(original), before);
  assertPairs(compact.input); assert.ok(Array.isArray(compact.input));
  assert.deepEqual(compact.input.slice(-3), groups.at(-1)); assert.deepEqual(compact.input[0], task);
  assert.equal(compact.systemInstructions, original.systemInstructions);
  const text = checkpoint(compact); assert.match(text, /Reasoning omitted from [1-8] completed assistant turns/);
  assert.ok(!text.includes('private-reasoning-')); assert.ok(text.includes('"exitCode":1'));
  const counts = workspaceContextSize(original, 28_416, compact);
  assert.equal(counts.reasoningItemCount, 9); assert.equal(counts.otherItemBytes, 0);
  assert.ok(counts.reasoningBytes > 10_000 && counts.projectedReasoningBytes < counts.reasoningBytes);
  assert.equal(counts.inputBytes, counts.userMessageBytes + counts.assistantMessageBytes + counts.otherMessageBytes
    + counts.reasoningBytes + counts.toolCallBytes + counts.toolResultBytes + counts.otherItemBytes + counts.inputFramingBytes);
  assert.equal(counts.requestBytes, counts.systemBytes + counts.toolDefinitionsBytes + counts.inputBytes + counts.requestOtherBytes);
});

test('completed text-only reasoning can be omitted explicitly without losing the actual assistant message', () => {
  const assistant: Item = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The previous result is incomplete; the files still need testing.' }] };
  const source = deepFreeze(request([user, reasoning('previous', 20_000), assistant]));
  const before = JSON.stringify(source), compact = fitWorkspaceContext(source, 2500);
  assert.equal(JSON.stringify(source), before); assert.ok(Array.isArray(compact.input));
  assert.deepEqual(compact.input[0], user); assert.deepEqual(compact.input.at(-1), assistant);
  assert.ok(checkpoint(compact).includes('Reasoning omitted from 1 completed assistant turns'));
  assert.ok(!JSON.stringify(compact).includes('private-reasoning-previous'));
});

test('a latest read with large completed reasoning becomes an honest receipt with bounded reread guidance', () => {
  const content = 'The actual small file still exists; this is not a placeholder.';
  const original = deepFreeze(request([user, reasoning('large-read-reasoning', 20_000),
    call('read', 'workspace_read', { path: 'report.md' }),
    output('read', 'workspace_read', { path: 'report.md', content, encoding: 'utf8', byteLength: Buffer.byteLength(content), sha256: checksum(content) })]));
  const before = JSON.stringify(original), compact = fitWorkspaceContext(original, 2500);
  assert.ok(bytes(compact) <= 2500); assert.equal(JSON.stringify(original), before); assertPairs(compact.input);
  const text = checkpoint(compact);
  assert.ok(text.includes('"latestInteraction":true') && text.includes('"sourceOmitted":true'));
  assert.ok(text.includes('report.md') && text.includes(checksum(content)) && text.includes('"byteLength":' + Buffer.byteLength(content)));
  assert.ok(text.includes('Reasoning omitted from') && !text.includes(content));
  assert.ok(text.includes('Do not repeat an unbounded workspace_read') && text.includes('at most 4096 bytes'));
});

test('reasoning for incomplete, unknown, or partly retained parallel tool groups is not dropped', () => {
  const largeReasoning = reasoning('must-retain', 20_000);
  for (const tail of [
    [call('pending', 'workspace_exec', { command: 'node check.mjs' })],
    [call('unknown', 'external_action', {}), output('unknown', 'external_action', { ok: true })],
    [call('first', 'workspace_exec', { command: 'node check.mjs' }), call('pending', 'workspace_exec', { command: 'node check2.mjs' }), output('first', 'workspace_exec', { exitCode: 0 })],
    [{ type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: 'Working.' }] } as Item],
  ]) {
    const source = deepFreeze(request([user, largeReasoning, ...tail]));
    assert.throws(() => fitWorkspaceContext(source, 2500), { code: 'WORKSPACE_CONTEXT_LIMIT' });
  }
  const stillStreaming: Item = { ...largeReasoning, providerData: { status: 'in_progress' } };
  assert.throws(() => fitWorkspaceContext(request([user, stillStreaming, call('done', 'workspace_list', {}), output('done', 'workspace_list', [])]), 2500), { code: 'WORKSPACE_CONTEXT_LIMIT' });
  const latestReasoning = reasoning('latest', 20_000);
  const completed = request([user, latestReasoning, call('done', 'workspace_list', { path: '.' }), output('done', 'workspace_list', [])]);
  const compact = fitWorkspaceContext(completed, 2500);
  assertPairs(compact.input); assert.ok(checkpoint(compact).includes('"latestInteraction":true'));
  assert.ok(!JSON.stringify(compact).includes('private-reasoning-latest'));
});

test('adjacent reasoning items and their completed tool group are checkpointed atomically', () => {
  const group = [reasoning('first', 12_000), reasoning('second', 12_000),
    call('done', 'workspace_exec', { command: 'node check.mjs' }), output('done', 'workspace_exec', { exitCode: 1, stdout: 'test failed', stderr: '', truncated: false })];
  const source = deepFreeze(request([user, ...group]));
  const before = JSON.stringify(source), compact = fitWorkspaceContext(source, 2500);
  assert.equal(JSON.stringify(source), before); assertPairs(compact.input); assert.ok(Array.isArray(compact.input));
  assert.ok(compact.input.every(item => item.type !== 'reasoning' && item.type !== 'function_call' && item.type !== 'function_call_result'));
  assert.ok(checkpoint(compact).includes('1 completed assistant turns (2 reasoning items;'));
  assert.ok(checkpoint(compact).includes('"exitCode":1') && checkpoint(compact).includes('test failed'));
});

test('any incomplete adjacent reasoning item protects the whole group and tool pair even when partial compaction could fit', () => {
  for (const incompleteIndex of [0, 1]) {
    const thoughts = [reasoning('first', 50), reasoning('second', 50)];
    thoughts[incompleteIndex] = { ...thoughts[incompleteIndex], providerData: { status: 'in_progress' } };
    const group = [...thoughts, call('protected', 'workspace_write', { path: 'large.txt', content: 'x'.repeat(20_000) }),
      output('protected', 'workspace_write', { written: 'large.txt', bytes: 20_000, sha256: 'a'.repeat(64) })];
    const source = deepFreeze(request([user, ...group]));
    assert.throws(() => fitWorkspaceContext(source, 3500), { code: 'WORKSPACE_CONTEXT_LIMIT' });
    // Another eligible group can still shrink, but the protected group must
    // remain byte-for-byte, including both reasoning items and the full source.
    const other = [call('other', 'workspace_write', { path: 'other.txt', content: 'y'.repeat(30_000) }), output('other', 'workspace_write', { written: 'other.txt', bytes: 30_000 })];
    const combined = deepFreeze(request([user, ...other, ...group]));
    const compact = fitWorkspaceContext(combined, 25_000); assert.ok(Array.isArray(compact.input));
    assert.deepEqual(compact.input.slice(-group.length), group); assertPairs(compact.input);
  }
});

test('reasoning and tool completion matching cannot cross human or system boundaries', () => {
  for (const boundary of [user, { type: 'message', role: 'system', content: 'New system instruction.' } as Item]) {
    const source = deepFreeze(request([user, reasoning('before-boundary', 100),
      call('reused', 'workspace_write', { path: 'large.txt', content: 'x'.repeat(20_000) }), boundary,
      output('reused', 'workspace_write', { written: 'large.txt', bytes: 20_000 })]));
    assert.throws(() => fitWorkspaceContext(source, 3500), { code: 'WORKSPACE_CONTEXT_LIMIT' });
  }
  for (const boundary of [user, { type: 'message', role: 'system', content: 'Boundary.' } as Item, { type: 'unknown', providerData: {} } as Item]) {
    const source = request([user, reasoning('first', 20_000), boundary, reasoning('second', 100),
      call('done', 'workspace_list', { path: '.' }), output('done', 'workspace_list', [])]);
    assert.throws(() => fitWorkspaceContext(source, 3500), { code: 'WORKSPACE_CONTEXT_LIMIT' });
  }
});

test('safe diagnostics partition reasoning, other message and unknown SDK items without returning their content', () => {
  const secret = 'private-fixture-opaque-reasoning';
  const source = request([user, { type: 'message', role: 'system', content: secret.repeat(200) },
    { type: 'reasoning', content: [], providerData: { status: 'in_progress', encrypted_content: secret.repeat(500) } },
    { type: 'unknown', providerData: { opaque: secret.repeat(100) } }]);
  assert.throws(() => fitWorkspaceContext(source, 3000), (error: unknown) => {
    const diagnostic = errorDiagnostic(error); assert.ok('contextSize' in diagnostic);
    const counts = diagnostic.contextSize as Record<string, number>;
    assert.ok(counts.reasoningBytes > 10_000 && counts.otherMessageBytes > 5000 && counts.otherItemBytes > 2000);
    assert.equal(counts.reasoningItemCount, 1); assert.equal(counts.otherItemCount, 1);
    assert.equal(counts.projectedOtherItemBytes, counts.otherItemBytes); assert.equal(counts.projectedReasoningBytes, counts.reasoningBytes);
    assert.ok(counts.providerDataBytes > 15_000);
    assert.equal(counts.inputBytes, counts.userMessageBytes + counts.assistantMessageBytes + counts.otherMessageBytes + counts.reasoningBytes + counts.toolCallBytes + counts.toolResultBytes + counts.otherItemBytes + counts.inputFramingBytes);
    assert.ok(!JSON.stringify(diagnostic).includes(secret)); return true;
  });
});

for (const protocol of ['chat_completions', 'responses'] as const) for (const withReasoning of [false, true]) test(`SDK ${protocol} source editing with reasoning=${withReasoning} crosses the old byte ceiling while preserving task and tool pairs`, { timeout: 15_000 }, async t => {
  const requests: Record<string, unknown>[] = [], ledger: Record<string, unknown>[] = [];
  const first = '<!doctype html><title>Game</title><script>/*' + 'source-A'.repeat(6000) + '*/</script>';
  const second = first.replace('source-A', 'source-B');
  const batchCommand = "python3 - <<'PY'\n# BATCH_SOURCE_FIXTURE\n" + '# generated model report agent source\n'.repeat(1800) + "print('batch completed')\nPY";
  let content = '';
  const steps = [
    { name: 'workspace_write', args: { path: 'index.html', content: first } },
    { name: 'workspace_exec', args: { command: batchCommand } },
    { name: 'workspace_read', args: { path: 'index.html' } },
    { name: 'workspace_exec', args: { command: 'python3 -c "f=open(\'index.html\',\'rb\'); f.seek(4096); print(f.read(4096).decode(\'utf-8\',\'replace\'))"' } },
    { name: 'workspace_exec', args: { command: 'node --test game.test.mjs' } },
    { name: 'workspace_write', args: { path: 'index.html', content: second } },
    { name: 'workspace_exec', args: { command: 'node --test game.test.mjs' } },
    ...Array.from({ length: 5 }, (_, index) => ({ name: 'workspace_exec', args: { command: `python3 - <<'PY'\n# RECEIPT_AGGREGATE_${index}\n` + '# project delivery check\n'.repeat(75) + '\nPY' } })),
    { name: 'workspace_publish', args: { field: 'game', path: 'index.html' } },
  ];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const value = JSON.parse(body) as Record<string, unknown>;
    if (req.url === '/api/internal/workspace-calls') {
      ledger.push(value); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ index: value.index, [value.operation === 'admit' ? 'admitted' : 'settled']: true })); return;
    }
    requests.push(value);
    const step = steps[requests.length - 1];
    const thought = `private-reasoning-${requests.length}:` + 'R'.repeat(1500);
    res.setHeader('content-type', 'text/event-stream');
    if (protocol === 'responses') {
      const id = `item_${requests.length}`;
      const item = step ? { type: 'function_call', id, call_id: 'tool_' + requests.length, name: step.name, arguments: JSON.stringify(step.args), status: 'completed' }
        : { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"game":""}', annotations: [] }] };
      const reasoningItem = { type: 'reasoning', id: `reasoning_${requests.length}`, status: 'completed', summary: [{ type: 'summary_text', text: thought }], encrypted_content: 'opaque-fixture-' + 'E'.repeat(600) };
      const reasoningItems = withReasoning && step ? [reasoningItem, { ...reasoningItem, id: `reasoning_extra_${requests.length}`, summary: [{ type: 'summary_text', text: 'Second opaque item.' }], encrypted_content: 'opaque-second-item' }] : [];
      const outputIndex = reasoningItems.length;
      const response = { id: `response_${requests.length}`, object: 'response', created_at: 1, status: 'completed', model: 'fixture', output: [...reasoningItems, item], usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } };
      const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
      for (const [index, thoughtItem] of reasoningItems.entries()) {
        event('response.output_item.added', { output_index: index, item: { ...thoughtItem, status: 'in_progress', summary: [] } });
        event('response.output_item.done', { output_index: index, item: thoughtItem });
      }
      event('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', ...(step ? { arguments: '' } : { content: [] }) } });
      if (step) {
        event('response.function_call_arguments.delta', { item_id: id, output_index: outputIndex, delta: JSON.stringify(step.args) });
        event('response.function_call_arguments.done', { item_id: id, output_index: outputIndex, arguments: JSON.stringify(step.args) });
      } else {
        event('response.content_part.added', { item_id: id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        event('response.output_text.delta', { item_id: id, output_index: 0, content_index: 0, delta: '{"game":""}' });
        event('response.output_text.done', { item_id: id, output_index: 0, content_index: 0, text: '{"game":""}' });
        event('response.content_part.done', { item_id: id, output_index: 0, content_index: 0, part: item.content![0] });
      }
      event('response.output_item.done', { output_index: outputIndex, item });
      event('response.completed', { response }); res.end(); return;
    }
    const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'context_' + requests.length, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant', ...(withReasoning && step ? { reasoning: thought } : {}), ...(step ? { tool_calls: [{ index: 0, id: 'tool_' + requests.length, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { content: '{"game":""}' }) }, null);
    send({}, step ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const events: Record<string, unknown>[] = [];
  const task = { prompt: 'Keep the original game task and repair the failing game test.' + 'U'.repeat(6500), systemPrompt: 'The original developer instructions stay intact.' + 'D'.repeat(4500), messages: [], workspace: { version: 1 as const, id: 'a'.repeat(64), maxModelCalls: 16, callbackURL: `${origin}/api/internal/workspace-calls`, callbackToken: 'fixture-context-ledger-authorization', inputs: [], outputFields: [{ id: 'game', type: 'html' as const, required: true }] } };
  const untouched = JSON.stringify(task);
  let tests = 0;
  const file = () => ({ path: 'index.html', content, encoding: 'utf8', byteLength: Buffer.byteLength(content), sha256: checksum(content) });
  await executeWorkspaceAgent({ request: task, modelConfig: { model: 'fixture', apiKey: 'fixture', baseURL: `${origin}/v1`, protocol, contextWindow: 32_768, maxTokens: 4096 }, signal: new AbortController().signal,
    emit: async event => { events.push(event); }, broker: async (name, args) => {
      if (name === 'workspace_write') { content = String(args.content); return file(); }
      if (name === 'workspace_read' || name === 'workspace_publish') return file();
      if (name === 'workspace_exec') {
        if (String(args.command).includes('RECEIPT_AGGREGATE_')) return { exitCode: 0, stdout: 'verified delivery check ' + 'x'.repeat(1100), stderr: '', truncated: false };
        if (String(args.command).includes('BATCH_SOURCE_FIXTURE')) return { exitCode: 0, stdout: 'batch completed', stderr: '', truncated: false };
        if (String(args.command).includes('f.read(4096)')) return { exitCode: 0, stdout: Buffer.from(content).subarray(4096, 8192).toString('utf8'), stderr: '', truncated: false };
        return { exitCode: ++tests === 1 ? 1 : 0, stdout: tests === 1 ? 'failed test: repair collision' : 'game test passed', stderr: '', truncated: false };
      }
      if (name === 'snapshot') return { path: 'workspace.zip', content: Buffer.from('fixture zip').toString('base64'), encoding: 'base64', byteLength: 11, sha256: checksum('fixture zip') };
      throw new Error('unexpected tool');
    } });
  assert.equal(JSON.stringify(task), untouched); assert.equal(requests.length, 14);
  assert.equal(events.at(-1)?.type, 'completed'); assert.equal(JSON.parse(String(events.at(-1)?.text)).game, second);
  assert.equal(ledger.length, 28);
  if (withReasoning) {
    assert.ok(requests.some(value => JSON.stringify(value).includes('Reasoning omitted from')), 'real SDK history must exercise completed reasoning omission');
    assert.ok(requests.some(value => JSON.stringify(value).includes('private-reasoning-')), 'reasoning attached to retained tools must really reach the provider');
  }
  assert.ok(requests.some(value => JSON.stringify(value).includes('Host context checkpoint:')), 'the fixture must really exercise compaction');
  assert.ok(requests.some(value => /Excerpt budget per command\/log: (512|128|0) bytes/.test(JSON.stringify(value))), 'aggregate receipts must really exercise a smaller excerpt tier');
  assert.ok(JSON.stringify(requests[2]).includes(checksum(batchCommand)), 'completed batch source arguments must become an identified checkpoint');
  assert.ok(!JSON.stringify(requests[2]).includes(JSON.stringify(batchCommand).slice(1, -1)), 'the full batch source must not be replayed');
  assert.ok(JSON.stringify(requests[3]).includes('contextTruncated'), 'the large latest read must be honestly shortened');
  assert.ok(JSON.stringify(requests[3]).includes('4096 bytes'), 'the model must receive a usable bounded paging instruction');
  for (const value of requests) {
    const text = JSON.stringify(value);
    assert.ok(text.includes(task.prompt) && text.includes(task.systemPrompt));
    if (protocol === 'responses') {
      const items = value.input as { type?: string; id?: string; call_id?: string }[];
      for (const [index, item] of items.entries()) {
        if (item.type === 'function_call_output') assert.ok(items.slice(0, index).some(previous => previous.type === 'function_call' && previous.call_id === item.call_id), 'orphan Responses tool result');
        if (item.type === 'function_call') {
          assert.ok(items.slice(index + 1).some(next => next.type === 'function_call_output' && next.call_id === item.call_id), 'orphan Responses tool call');
          if (withReasoning) for (const prefix of ['reasoning_', 'reasoning_extra_']) assert.ok(items.slice(0, index).some(previous => previous.type === 'reasoning' && previous.id === item.call_id?.replace('tool_', prefix)), 'retained Responses call lost part of its opaque reasoning group');
        }
        if (withReasoning && item.type === 'reasoning') assert.ok(items.slice(index + 1).some(next => next.type === 'function_call' && next.call_id === item.id?.replace(/^reasoning_(extra_)?/, 'tool_')), 'orphan Responses reasoning');
      }
      continue;
    }
    const messages = value.messages as { role: string; reasoning?: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    for (const [index, message] of messages.entries()) {
      if (message.role === 'tool') assert.ok(messages.slice(0, index).some(previous => previous.tool_calls?.some(call => call.id === message.tool_call_id)), 'orphan tool result');
      for (const call of message.tool_calls ?? []) {
        assert.ok(messages.slice(index + 1).some(next => next.role === 'tool' && next.tool_call_id === call.id), 'orphan tool call');
        if (withReasoning) assert.ok(message.reasoning?.includes(call.id.replace('tool_', 'private-reasoning-') + ':'), 'retained Chat call lost its reasoning');
      }
    }
  }
  assert.ok(JSON.stringify(requests[4]).includes('f.read(4096)'), 'bounded pagination remains a real recorded tool invocation');
  assert.ok(JSON.stringify(requests[5]).includes('failed test: repair collision'), 'the newest failed test result remains verbatim');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDisplay } from './runtime.ts';

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

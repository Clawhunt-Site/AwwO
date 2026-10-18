import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreStopReason, failedTurnCode } from './runtime.ts';

const activity = (name: string, extra: Record<string, unknown> = {}) => ({ id: name, role: 'bot', kind: 'activity', tool: { name, ok: false, ...extra } });

test('a failed core turn is named by a closed label from the core\'s own error activity, never by its text', () => {
  assert.equal(coreStopReason([activity('error: model-call limit reached before a final response', { terminal: true })]), 'CORE_ROUND_LIMIT');
  assert.equal(coreStopReason([activity('error: One or more tool operations failed or were denied. See the tool results; the final response is not an execution receipt.')]), 'CORE_TOOL_FAILED');
  assert.equal(coreStopReason([activity('error: provider did not finish the response (length)')]), 'CORE_UNFINISHED_RESPONSE');
  assert.equal(coreStopReason([activity('error: provider returned an empty response')]), 'CORE_EMPTY_RESPONSE');
  // Any other error the core reports is only an error; its text (which can quote a provider) is not repeated.
  assert.equal(coreStopReason([activity('error: SECRET provider body')]), 'CORE_ERROR');
  // The last error activity names the stop; tool activities, texts and malformed entries are not errors.
  assert.equal(coreStopReason([activity('error: provider returned an empty response'), activity('error: model-call limit reached before a final response')]), 'CORE_ROUND_LIMIT');
  assert.equal(coreStopReason([{ kind: 'activity', tool: { name: 'list', ok: true } }, { kind: 'text', role: 'bot', text: 'error: model-call limit reached before a final response' }, null, 'x', { kind: 'activity' }, { kind: 'activity', tool: { name: 7 } }]), 'UNCLASSIFIED');
  assert.equal(coreStopReason([]), 'UNCLASSIFIED');
});

test('a turn the core stopped at its rounds is the task\'s call budget, like one past the transport\'s count', () => {
  const request = { maxModelCalls: 16 };
  assert.equal(failedTurnCode(16, request, 'CORE_ROUND_LIMIT'), 'MODEL_BUDGET_EXCEEDED');
  assert.equal(failedTurnCode(17, request, 'UNCLASSIFIED'), 'MODEL_BUDGET_EXCEEDED');
  for (const stop of ['CORE_TOOL_FAILED', 'CORE_UNFINISHED_RESPONSE', 'CORE_EMPTY_RESPONSE', 'CORE_ERROR', 'UNCLASSIFIED']) {
    assert.equal(failedTurnCode(16, request, stop), 'CORE_EXECUTION_FAILED', stop);
  }
});

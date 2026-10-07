import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, publicHealth } from './config.mjs';

const base = {
  AWWO_PI_TOKEN: 'x'.repeat(40), AWWO_PI_PROVIDER: 'llmgate', AWWO_PI_MODEL: 'qwen3.8-27b-p6', AWWO_PI_API_KEY: 'gate-key', AWWO_CREDENTIAL_MODE: 'operator',
  AWWO_LLMGATE_ONLY: 'true', AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock', AWWO_BEDROCK_CATALOG: 'builtin',
  AWWO_BEDROCK_MODELS: 'bedrock.deepseek-r1,bedrock.claude-haiku-4-5,bedrock.claude-sonnet-4-6',
};
const planner = { AWWO_PI_BEDROCK_THINKING_BUDGET: '2048', AWWO_PI_BEDROCK_THINKING_MODELS: 'bedrock.claude-haiku-4-5' };
const bedrock = (config) => Object.fromEntries(config.models.filter(m => m.provider === 'bedrock').map(m => [m.id, m.thinkingBudget ?? null]));
const none = { 'bedrock.deepseek-r1': null, 'bedrock.claude-haiku-4-5': null, 'bedrock.claude-sonnet-4-6': null };

test('the operator thinking budget reaches only the Claude models it names, and never the health', () => {
  const config = loadConfig({ ...base, ...planner });
  // Sonnet is Claude too, but users pick it for their own nodes: unnamed, it does not think.
  assert.deepEqual(bedrock(config), { ...none, 'bedrock.claude-haiku-4-5': 2048 });
  assert.deepEqual(bedrock(loadConfig({ ...base, ...planner, AWWO_PI_BEDROCK_THINKING_MODELS: ' bedrock.claude-haiku-4-5 , bedrock.claude-sonnet-4-6 ' })),
    { ...none, 'bedrock.claude-haiku-4-5': 2048, 'bedrock.claude-sonnet-4-6': 2048 });
  // No budget means no thinking, whatever is named.
  assert.deepEqual(bedrock(loadConfig(base)), none);
  assert.deepEqual(bedrock(loadConfig({ ...base, ...planner, AWWO_PI_BEDROCK_THINKING_BUDGET: '0' })), none);
  assert.deepEqual(bedrock(loadConfig({ ...base, ...planner, AWWO_PI_BEDROCK_THINKING_BUDGET: '' })), none);
  assert.equal(JSON.stringify(publicHealth(config)).includes('thinking'), false);
});

test('an invalid thinking setting stops the worker from starting', () => {
  for (const value of ['500', '16001', 'abc', '2048.5', '-1']) {
    assert.throws(() => loadConfig({ ...base, ...planner, AWWO_PI_BEDROCK_THINKING_BUDGET: value }), /AWWO_PI_BEDROCK_THINKING_BUDGET must be/);
  }
  // A budget must name its models, and each must be a Claude model this worker serves through Bedrock.
  assert.throws(() => loadConfig({ ...base, AWWO_PI_BEDROCK_THINKING_BUDGET: '2048' }), /needs AWWO_PI_BEDROCK_THINKING_MODELS/);
  for (const models of ['bedrock.deepseek-r1', 'bedrock.claude-opus-5-5', 'bedrock.claude-haiku-4-5,bedrock.unknown']) {
    assert.throws(() => loadConfig({ ...base, ...planner, AWWO_PI_BEDROCK_THINKING_MODELS: models }), /AWWO_PI_BEDROCK_THINKING_MODELS names/, models);
  }
});

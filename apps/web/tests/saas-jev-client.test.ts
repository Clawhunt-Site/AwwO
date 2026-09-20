import { afterEach, expect, it, vi } from 'vitest';
import { evaluateJev, readJevStatus, type JevRequest, type JevStatus } from '../src/saas/jev';

const status: JevStatus = { provider: 'typesafe', model: 'jev-latest', configured: true, enabled: true, canEvaluate: true,
  questionTypes: ['choice'], limits: { maxQuestions: 16, maxRequestBytes: 65536 } };
const request: JevRequest = { state: { goal: 'Choose a path' }, questions: {
  first: { type: 'choice', instructions: 'Choose the role', criteria: { one: 'One', two: 'Two' } },
  second: { type: 'choice', instructions: 'Choose the mode', criteria: { one: 'One', two: 'Two' } },
} };
const response = () => ({ model: 'jev-1.13.0', answers: {
  first: { type: 'choice', choice: 'one', confidence: 0.9, probabilities: { one: 0.95, two: 0.05 } },
  second: { type: 'choice', choice: 'two', confidence: 0.8, probabilities: { one: 0.1, two: 0.9 } },
}, usage: { input_tokens: 200, output_tokens: 10 } });
afterEach(() => vi.unstubAllGlobals());
const evaluate = () => evaluateJev('tenant', request, status, new AbortController().signal, 'en');

it('accepts official batched Choice responses, forward metadata, aliases and nullable/missing token counters', async () => {
  const raw = { ...response(), usage: { input_tokens: null }, provider_metadata: { request: 'safe' } };
  const fetch = vi.fn(async () => Response.json(raw)); vi.stubGlobal('fetch', fetch);
  const result = await evaluate();
  expect(result).toMatchObject({ model: 'jev-1.13.0', usage: { input_tokens: null, output_tokens: null }, answers: { second: { choice: 'two' } } });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]).toMatchObject(['/api/v1/tenants/tenant/typesafe/evaluations', { method: 'POST', credentials: 'include' }]);
});

it.each([
  ['unknown-choice', (raw: any) => { raw.answers.first.choice = 'invented'; }],
  ['missing-question', (raw: any) => { delete raw.answers.second; }],
  ['extra-question', (raw: any) => { raw.answers.extra = raw.answers.first; }],
  ['invalid-confidence', (raw: any) => { raw.answers.first.confidence = 2; }],
  ['missing-probability', (raw: any) => { delete raw.answers.first.probabilities.two; }],
  ['invalid-probability', (raw: any) => { raw.answers.first.probabilities.two = -0.1; }],
  ['invalid-total', (raw: any) => { raw.answers.first.probabilities = { one: 0.1, two: 0.1 }; }],
  ['negative-usage', (raw: any) => { raw.usage.input_tokens = -1; }],
  ['wrong-type', (raw: any) => { raw.answers.first.type = 'noul'; }],
])('rejects %s without retrying or accepting partial answers', async (_name, mutate) => {
  const raw = response(); mutate(raw);
  const fetch = vi.fn(async () => Response.json(raw)); vi.stubGlobal('fetch', fetch);
  await expect(evaluate()).rejects.toThrow('invalid judgment');
  expect(fetch).toHaveBeenCalledOnce();
});

it('allows finite rounded probabilities within the existing service tolerance', async () => {
  const raw = response(); raw.answers.first.probabilities = { one: 0.52, two: 0.49 };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(raw)));
  expect((await evaluate()).answers.first.choice).toBe('one');
});

it('does not expose raw upstream diagnostics and gives deployed-endpoint errors a useful message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'unexpected', message: 'SENSITIVE-UPSTREAM-DIAGNOSTIC' } }, { status: 502 })));
  await expect(evaluate()).rejects.toThrow('unavailable');
  await expect(evaluate()).rejects.not.toThrow('SENSITIVE');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  await expect(readJevStatus('tenant', undefined, 'en')).rejects.toThrow('not deployed');
});

it('rejects invalid status limits and one-option Choice before inference', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...status, limits: { maxQuestions: -1, maxRequestBytes: 65536 } })));
  await expect(readJevStatus('tenant', undefined, 'en')).rejects.toThrow('Invalid Jev status');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(evaluateJev('tenant', { state: '', questions: { first: { ...request.questions.first, criteria: { only: 'Only' } } } }, status, new AbortController().signal, 'en')).rejects.toThrow('limit');
  expect(fetch).not.toHaveBeenCalled();
});

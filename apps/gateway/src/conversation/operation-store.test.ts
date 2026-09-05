import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConversationOperationConflictError,
  ConversationOperationCorruptError,
  ConversationOperationStore,
  conversationRequestDigest,
} from './operation-store.js';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

async function stores() {
  const root = await mkdtemp(join(tmpdir(), 'awwo-conversation-ops-'));
  return { root, a: new ConversationOperationStore(root), b: new ConversationOperationStore(root) };
}

function request(message = 'build it') {
  const value = { companyId: 'company-1', agentId: 'agent-1', issueId: null, message, title: 'AwwO run' };
  return {
    operationId: OPERATION_ID,
    companyId: value.companyId,
    agentId: value.agentId,
    issueId: value.issueId,
    requestDigest: conversationRequestDigest(value),
  };
}

describe('ConversationOperationStore', () => {
  it('persists the claim and transitions across store instances', async () => {
    const { a, b } = await stores();
    expect((await a.claim(request())).created).toBe(true);
    await a.recordLabel(OPERATION_ID, 'label-1');
    expect(await a.beginMutation(OPERATION_ID)).toBe(true);
    await a.recordIssue(OPERATION_ID, 'issue-1', 'comment-1');
    await a.recordRun(OPERATION_ID, 'run-1');

    expect(await b.read(OPERATION_ID)).toMatchObject({
      phase: 'run_known', labelId: 'label-1', mutationStarted: true,
      issueId: 'issue-1', commentId: 'comment-1', runId: 'run-1',
    });
  });

  it('grants one durable mutation right under concurrent same-operation requests', async () => {
    const { a, b, root } = await stores();
    const claims = await Promise.all([a.claim(request()), b.claim(request())]);
    expect(claims.filter(result => result.created)).toHaveLength(1);
    const starts = await Promise.all([a.beginMutation(OPERATION_ID), b.beginMutation(OPERATION_ID)]);
    expect(starts.sort()).toEqual([false, true]);
    expect((await new ConversationOperationStore(root).read(OPERATION_ID)).phase).toBe('mutation_started');
  });

  it('rejects reusing one operation id for different input without changing the first record', async () => {
    const { a, b, root } = await stores();
    await a.claim(request('first'));
    await expect(b.claim(request('second'))).rejects.toBeInstanceOf(ConversationOperationConflictError);
    expect(JSON.parse(await readFile(join(root, OPERATION_ID, 'request.json'), 'utf8')).requestDigest)
      .toBe(request('first').requestDigest);
  });

  it('fails closed on a torn or tampered transition', async () => {
    const { a, root } = await stores();
    await a.claim(request());
    await writeFile(join(root, OPERATION_ID, 'issue.json'), '{', 'utf8');
    await expect(a.read(OPERATION_ID)).rejects.toBeInstanceOf(ConversationOperationCorruptError);
  });

  it('never lets an uncertain marker override a later read-proven issue identity', async () => {
    const { a } = await stores();
    await a.claim(request());
    await a.beginMutation(OPERATION_ID);
    await a.recordUncertain(OPERATION_ID, 'create response lost');
    expect((await a.read(OPERATION_ID)).phase).toBe('uncertain');
    await a.recordIssue(OPERATION_ID, 'issue-recovered');
    expect(await a.read(OPERATION_ID)).toMatchObject({ phase: 'issue_known', issueId: 'issue-recovered' });
  });
});

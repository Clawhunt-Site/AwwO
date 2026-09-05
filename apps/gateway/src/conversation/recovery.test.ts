import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentConversationDispatcher } from './dispatcher.js';
import { ConversationOperationStore, conversationRequestDigest } from './operation-store.js';

const BASE = 'http://127.0.0.1:3100';
const identity = { companyId: 'company-1', agentId: 'agent-1', issueId: 'issue-1', runId: 'run-1' };

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('conversation run recovery boundaries', () => {
  it('resolves a missing heartbeat adapter from the bound Agent instead of exposing raw Codex JSONL', async () => {
    const codexStdout = [
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'PRIVATE TOOL OUTPUT' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"deliverable":"ready"}', phase: 'final_answer' } },
      { type: 'turn.completed' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    const outerLog = `${JSON.stringify({ stream: 'stdout', chunk: codexStdout })}\n`;
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/issues/issue-1') return response({ id: 'issue-1', companyId: 'company-1', assigneeAgentId: 'agent-1' });
      if (url.pathname === '/api/heartbeat-runs/run-1') {
        return response({ id: 'run-1', companyId: 'company-1', agentId: 'agent-1', status: 'succeeded', contextSnapshot: { issueId: 'issue-1' } });
      }
      if (url.pathname === '/api/agents/agent-1') return response({ id: 'agent-1', companyId: 'company-1', adapterType: 'codex_local' });
      if (url.pathname === '/api/heartbeat-runs/run-1/log') return response({ runId: 'run-1', content: outerLog });
      return response({ error: 'unexpected request' }, 404);
    }) as typeof fetch;

    const result = await new AgentConversationDispatcher(BASE, { fetchImpl }).readConversationRun(identity);

    expect(result).toMatchObject({ output: '{"deliverable":"ready"}' });
    expect(result.outputAvailable).not.toBe(false);
    expect(result.output).not.toContain('command_execution');
    expect(result.output).not.toContain('PRIVATE TOOL OUTPUT');
  });

  it('returns a known terminal status with outputAvailable=false when persisted output is undecodable', async () => {
    const outerLog = `${JSON.stringify({ stream: 'stdout', chunk: '{malformed codex jsonl\n' })}\n`;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.pathname === '/api/issues/issue-1') {
        return response({ id: 'issue-1', companyId: 'company-1', assigneeAgentId: 'agent-1' });
      }
      if (method === 'GET' && url.pathname === '/api/heartbeat-runs/run-1') {
        return response({
          id: 'run-1', companyId: 'company-1', agentId: 'agent-1', status: 'succeeded',
          adapterType: 'codex_local', contextSnapshot: { issueId: 'issue-1' },
        });
      }
      if (method === 'GET' && url.pathname === '/api/heartbeat-runs/run-1/log') {
        return response({ runId: 'run-1', content: outerLog });
      }
      return response({ error: 'unexpected request' }, 404);
    }) as typeof fetch;

    const result = await new AgentConversationDispatcher(BASE, { fetchImpl }).readConversationRun(identity);

    expect(result).toMatchObject({
      runId: 'run-1', status: 'succeeded', terminal: true, outputAvailable: false,
    });
  });

  it('rejects an identity mismatch without reading logs or making any mutation', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, path: url.pathname });
      if (url.pathname === '/api/issues/issue-1') {
        return response({ id: 'issue-1', companyId: 'different-company', assigneeAgentId: 'agent-1' });
      }
      return response({ error: 'unexpected request' }, 404);
    }) as typeof fetch;

    await expect(new AgentConversationDispatcher(BASE, { fetchImpl }).readConversationRun(identity))
      .rejects.toThrow('Conversation identity mismatch');
    expect(calls).toEqual([{ method: 'GET', path: '/api/issues/issue-1' }]);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('recovers a continuation from its exact comment context and never selects an older active run', async () => {
    const operationId = '33333333-3333-4333-8333-333333333333';
    const operationStore = new ConversationOperationStore(await mkdtemp(join(tmpdir(), 'awwo-operation-recovery-')));
    const request = { companyId: 'company-1', agentId: 'agent-1', issueId: 'issue-1', message: 'continue' };
    await operationStore.claim({
      operationId, companyId: request.companyId, agentId: request.agentId, issueId: request.issueId,
      requestDigest: conversationRequestDigest(request),
    });
    await operationStore.beginMutation(operationId);
    await operationStore.recordIssue(operationId, 'issue-1', 'comment-new');
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/issues/issue-1') {
        return response({ id: 'issue-1', companyId: 'company-1', assigneeAgentId: 'agent-1' });
      }
      if (url.pathname === '/api/companies/company-1/heartbeat-runs') {
        return response([
          { id: 'run-old', companyId: 'company-1', agentId: 'agent-1', createdAt: '2026-01-01T00:00:00Z', contextSnapshot: { issueId: 'issue-1', commentId: 'comment-old' } },
          { id: 'run-new', companyId: 'company-1', agentId: 'agent-1', createdAt: '2026-01-02T00:00:00Z', contextSnapshot: { issueId: 'issue-1', commentId: 'comment-new' } },
        ]);
      }
      if (url.pathname === '/api/issues/issue-1/live-runs') {
        return response([{ id: 'run-old', agentId: 'agent-1', status: 'running', contextCommentId: 'comment-old' }]);
      }
      if (url.pathname === '/api/heartbeat-runs/run-new') {
        return response({
          id: 'run-new', companyId: 'company-1', agentId: 'agent-1', status: 'running',
          contextSnapshot: { issueId: 'issue-1', commentId: 'comment-new' },
        });
      }
      return response({ error: 'unexpected request' }, 404);
    }) as typeof fetch;

    const result = await new AgentConversationDispatcher(BASE, { fetchImpl, operationStore })
      .readConversationOperation({ companyId: 'company-1', agentId: 'agent-1', operationId });

    expect(result).toMatchObject({ state: 'in_flight', runId: 'run-new', terminal: false, outputAvailable: false });
    expect((await operationStore.read(operationId)).runId).toBe('run-new');
  });
});

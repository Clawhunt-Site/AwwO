import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeSource, readKnowledge, readKnowledgeContext, readKnowledgeRevisions, restoreKnowledgeRevision } from '../src/saas/knowledgeApi';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const signal = () => new AbortController().signal;
const doc = { id: 'source-a', kind: 'source', title: '真实资料', content: 'evidence', version: 1, currentRevisionId: 'revision-a', contentHash: 'hash-a', sourceUri: '', provenance: {}, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('knowledge API evidence boundaries', () => {
  it('times out stalled requests after 15 seconds and never retries a mutation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const result = createKnowledgeSource('tenant-a', { title: 'source', content: 'evidence', operationId: 'operation-timeout' }, signal());
    const assertion = expect(result).rejects.toMatchObject({ status: 408, code: 'knowledge_request_timeout' });
    await vi.advanceTimersByTimeAsync(15000); await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed snapshots and duplicate document identities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ documents: [doc, doc], links: [], proposals: [] })));
    await expect(readKnowledge('tenant-a', signal())).rejects.toMatchObject({ code: 'invalid_knowledge_response' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ documents: [{ ...doc, currentRevisionId: '' }], links: [], proposals: [] })));
    await expect(readKnowledge('tenant-a', signal())).rejects.toMatchObject({ code: 'invalid_knowledge_response' });
  });
  it('never exports partial or substituted evidence as the selected context', async () => {
    const item = { ...doc, documentId: 'source-a', revisionId: 'revision-a' };
    vi.stubGlobal('fetch', vi.fn(async () => json({ text: 'partial', items: [item], truncated: true })));
    await expect(readKnowledgeContext('tenant-a', ['source-a'], signal())).rejects.toMatchObject({ code: 'invalid_knowledge_response' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ text: 'wrong source', items: [item], truncated: false })));
    await expect(readKnowledgeContext('tenant-a', ['source-b'], signal())).rejects.toMatchObject({ code: 'invalid_knowledge_context' });
  });
  it('encodes tenant and document paths and does not accept another document history', async () => {
    const fetcher = vi.fn(async () => json({ items: [{ id: 'old', documentId: 'different', version: 1, title: 't', content: 'x', contentHash: 'h', createdAt: '', provenance: {}, sourceUri: '', parentRevisionId: null, links: [] }] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(readKnowledgeRevisions('tenant/a', 'document/b', signal())).rejects.toMatchObject({ code: 'invalid_knowledge_response' });
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/tenants/tenant%2Fa/knowledge/documents/document%2Fb/revisions');
  });
  it('preserves API failures, rejects source kind substitution and restore version mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'forbidden', message: 'Denied' } }, 403)));
    await expect(createKnowledgeSource('tenant-a', { title: 'title', content: 'x', operationId: 'operation-a' }, signal())).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...doc, kind: 'page' })));
    await expect(createKnowledgeSource('tenant-a', { title: 'title', content: 'x', operationId: 'operation-b' }, signal())).rejects.toMatchObject({ code: 'invalid_knowledge_response' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...doc, kind: 'page', version: 7 })));
    await expect(restoreKnowledgeRevision('tenant-a', 'source-a', 'old', 2, 'operation-c', signal())).rejects.toMatchObject({ code: 'invalid_knowledge_response' });
  });
});

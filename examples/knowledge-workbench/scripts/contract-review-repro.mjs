import { createDemoService } from '../src/demo.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

// Runs only isolated process-memory UI fixtures; original deliverables are read only.
const base = '/workspaces/ws-product';
const write = (service, path, method, body) => service.request(path, {
  method, body: { ...body, idempotency_key: randomUUID() },
});
const input = (title, tag_ids = []) => ({
  title, content: 'Contract review fixture', content_format: 'text',
  category_id: 'cat-ws-product-1', owner_id: 'user-me',
  tag_ids, collection_id: null, language: 'de', source: { kind: 'manual' },
});

const searchService = createDemoService();
searchService.login('Owner');
const searchDoc = await write(searchService, `${base}/documents`, 'POST', input('Straße'));
await write(searchService, `${base}/documents/${searchDoc.doc_id}/publish`, 'POST', {
  version_id: searchDoc.latest_draft_version_id, expected_revision: searchDoc.revision,
});
const exact = await searchService.request(`${base}/search?query=${encodeURIComponent('Straße')}`);
const folded = await searchService.request(`${base}/search?query=STRASSE`);

const governanceService = createDemoService();
governanceService.login('Owner');
const tagId = 'tag-ws-product-1';
const governanceDoc = await write(governanceService, `${base}/documents`, 'POST', input('Governance invalidation', [tagId]));
const retired = await write(governanceService, `${base}/tags/${tagId}`, 'PATCH', { state: 'retired', expected_revision: 1 });
let publishFailure;
try {
  await write(governanceService, `${base}/documents/${governanceDoc.doc_id}/publish`, 'POST', {
    version_id: governanceDoc.latest_draft_version_id, expected_revision: governanceDoc.revision,
  });
} catch (error) { publishFailure = { status: error.status, code: error.code, details: error.details }; }
const before = await governanceService.request(`${base}/dashboard?view=governance`);
await write(governanceService, `${base}/tags/${tagId}`, 'PATCH', { state: 'active', expected_revision: retired.revision });
const after = await governanceService.request(`${base}/dashboard?view=governance`);
const version = await governanceService.request(`${base}/documents/${governanceDoc.doc_id}/versions/${governanceDoc.latest_draft_version_id}`);
const result = {
  observed_at: new Date().toISOString(), scope: 'isolated createDemoService only; no backend/browser claims',
  R1_casefold: {
    title: 'Straße', exact_query_total: exact.total, folded_query: 'STRASSE',
    expected_folded_query_total: 1, actual_folded_query_total: folded.total,
    published_view_revision: folded.published_view_revision,
  },
  R2_quality_invalidation: {
    publishFailure,
    before_reactivate: before.governance,
    after_reactivate: after.governance,
    current_version_quality_status: version.quality_status,
    expected_after_reactivate: { blocked_draft_count: 0, unchecked_draft_count: 3 },
    actual_after_reactivate: {
      blocked_draft_count: after.governance.blocked_draft_count,
      unchecked_draft_count: after.governance.unchecked_draft_count,
    },
  },
};
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/contract-review-repro.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi, DEMO_IDS as IDS } from '../src/demo-api.mjs';
const A = IDS.workspaceA, B = IDS.workspaceB;
const key = () => crypto.randomUUID();
const rejects = (fn, status, code) => assert.rejects(fn, error => error.status === status && error.code === code);
async function fixture(role = 'Editor') { const api = createDemoApi(); await api.enterDemo(role); return api; }
async function editable(api, did = IDS.published) {
  const doc = await api.getManagedDocument(A, did);
  const version = await api.getVersion(A, did, doc.latest_draft_version_id ?? doc.current_published_version_id);
  const m = version.metadata_snapshot;
  return { doc, version, body: { title: m.title, content: version.content, content_format: version.content_format,
    category_id: m.category_id, tag_ids: m.tag_ids, owner_id: m.owner_id, collection_id: m.collection_id,
    language: m.language, source_ref: m.source_ref, expected_revision: doc.revision, idempotency_key: key() } };
}
test('demo is explicit, unauthenticated at start, memory-only and refuses real login', async () => {
  const api = createDemoApi();
  assert.equal(api.mode, 'demo'); assert.match(api.label, /演示/);
  await rejects(() => api.getSession(), 401, 'AUTH_REQUIRED');
  await rejects(() => api.startLogin('/'), 503, 'AUTH_DEPENDENCY_UNAVAILABLE');
  await api.enterDemo('Viewer'); assert.equal((await api.getSession()).demo, true);
  await api.logout(); await rejects(() => api.search(A), 401, 'AUTH_REQUIRED');
});
test('all roles read only the published snapshot; draft edits never leak or invalidate published cursors', async () => {
  const api = await fixture(), before = await api.getDocument(A, IDS.published);
  const page = await api.search(A, { limit: 1 });
  const { doc, version, body } = await editable(api);
  const saved = await api.saveVersion(A, IDS.published, { ...body, title: 'NEVER_PUBLISHED_TITLE', content: 'NEVER_PUBLISHED_BODY' });
  assert.equal(saved.document.current_published_version_id, before.version_id);
  assert.deepEqual(await api.getVersion(A, IDS.published, version.version_id), version);
  assert.equal(saved.document.revision, doc.revision + 1);
  const second = await api.search(A, { limit: 1, cursor: page.next_cursor });
  assert.equal(second.hits.length, 1); assert.equal(second.published_view_revision, page.published_view_revision);
  for (const role of ['Owner', 'Admin', 'Editor', 'Viewer']) {
    await api.enterDemo(role);
    const ordinary = await api.getDocument(A, IDS.published);
    assert.equal(ordinary.title, before.title); assert.equal(ordinary.content, before.content);
    assert.equal('revision' in ordinary, false); assert.equal('latest_draft_version_id' in ordinary, false);
    const search = await api.search(A), dashboard = await api.dashboard(A);
    assert.equal((await api.search(A, { query: 'NEVER_PUBLISHED' })).total, 0);
    assert.doesNotMatch(JSON.stringify({ ordinary, search, dashboard }), /NEVER_PUBLISHED|SECRET_DRAFT/);
    assert.equal('governance' in dashboard, false);
  }
});
test('Viewer direct access denies draft and versions, published writes and governance', async () => {
  const api = await fixture('Viewer');
  for (const did of [IDS.draft, IDS.archived, IDS.deleted]) await rejects(() => api.getDocument(A, did), 404, 'NOT_FOUND');
  await rejects(() => api.getManagedDocument(A, IDS.published), 404, 'NOT_FOUND');
  await rejects(() => api.listVersions(A, IDS.published), 404, 'NOT_FOUND');
  await rejects(() => api.saveVersion(A, IDS.published, {}), 403, 'FORBIDDEN');
  await rejects(() => api.createDocument(A, {}), 403, 'FORBIDDEN');
  await rejects(() => api.dashboard(A, { view: 'governance' }), 403, 'FORBIDDEN');
  await rejects(() => api.listMembers(A), 403, 'FORBIDDEN');
  assert.equal((await api.getMe(A)).role, 'Viewer');
  for (const kind of ['tags', 'categories', 'collections']) {
    assert.doesNotMatch(JSON.stringify(await api.listDictionary(A, kind)), /草稿|SECRET/);
    await rejects(() => api.listDictionary(A, kind, { view: 'manage' }), 403, 'FORBIDDEN');
  }
});
test('same user is Admin in A, Viewer in B; cross-workspace resources and references are refused', async () => {
  const api = await fixture('Admin');
  assert.equal((await api.getWorkspace(A)).role, 'Admin'); assert.equal((await api.getWorkspace(B)).role, 'Viewer');
  await rejects(() => api.createDocument(B, {}), 403, 'FORBIDDEN');
  await rejects(() => api.getDocument(B, IDS.published), 404, 'NOT_FOUND');
  await rejects(() => api.getWorkspace(key()), 404, 'NOT_FOUND');
  const { doc, body } = await editable(api), otherTag = (await api.listDictionary(B, 'tags')).items[0];
  await rejects(() => api.saveVersion(A, IDS.published, { ...body, tag_ids: [otherTag.id] }), 422, 'INVALID_REFERENCE');
  assert.equal((await api.getManagedDocument(A, IDS.published)).revision, doc.revision);
  assert.equal((await api.search(A, { tags: [otherTag.id] })).total, 0);
});
test('pagination total and facets are from the same filtered published set as dashboard', async () => {
  const api = await fixture('Viewer'), page = await api.search(A, { limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.hits.length, 1); assert.equal(page.facets.categories[0].count, 2);
  const next = await api.search(A, { limit: 1, cursor: page.next_cursor });
  assert.equal(new Set([...page.hits, ...next.hits].map(hit => hit.doc_id)).size, page.total);
  assert.equal(next.next_cursor, null); assert.equal((await api.dashboard(A)).published_count, page.total);
  assert.equal((await api.search(A, { query: '不存在' })).total, 0);
  await rejects(() => api.search(B, { limit: 1, cursor: page.next_cursor }), 409, 'CURSOR_STALE');
  await rejects(() => api.search(A, { query: '知识', limit: 1, cursor: page.next_cursor }), 409, 'CURSOR_STALE');
  await rejects(() => api.search(A, { cursor: 'tampered' }), 422, 'VALIDATION_FAILED');
  await api.enterDemo('Owner');
  await rejects(() => api.search(A, { limit: 1, cursor: page.next_cursor }), 409, 'CURSOR_STALE');
});
test('immutable versions, idempotent save and revision conflicts cannot overwrite published bytes', async () => {
  const api = await fixture(), { doc, version, body } = await editable(api);
  const first = await api.saveVersion(A, IDS.published, body), second = await api.saveVersion(A, IDS.published, body);
  assert.equal(second.version_id, first.version_id); assert.equal(second.document.revision, first.document.revision);
  assert.equal((await api.listVersions(A, IDS.published)).items.length, 2);
  await rejects(() => api.saveVersion(A, IDS.published, { ...body, title: 'different' }), 409, 'IDEMPOTENCY_CONFLICT');
  await rejects(() => api.saveVersion(A, IDS.published, { ...body, idempotency_key: key() }), 409, 'REVISION_CONFLICT');
  assert.equal((await api.getManagedDocument(A, IDS.published)).revision, doc.revision + 1);
  assert.equal((await api.getDocument(A, IDS.published)).content, version.content);
  assert.match(version.checksum, /^[a-f0-9]{64}$/u);
  const mutable = await api.getManagedDocument(A, IDS.published); mutable.latest_metadata.title = 'MUTATED';
  assert.notEqual((await api.getManagedDocument(A, IDS.published)).latest_metadata.title, 'MUTATED');
});
test('quality failure does not advance pointers and records blocked drafts without fake passed counts', async () => {
  const api = await fixture();
  const draft = await api.createDocument(A, { title: '', content: '', content_format: 'markdown', category_id: null,
    owner_id: null, tag_ids: [], collection_id: null, language: 'und', source: { kind: 'manual' }, idempotency_key: key() });
  await rejects(() => api.publishDocument(A, draft.doc_id, { version_id: draft.latest_draft_version_id,
    expected_revision: draft.revision, idempotency_key: key() }), 422, 'QUALITY_FAILED');
  const after = await api.getManagedDocument(A, draft.doc_id);
  assert.equal(after.revision, draft.revision); assert.equal(after.current_published_version_id, null);
  const { governance: g } = await api.dashboard(A, { view: 'governance' });
  assert.equal(g.blocked_draft_count, 1);
  assert.equal(g.draft_count, g.blocked_draft_count + g.unchecked_draft_count + g.error_draft_count + g.passed_draft_count);
  assert.equal(g.published_findings.checked_documents, 0); assert.ok(g.rules_not_run.includes('STALE_CONTENT'));
});
test('publish invalidates old cursor; archive removes every public projection and prevents replay content leaks', async () => {
  const api = await fixture(), page = await api.search(A, { limit: 1 });
  const { body } = await editable(api);
  const saved = await api.saveVersion(A, IDS.published, { ...body, title: 'Released title' });
  const publishBody = { version_id: saved.version_id, expected_revision: saved.document.revision, idempotency_key: key() };
  const release = await api.publishDocument(A, IDS.published, publishBody);
  assert.equal(release.published.title, 'Released title'); assert.equal(release.document.latest_draft_version_id, null);
  assert.equal(release.demo_validation_only, true); assert.equal(release.quality_run_id, null);
  await rejects(() => api.search(A, { limit: 1, cursor: page.next_cursor }), 409, 'CURSOR_STALE');
  const archive = await api.archiveDocument(A, IDS.published, { expected_revision: release.document.revision, idempotency_key: key() });
  await rejects(() => api.getDocument(A, IDS.published), 404, 'NOT_FOUND');
  await rejects(() => api.getVersion(A, IDS.published, saved.version_id), 404, 'NOT_FOUND');
  await rejects(() => api.publishDocument(A, IDS.published, publishBody), 404, 'NOT_FOUND');
  assert.equal('latest_metadata' in await api.getManagedDocument(A, IDS.published), false);
  assert.equal((await api.search(A)).total, 1); assert.equal((await api.dashboard(A)).published_count, 1);
  await api.deleteDocument(A, IDS.published, { expected_revision: archive.revision, idempotency_key: key() });
  assert.equal((await api.getManagedDocument(A, IDS.published)).state, 'deleted');
});
test('member boundaries, revocation and downgraded sessions are rechecked on every read and replay', async () => {
  const api = await fixture('Admin'), members = (await api.listMembers(A)).items;
  for (const member of members.filter(member => ['Owner', 'Admin'].includes(member.role))) {
    await rejects(() => api.updateMember(A, member.membership_id, { role: 'Viewer', expected_revision: 1, idempotency_key: key() }), 403, 'FORBIDDEN');
  }
  const editor = members.find(member => member.role === 'Editor');
  await rejects(() => api.updateMember(A, editor.membership_id, { role: 'Admin', expected_revision: 1, idempotency_key: key() }), 403, 'FORBIDDEN');
  await api.enterDemo('Editor'); const { body } = await editable(api); await api.saveVersion(A, IDS.published, body);
  await api.enterDemo('Admin');
  await api.updateMember(A, editor.membership_id, { role: 'Viewer', expected_revision: 1, idempotency_key: key() });
  await api.enterDemo('Editor'); assert.equal((await api.getWorkspace(A)).role, 'Viewer');
  await rejects(() => api.saveVersion(A, IDS.published, body), 403, 'FORBIDDEN');
  await rejects(() => api.getManagedDocument(A, IDS.published), 404, 'NOT_FOUND');
  await api.enterDemo('Admin');
  await api.updateMember(A, editor.membership_id, { status: 'disabled', expected_revision: 2, idempotency_key: key() });
  await api.enterDemo('Editor'); await rejects(() => api.search(A), 404, 'NOT_FOUND');
  assert.equal((await api.getWorkspace(B)).role, 'Viewer');
});
test('Editor manages tags but not collections/categories; dictionary edits never rewrite published metadata', async () => {
  const api = await fixture(), before = await api.getDocument(A, IDS.published);
  for (const kind of ['collections', 'categories']) await rejects(() => api.createDictionary(A, kind, { name: 'New', idempotency_key: key() }), 403, 'FORBIDDEN');
  const tag = (await api.listDictionary(A, 'tags', { view: 'manage' })).items.find(item => item.id === before.tags[0].id);
  await api.updateDictionary(A, 'tags', tag.id, { name: '新名字', expected_revision: tag.revision, idempotency_key: key() });
  assert.deepEqual((await api.getDocument(A, IDS.published)).tags, before.tags);
  await rejects(() => api.deleteDictionary(A, 'tags', tag.id, { expected_revision: tag.revision + 1, idempotency_key: key() }), 409, 'RESOURCE_IN_USE');
  const created = await api.createDictionary(A, 'tags', { name: ' Temporary ', idempotency_key: key() });
  assert.equal(created.name, 'Temporary');
  await rejects(() => api.createDictionary(A, 'tags', { name: 'ＴＥＭＰＯＲＡＲＹ', idempotency_key: key() }), 409, 'RESOURCE_IN_USE');
  assert.equal((await api.deleteDictionary(A, 'tags', created.id, { expected_revision: 1, idempotency_key: key() })).deleted, true);
});
test('draft inputs reject forged role/state, absent references and sensitive source URLs without writes', async () => {
  const api = await fixture(), { doc, body } = await editable(api);
  await rejects(() => api.saveVersion(A, IDS.published, { ...body, state: 'published', role: 'Owner' }), 422, 'VALIDATION_FAILED');
  const { source_ref, ...input } = body;
  for (const source_uri of ['https://user:pass@example.test/a', 'https://example.test/a?token=x', 'javascript:alert(1)', 'https://example.test/a#secret']) {
    await rejects(() => api.saveVersion(A, IDS.published, { ...input, source: { kind: 'manual', source_uri } }), 422, 'VALIDATION_FAILED');
  }
  assert.equal((await api.getManagedDocument(A, IDS.published)).revision, doc.revision);
});

test('governance invalidates failed quality results when referenced dictionary dependencies change', async () => {
  const api = await fixture(), { doc, version } = await editable(api, IDS.draft);
  const tag = (await api.listDictionary(A, 'tags', { view: 'manage' })).items.find(item => item.id === version.metadata_snapshot.tag_ids[0]);
  const retired = await api.updateDictionary(A, 'tags', tag.id, { state: 'retired', expected_revision: tag.revision, idempotency_key: key() });
  await rejects(() => api.publishDocument(A, IDS.draft, { version_id: version.version_id, expected_revision: doc.revision, idempotency_key: key() }), 422, 'QUALITY_FAILED');
  assert.equal((await api.dashboard(A, { view: 'governance' })).governance.blocked_draft_count, 1);
  await api.updateDictionary(A, 'tags', tag.id, { state: 'active', expected_revision: retired.revision, idempotency_key: key() });
  const { governance: g } = await api.dashboard(A, { view: 'governance' });
  assert.equal(g.blocked_draft_count, 0); assert.equal(g.unchecked_draft_count, g.draft_count);
});

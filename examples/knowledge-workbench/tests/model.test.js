import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError } from '../src/api.js';
import { createDemoService } from '../src/demo.js';

const base = '/workspaces/ws-product';
const docId = 'doc-ws-product-1';
const requestFails = (operation, status, code) => assert.rejects(operation, error => {
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return true;
});
const serviceAs = role => { const service = createDemoService(); service.login(role); return service; };
const inputFrom = (version, extra = {}) => {
  const m = version.metadata_snapshot;
  return { content_format: version.content_format, content: version.content, title: m.title,
    category_id: m.category_id, tag_ids: m.tag_ids, owner_id: m.owner_id, collection_id: m.collection_id,
    language: m.language, source_ref: m.source_ref, idempotency_key: 'test-key', ...extra };
};

test('Viewer published/search/dashboard never include draft content or dictionary names', async () => {
  const service = serviceAs('Viewer');
  const search = await service.request(`${base}/search?limit=6`);
  assert.equal(search.total, 8);
  assert.equal(search.hits.length, 6);
  assert.ok(search.next_cursor);
  const next = await service.request(`${base}/search?limit=6&cursor=${search.next_cursor}`);
  assert.equal(next.hits.length, 2);
  assert.equal(new Set([...search.hits, ...next.hits].map(d => d.doc_id)).size, 8);
  const doc = await service.request(`${base}/documents/${docId}`);
  assert.equal(doc.title, '新成员入职指南');
  assert.equal(Object.hasOwn(doc, 'revision'), false);
  const dashboard = await service.request(`${base}/dashboard`);
  assert.equal(dashboard.published_count, search.total);
  assert.equal(Object.hasOwn(dashboard, 'governance'), false);
  for (const kind of ['categories', 'tags', 'collections']) {
    const list = await service.request(`${base}/${kind}`);
    assert.doesNotMatch(JSON.stringify(list), /secret|草稿|保密/u);
  }
  assert.doesNotMatch(JSON.stringify({ search, next, doc, dashboard }), /DRAFT_SECRET|并购|secret|latest_draft/u);
  const filtered = await service.request(`${base}/search?query=DRAFT_SECRET_2026`);
  assert.equal(filtered.total, 0);
  assert.deepEqual(filtered.facets, { categories: [], tags: [] });
  assert.equal((await service.request(`${base}/search?tags=tag-secret`)).total, 0);
});

test('Viewer cannot read drafts/versions, create documents, mutate published content or read members', async () => {
  const service = serviceAs('Viewer');
  for (const path of [`${base}/documents/doc-secret`, `${base}/documents/doc-secret/manage`,
    `${base}/documents/${docId}/manage`, `${base}/documents/${docId}/versions`,
    `${base}/documents/${docId}/versions/version-secret-update`]) {
    await requestFails(() => service.request(path), 404, 'NOT_FOUND');
  }
  await requestFails(() => service.request(`${base}/documents/manage`), 403, 'FORBIDDEN');
  await requestFails(() => service.request(`${base}/members`), 403, 'FORBIDDEN');
  await requestFails(() => service.request(`${base}/dashboard?view=governance`), 403, 'FORBIDDEN');
  await requestFails(() => service.request(`${base}/documents`, { method: 'POST', body: {} }), 403, 'FORBIDDEN');
  await requestFails(() => service.request(`${base}/documents/${docId}/versions`, { method: 'POST', body: {} }), 403, 'FORBIDDEN');
  assert.equal((await service.request(`${base}/members/me`)).role, 'Viewer');
});

test('saving a new draft preserves published bytes/metadata, published revision and valid cursor', async () => {
  const service = serviceAs('Editor');
  const before = await service.request(`${base}/documents/${docId}`);
  const listing = await service.request(`${base}/search?limit=6`);
  const managed = await service.request(`${base}/documents/${docId}/manage`);
  const version = await service.request(`${base}/documents/${docId}/versions/${managed.latest_draft_version_id}`);
  const result = await service.request(`${base}/documents/${docId}/versions`, { method: 'POST',
    body: inputFrom(version, { title: 'UPDATED_DRAFT_ONLY', content: 'PRIVATE_BODY', expected_revision: managed.revision }) });
  assert.equal(result.document.revision, managed.revision + 1);
  assert.equal(result.document.current_published_version_id, before.version_id);
  assert.deepEqual(await service.request(`${base}/documents/${docId}`), before);
  assert.equal((await service.request(`${base}/search?query=UPDATED_DRAFT_ONLY`)).total, 0);
  const pageTwo = await service.request(`${base}/search?limit=6&cursor=${listing.next_cursor}`);
  assert.equal(pageTwo.published_view_revision, listing.published_view_revision);
  assert.equal(pageTwo.hits.length, 2);
  assert.deepEqual(await service.request(`${base}/documents/${docId}/versions/${version.version_id}`), version);
});

test('optimistic revision conflict cannot create a version or overwrite a newer draft', async () => {
  const service = serviceAs('Editor');
  const managed = await service.request(`${base}/documents/${docId}/manage`);
  const version = await service.request(`${base}/documents/${docId}/versions/${managed.latest_draft_version_id}`);
  const body = inputFrom(version, { title: 'First save', expected_revision: managed.revision });
  const saved = await service.request(`${base}/documents/${docId}/versions`, { method: 'POST', body });
  await requestFails(() => service.request(`${base}/documents/${docId}/versions`, {
    method: 'POST', body: { ...body, title: 'Stale overwrite' },
  }), 409, 'REVISION_CONFLICT');
  const after = await service.request(`${base}/documents/${docId}/manage`);
  assert.equal(after.revision, saved.document.revision);
  assert.equal(after.latest_metadata.title, 'First save');
  assert.equal((await service.request(`${base}/documents/${docId}/versions`)).items.length, 3);
});

test('workspace and related resource boundaries remain independent from the current role', async () => {
  const service = serviceAs('Owner');
  assert.equal((await service.request('/workspaces/ws-support')).role, 'Viewer');
  await requestFails(() => service.request('/workspaces/ws-support/members'), 403, 'FORBIDDEN');
  await requestFails(() => service.request(`/workspaces/ws-support/documents/${docId}`), 404, 'NOT_FOUND');
  await requestFails(() => service.request('/workspaces/ws-unavailable'), 404, 'NOT_FOUND');
  const managed = await service.request(`${base}/documents/${docId}/manage`);
  const version = await service.request(`${base}/documents/${docId}/versions/${managed.latest_draft_version_id}`);
  await requestFails(() => service.request(`${base}/documents/${docId}/versions`, { method: 'POST',
    body: inputFrom(version, { category_id: 'cat-ws-support-1', expected_revision: managed.revision }) }), 422, 'INVALID_REFERENCE');
  assert.equal((await service.request(`${base}/documents/${docId}/manage`)).revision, managed.revision);
});

test('publish updates authorized search, archive immediately removes content and invalidates cursors', async () => {
  const service = serviceAs('Owner');
  const search = await service.request(`${base}/search?limit=6`);
  const managed = await service.request(`${base}/documents/${docId}/manage`);
  const published = await service.request(`${base}/documents/${docId}/publish`, { method: 'POST',
    body: { version_id: managed.latest_draft_version_id, expected_revision: managed.revision, idempotency_key: 'publish-1' } });
  assert.equal(published.document.latest_draft_version_id, null);
  assert.equal((await service.request(`${base}/search?query=DRAFT_SECRET_2026`)).total, 1);
  await requestFails(() => service.request(`${base}/search?limit=6&cursor=${search.next_cursor}`), 409, 'CURSOR_STALE');
  await service.request(`${base}/documents/${docId}/archive`, { method: 'POST', body: { expected_revision: published.document.revision } });
  await requestFails(() => service.request(`${base}/documents/${docId}`), 404, 'NOT_FOUND');
  await requestFails(() => service.request(`${base}/documents/${docId}/versions`), 404, 'NOT_FOUND');
  const archived = await service.request(`${base}/documents/${docId}/manage`);
  assert.equal(Object.hasOwn(archived, 'latest_metadata'), false);
  assert.equal((await service.request(`${base}/search`)).total, 7);
});

test('quality failures retain draft revision and publishing pointer', async () => {
  const service = serviceAs('Editor');
  const created = await service.request(`${base}/documents`, { method: 'POST', body: {
    title: '', content: '', content_format: 'markdown', category_id: null, tag_ids: [], owner_id: null,
    collection_id: null, language: 'zh-CN', source: { kind: 'manual' }, idempotency_key: 'empty-draft',
  } });
  await requestFails(() => service.request(`${base}/documents/${created.doc_id}/publish`, { method: 'POST',
    body: { expected_revision: created.revision, version_id: created.latest_draft_version_id } }), 422, 'QUALITY_FAILED');
  const after = await service.request(`${base}/documents/${created.doc_id}/manage`);
  assert.equal(after.revision, created.revision);
  assert.equal(after.current_published_version_id, null);
  const dashboard = await service.request(`${base}/dashboard?view=governance`);
  assert.equal(dashboard.governance.blocked_draft_count, 1);
  assert.equal(dashboard.governance.draft_count, Object.entries(dashboard.governance)
    .filter(([key]) => ['blocked_draft_count', 'unchecked_draft_count', 'error_draft_count', 'passed_draft_count'].includes(key))
    .reduce((total, [, count]) => total + count, 0));
});

test('Editor manages tags only; dictionary rename cannot rewrite frozen published metadata', async () => {
  const service = serviceAs('Editor');
  await requestFails(() => service.request(`${base}/collections`, { method: 'POST', body: { name: '集合' } }), 403, 'FORBIDDEN');
  await requestFails(() => service.request(`${base}/categories`, { method: 'POST', body: { name: '分类' } }), 403, 'FORBIDDEN');
  await requestFails(() => service.request(`${base}/members`), 403, 'FORBIDDEN');
  const before = await service.request(`${base}/documents/${docId}`);
  const tag = (await service.request(`${base}/tags?view=manage`)).items.find(t => t.id === before.tags[0].id);
  await service.request(`${base}/tags/${tag.id}`, { method: 'PATCH', body: { name: 'New tag name', expected_revision: tag.revision } });
  assert.deepEqual((await service.request(`${base}/documents/${docId}`)).tags, before.tags);
  await requestFails(() => service.request(`${base}/tags/${tag.id}`, { method: 'DELETE', body: { expected_revision: tag.revision + 1 } }), 409, 'RESOURCE_IN_USE');
});

test('Admin cannot edit Owner, Admin or self, but can manage Editor and invite Viewer', async () => {
  const service = serviceAs('Admin');
  for (const suffix of ['me', 'founder', 'admin']) {
    await requestFails(() => service.request(`${base}/members/member-ws-product-${suffix}`, {
      method: 'PATCH', body: { role: 'Viewer', expected_revision: 1 },
    }), 403, 'FORBIDDEN');
  }
  await requestFails(() => service.request(`${base}/members/member-ws-product-editor`, {
    method: 'PATCH', body: { role: 'Admin', expected_revision: 1 },
  }), 403, 'FORBIDDEN');
  const member = await service.request(`${base}/members/member-ws-product-editor`, {
    method: 'PATCH', body: { role: 'Viewer', expected_revision: 1 },
  });
  assert.equal(member.role, 'Viewer');
  await requestFails(() => service.request(`${base}/invitations`, { method: 'POST', body: { email: 'a@example.test', role: 'Admin' } }), 403, 'FORBIDDEN');
  const invitation = await service.request(`${base}/invitations`, { method: 'POST', body: { email: 'a@example.test', role: 'Viewer' } });
  assert.equal(invitation.delivery_status, 'pending');
  assert.equal(Object.hasOwn(invitation, 'token'), false);
  await requestFails(() => service.request(base, { method: 'PATCH', body: { name: 'Changed', expected_revision: 1 } }), 403, 'FORBIDDEN');
});

test('retired tags and collections remain manageable and can be reactivated', async () => {
  const service = serviceAs('Owner');
  for (const kind of ['tags', 'collections']) {
    const created = await service.request(`${base}/${kind}`, { method: 'POST', body: { name: `临时${kind}` } });
    await service.request(`${base}/${kind}/${created.id}`, {
      method: 'PATCH', body: { state: 'retired', expected_revision: created.revision },
    });
    const retired = (await service.request(`${base}/${kind}?view=manage`)).items.find(item => item.id === created.id);
    assert.ok(retired, 'retired entry must remain discoverable for the reactivation UI');
    assert.equal(retired.state, 'retired');
    assert.equal(retired.revision, created.revision + 1);
    const active = await service.request(`${base}/${kind}/${created.id}`, {
      method: 'PATCH', body: { state: 'active', expected_revision: retired.revision },
    });
    assert.equal(active.state, 'active');
    assert.equal(active.revision, retired.revision + 1);
    assert.equal((await service.request(`${base}/${kind}`)).items.some(item => item.id === created.id), false,
      'unused management dictionaries cannot appear in published candidates');
  }
});

test('adapter transports same-origin credentials and CSRF, handles envelope errors, never retries writes', async t => {
  const calls = [];
  let unauthorized = 0;
  const api = new ApiClient({ onUnauthorized: () => unauthorized++ });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/session')) return new Response(JSON.stringify({ data: { user: { user_id: 'one' }, csrf_token: 'csrf-test' }, error: null, request_id: 'request-1' }));
    return new Response(JSON.stringify({ data: null, error: { code: 'SESSION_INVALID', message: 'Expired', details: {} }, request_id: 'request-2' }), { status: 401 });
  });
  await api.request('/session');
  await requestFails(() => api.request(`${base}/documents`, { method: 'POST', body: { title: 'one' } }), 401, 'SESSION_INVALID');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/v1/session');
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'csrf-test');
  assert.equal(api.csrfToken, null);
  assert.equal(unauthorized, 1);
});

test('adapter/demo expire memory session and return 503 without fabricating a successful empty result', async () => {
  let unauthorized = 0;
  const api = new ApiClient({ demo: true, onUnauthorized: () => unauthorized++ });
  api.demo.login('Owner');
  await api.request('/session');
  api.demo.failNext('SEARCH_UNAVAILABLE');
  await requestFails(() => api.request(`${base}/search`), 503, 'SEARCH_UNAVAILABLE');
  assert.equal((await api.request(`${base}/search`)).total, 8);
  api.demo.failNext('SESSION_INVALID');
  await requestFails(() => api.request('/session'), 401, 'SESSION_INVALID');
  assert.equal(api.csrfToken, null);
  assert.equal(unauthorized, 1);
  await requestFails(() => api.request(base), 401, 'AUTH_REQUIRED');
  assert.ok(new ApiError(409, 'REVISION_CONFLICT', 'changed') instanceof Error);
});

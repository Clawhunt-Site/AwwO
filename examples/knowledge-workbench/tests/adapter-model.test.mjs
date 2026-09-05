import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createHttpApi, errorState } from '../src/api.mjs';
import { can, capabilitiesFor, uiAccess } from '../src/permissions.mjs';
import { createWorkspaceState } from '../src/workspace-state.mjs';

const context = (role = 'Editor') => ({
  user: { user_id: 'user-a', status: 'active' },
  workspace: { workspace_id: 'workspace-a', status: 'active' },
  membership: { user_id: 'user-a', workspace_id: 'workspace-a', role, status: 'active' },
  sessionValid: true,
});
const member = (role = 'Viewer', overrides = {}) => ({
  user_id: 'user-b', workspace_id: 'workspace-a', status: 'active', role, ...overrides,
});
const success = data => ({ data, error: null, request_id: 'request-test' });
const failure = (code, retryable = false) => ({
  data: null, error: { code, message: 'Safe message', details: {}, retryable }, request_id: 'request-error',
});
const response = (status, envelope, retryAfter = null) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null },
  async json() { return structuredClone(envelope); },
});
const sessionResponse = () => response(200, success({ user: { user_id: 'user-a' }, csrf_token: 'csrf-test', capabilities: [] }));
function transport(responses, options = {}) {
  const requests = [];
  const api = createHttpApi({
    ...options,
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, 'unexpected extra HTTP request');
      return next;
    },
  });
  return { api, requests };
}
const result = (title = 'Visible document', next_cursor = null) => ({
  total: 1, hits: [{ doc_id: 'doc-a', title }], next_cursor,
});
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('four roles expose only their permitted workspace UI', () => {
  const expected = {
    Owner: [true, true, true, true, true, true, true, true, true],
    Admin: [true, true, true, true, true, false, true, true, true],
    Editor: [true, true, true, true, false, false, false, true, false],
    Viewer: [true, false, false, false, false, false, false, false, false],
  };
  const keys = ['search', 'manageDocuments', 'createDocument', 'governance', 'members', 'settings', 'collections', 'tags', 'audit'];
  for (const [role, flags] of Object.entries(expected)) {
    const actual = uiAccess(context(role));
    assert.deepEqual(keys.map(key => actual[key]), flags, role);
    assert.equal(can(context(role), 'document.read.published'), true, role);
    assert.equal(can(context(role), 'document.edit', { owner_id: 'another-user' }), role !== 'Viewer', role);
  }
});

test('unknown actions, roles, inactive or mismatched contexts fail closed', () => {
  assert.equal(can(context('Unknown'), 'search.query'), false);
  for (const action of ['category.create', 'quality.run', 'dashboard.config.update', 'audit.create', 'resource.acl.update']) {
    assert.equal(can(context('Owner'), action), false, action);
  }
  const cases = [null, undefined, {}, { ...context(), sessionValid: false }];
  for (const key of ['user', 'workspace', 'membership']) {
    cases.push({ ...context(), [key]: { ...context()[key], status: 'disabled' } });
  }
  cases.push({ ...context(), membership: { ...context().membership, workspace_id: 'workspace-b' } });
  cases.push({ ...context(), membership: { ...context().membership, user_id: 'user-b' } });
  for (const input of cases) assert.equal(can(input, 'search.query'), false);
  assert.equal(can(context('Owner'), 'document.edit', { workspace_id: 'workspace-b' }), false);
  assert.equal(can({ ...context('Owner'), capabilities: [] }, 'document.edit'), false);
  assert.equal(can({ ...context('Owner'), capabilities: 'document.edit' }, 'document.edit'), false);
  assert.equal(can({ ...context('Viewer'), capabilities: ['document.edit'] }, 'document.edit'), false);
});

test('missing identity IDs never count as a valid shared authorization context', () => {
  const incomplete = {
    user: { status: 'active' }, workspace: { status: 'active' },
    membership: { status: 'active', role: 'Owner' }, sessionValid: true,
  };
  assert.equal(can(incomplete, 'search.query'), false);
});

test('capability discovery returns no permissions for absent context', () => {
  assert.deepEqual(capabilitiesFor(null), []);
  assert.deepEqual(capabilitiesFor(undefined), []);
});

test('member read and leave permissions are limited to self below Admin', () => {
  for (const role of ['Editor', 'Viewer']) {
    assert.equal(can(context(role), 'membership.read', member(role, { user_id: 'user-a' })), true);
    assert.equal(can(context(role), 'membership.read', member()), false);
    assert.equal(can(context(role), 'membership.leave', member(role, { user_id: 'user-a' })), true);
    assert.equal(can(context(role), 'membership.leave', member()), false);
  }
  assert.equal(can(context('Admin'), 'membership.read', member()), true);
  assert.equal(can(context('Owner'), 'membership.leave', member('Owner', { user_id: 'user-a' })), false);
});

test('Admin cannot manage self, peers, Owner or promote a member to Admin', () => {
  for (const action of ['membership.role.update', 'membership.disable', 'membership.enable', 'membership.remove']) {
    assert.equal(can(context('Admin'), action, member('Viewer')), true, action);
    assert.equal(can(context('Admin'), action, member('Viewer', { next_role: 'Editor' })), true, action);
    for (const target of [member('Admin'), member('Owner'), member('Viewer', { user_id: 'user-a' }), member('Viewer', { next_role: 'Admin' })]) {
      assert.equal(can(context('Admin'), action, target), false, action);
    }
    assert.equal(can(context('Owner'), action, member('Admin')), true, action);
    assert.equal(can(context('Owner'), action, member('Owner')), false, action);
    assert.equal(can(context('Editor'), action, member()), false, action);
  }
  assert.equal(can(context('Owner'), 'membership.enable', member('Viewer', { status: 'removed' })), false);
  assert.equal(can(context('Admin'), 'membership.invite'), true, 'default invite role is Viewer');
  assert.equal(can(context('Admin'), 'membership.invite', { next_role: 'Admin' }), false);
  assert.equal(can(context('Owner'), 'membership.invite', { next_role: 'Admin' }), true);
  assert.equal(can(context('Owner'), 'membership.invite', { next_role: 'Owner' }), false);
});

test('ownership transfer requires an identified active target, reauthentication and acceptance', () => {
  const accepted = member('Editor', { reauthenticated: true, accepted: true });
  assert.equal(can(context('Owner'), 'workspace.owner.transfer', accepted), true);
  for (const target of [
    { ...accepted, accepted: false }, { ...accepted, reauthenticated: false },
    { ...accepted, status: 'disabled' }, { ...accepted, user_id: 'user-a' },
    { ...accepted, workspace_id: 'workspace-b' }, { ...accepted, user_id: undefined },
  ]) assert.equal(can(context('Owner'), 'workspace.owner.transfer', target), false);
  assert.equal(can(context('Admin'), 'workspace.owner.transfer', accepted), false);
});

test('HTTP reads use credential cookies, no-store, safe redirects and encoded filters', async () => {
  const { api, requests } = transport([response(200, success(result()))]);
  const data = await api.search('workspace-a', { query: '入门 & FAQ', tags: ['tag-a', 'tag-b'], cursor: null });
  assert.equal(api.mode, 'http');
  assert.equal(data.hits[0].title, 'Visible document');
  const request = requests[0];
  const url = new URL(request.url, 'https://example.test');
  assert.equal(url.pathname, '/api/v1/workspaces/workspace-a/search');
  assert.equal(url.searchParams.get('query'), '入门 & FAQ');
  assert.equal(url.searchParams.get('tags'), 'tag-a,tag-b');
  assert.equal(url.searchParams.has('cursor'), false);
  assert.equal(request.method, 'GET');
  assert.equal(request.credentials, 'include');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.headers['X-CSRF-Token'], undefined);
});

test('writes require session restoration and preserve CSRF, revision and idempotency inputs', async () => {
  const { api, requests } = transport([sessionResponse(), response(201, success({ version_id: 'version-b' }))]);
  const payload = { content: 'new draft', expected_revision: 4, idempotency_key: 'key-stable' };
  await assert.rejects(api.saveVersion('workspace-a', 'doc-a', payload), { status: 401, code: 'AUTH_REQUIRED' });
  assert.equal(requests.length, 0);
  await api.getSession();
  await api.saveVersion('workspace-a', 'doc-a', payload);
  const write = requests[1];
  assert.equal(write.url, '/api/v1/workspaces/workspace-a/documents/doc-a/versions');
  assert.equal(write.method, 'POST');
  assert.equal(write.headers['X-CSRF-Token'], 'csrf-test');
  assert.equal(write.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(write.body), payload);
});

test('retryable server failures are exposed without retrying a write', async () => {
  const { api, requests } = transport([sessionResponse(), response(503, failure('AUDIT_UNAVAILABLE', true), '5')]);
  await api.getSession();
  await assert.rejects(api.publishDocument('workspace-a', 'doc-a', { expected_revision: 2, idempotency_key: 'key-stable' }), error => {
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfter, '5');
    assert.equal(error.requestId, 'request-error');
    return true;
  });
  assert.equal(requests.length, 2, 'one session read and exactly one write');
});

test('401 clears CSRF and notifies the view even when the response is malformed', async () => {
  let unauthorized = 0;
  const invalid401 = { ...response(401, null), async json() { throw new SyntaxError('not JSON'); } };
  const { api, requests } = transport([sessionResponse(), invalid401], { onUnauthorized: () => { unauthorized++; } });
  await api.getSession();
  await assert.rejects(api.getWorkspace('workspace-a'), { status: 401, code: 'INVALID_RESPONSE' });
  assert.equal(unauthorized, 1);
  await assert.rejects(api.updateWorkspace('workspace-a', { name: 'Changed' }), { status: 401, code: 'AUTH_REQUIRED' });
  assert.equal(requests.length, 2, 'subsequent mutation cannot reuse the cleared CSRF token');
});

test('HTTP rejects invalid envelopes and incomplete session DTOs', async () => {
  for (const envelope of [null, {}, { data: {}, error: null }, { data: {}, error: null, request_id: 7 }, 'invalid', 42]) {
    const { api } = transport([response(200, envelope)]);
    await assert.rejects(api.listWorkspaces(), error => error instanceof ApiError && error.status === 502 && error.code === 'INVALID_RESPONSE');
  }
  const { api, requests } = transport([sessionResponse(), response(200, success({ user: { user_id: 'user-a' } }))]);
  await api.getSession();
  await assert.rejects(api.getSession(), { status: 502, code: 'INVALID_RESPONSE' });
  await assert.rejects(api.updateWorkspace('workspace-a', { name: 'Changed' }), { status: 401 });
  assert.equal(requests.length, 2);
});

test('HTTP errors preserve safe diagnostics but never make 4xx retryable', async () => {
  const { api } = transport([response(409, failure('REVISION_CONFLICT', true), '1')]);
  await assert.rejects(api.getWorkspace('workspace-a'), error => {
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, 'request-error');
    assert.deepEqual(errorState(error), {
      kind: 'conflict', message: '文档已被修改。请保留当前输入，刷新版本后再保存。',
      code: 'REVISION_CONFLICT', requestId: 'request-error',
    });
    return true;
  });
});

test('HTTP network and abort errors do not fall back to demo success', async () => {
  const { api, requests } = transport([new TypeError('offline')]);
  await assert.rejects(api.search('workspace-a'), { status: 0, code: 'NETWORK_ERROR' });
  assert.equal(requests.length, 1);
  const aborted = new Error('cancelled'); aborted.name = 'AbortError';
  const interrupted = transport([aborted]);
  await assert.rejects(interrupted.api.search('workspace-a'), error => error === aborted);
});

test('API base URLs cannot escape the current origin through URL normalization', () => {
  for (const baseUrl of ['https://other.test/api', '//other.test/api', 'api/v1', '/\\other.test', '/api?next=x', '/api#x', '/\n/other.test', '/\t/other.test']) {
    assert.throws(() => createHttpApi({ baseUrl }), TypeError, JSON.stringify(baseUrl));
  }
  assert.equal(createHttpApi({ baseUrl: '/api/v1/' }).mode, 'http');
});

test('resource IDs cannot inject path separators or traverse resource routes', () => {
  const { api, requests } = transport([]);
  for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000b']) {
    assert.throws(() => api.getWorkspace(id), TypeError);
    assert.throws(() => api.getDocument('workspace-a', id), TypeError);
  }
  assert.equal(requests.length, 0);
});

test('login rejects external and encoded return paths before sending a request', async () => {
  const { api, requests } = transport([response(200, success({ challenge_id: 'challenge-a', next_step: 'provider' }))]);
  for (const path of ['https://other.test', '//other.test', '/\\other.test', '/%2Fother.test', '/%252Fother.test', '/%5Cother.test', '/%0A/other.test', '/bad%', '/with space', null]) {
    assert.throws(() => api.startLogin(path), TypeError, String(path));
  }
  assert.equal(requests.length, 0);
  await api.startLogin('/workspaces/workspace-a?view=search');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/api/v1/auth/login/start');
  assert.equal(requests[0].headers['X-CSRF-Token'], undefined);
  assert.deepEqual(JSON.parse(requests[0].body), { return_path: '/workspaces/workspace-a?view=search' });
});

test('unavailable category writes are refused before HTTP dispatch', () => {
  const { api, requests } = transport([]);
  for (const run of [() => api.createDictionary('workspace-a', 'categories', {}), () => api.updateDictionary('workspace-a', 'categories', 'id-a', {}), () => api.deleteDictionary('workspace-a', 'categories', 'id-a', {})]) {
    assert.throws(run, { status: 403, code: 'FORBIDDEN' });
  }
  assert.equal(requests.length, 0);
});

test('error states distinguish login, reauth, denial, missing, conflict and unavailable', () => {
  const cases = [[401, 'SESSION_INVALID', 'login'], [403, 'REAUTH_REQUIRED', 'reauth'], [403, 'FORBIDDEN', 'forbidden'],
    [404, 'NOT_FOUND', 'not-found'], [409, 'CURSOR_STALE', 'restart-search'], [409, 'REVISION_CONFLICT', 'conflict'],
    [422, 'QUALITY_FAILED', 'validation'], [429, 'RATE_LIMITED', 'unavailable'], [503, 'SEARCH_UNAVAILABLE', 'unavailable']];
  for (const [status, code, kind] of cases) assert.equal(errorState(new ApiError(status, code, 'Raw diagnostic')).kind, kind);
  assert.equal(errorState({ name: 'AbortError' }).kind, 'cancelled');
});

test('workspace changes keep filters while clearing data, selected documents and cursor', async () => {
  const calls = [];
  const store = createWorkspaceState({ search: async (...args) => { calls.push(args); return result('Workspace A', 'cursor-a'); } });
  const filters = { query: '入门', category: 'category-a', tags: ['tag-a'], collection: 'collection-a' };
  store.switchWorkspace('workspace-a');
  store.setFilters(filters);
  filters.tags.push('mutated-outside');
  await store.search();
  store.selectDocument('doc-a');
  store.switchWorkspace('workspace-b');
  assert.deepEqual(store.snapshot(), {
    workspaceId: 'workspace-b', filters: { query: '入门', category: 'category-a', tags: ['tag-a'], collection: 'collection-a' },
    cursor: null, selectedDocument: null, data: null, status: 'idle', error: null,
  });
  await store.search();
  assert.equal(calls[1][0], 'workspace-b');
  assert.equal(calls[1][1].cursor, null);
  assert.deepEqual(calls[1][1].tags, ['tag-a']);
  store.dispose();
});

test('late responses from a prior workspace cannot overwrite the current workspace', async () => {
  const first = deferred(); const second = deferred(); const calls = [];
  const store = createWorkspaceState({ search: (...args) => { calls.push(args); return calls.length === 1 ? first.promise : second.promise; } });
  store.switchWorkspace('workspace-a');
  const pendingA = store.search();
  store.switchWorkspace('workspace-b');
  const pendingB = store.search();
  assert.equal(calls[0][2].signal.aborted, true);
  second.resolve(result('Workspace B'));
  await pendingB;
  first.resolve(result('Secret workspace A'));
  await pendingA;
  assert.equal(store.snapshot().workspaceId, 'workspace-b');
  assert.equal(store.snapshot().data.hits[0].title, 'Workspace B');
  assert.equal(JSON.stringify(store.snapshot()).includes('Secret workspace A'), false);
  store.dispose();
});

test('a current 401 resets all sensitive workspace state and adapter session', async () => {
  let clearCount = 0;
  const store = createWorkspaceState({
    clearSession() { clearCount++; },
    async search() { throw new ApiError(401, 'SESSION_INVALID', 'expired'); },
  });
  store.switchWorkspace('workspace-a');
  store.setFilters({ query: 'private query', tags: ['private-tag'] });
  store.selectDocument('private-doc');
  await store.search();
  assert.equal(clearCount, 1);
  assert.deepEqual(store.snapshot(), {
    workspaceId: null, filters: { query: '', tags: [] }, cursor: null,
    selectedDocument: null, data: null, status: 'login', error: null,
  });
  store.dispose();
});

test('a stale failure cannot replace a newer workspace search result', async () => {
  const first = deferred(); let clearCount = 0; let count = 0;
  const store = createWorkspaceState({
    clearSession() { clearCount++; },
    search() { count++; return count === 1 ? first.promise : Promise.resolve(result('Workspace B')); },
  });
  store.switchWorkspace('workspace-a');
  const oldSearch = store.search();
  store.switchWorkspace('workspace-b');
  await store.search();
  first.reject(new ApiError(503, 'SEARCH_UNAVAILABLE', 'old request'));
  await oldSearch;
  assert.equal(clearCount, 0);
  assert.equal(store.snapshot().status, 'ready');
  assert.equal(store.snapshot().workspaceId, 'workspace-b');
  store.dispose();
});

test('CURSOR_STALE clears pagination and the next search starts from page one', async () => {
  const calls = [];
  const store = createWorkspaceState({ search: async (...args) => {
    calls.push(args);
    if (calls.length === 2) throw new ApiError(409, 'CURSOR_STALE', 'stale');
    return calls.length === 1 ? result('First page', 'cursor-old') : { total: 0, hits: [], next_cursor: null };
  } });
  store.switchWorkspace('workspace-a');
  store.setFilters({ query: 'kept query' });
  await store.search();
  await store.search({ nextPage: true });
  assert.equal(calls[1][1].cursor, 'cursor-old');
  assert.equal(store.snapshot().cursor, null);
  assert.equal(store.snapshot().data, null);
  assert.equal(store.snapshot().status, 'restart-search');
  assert.equal(store.snapshot().filters.query, 'kept query');
  await store.search({ nextPage: true });
  assert.equal(calls[2][1].cursor, null);
  assert.equal(store.snapshot().status, 'empty');
  store.dispose();
});

test('non-auth search errors retain workspace and filters without displaying success data', async () => {
  for (const [status, code, kind] of [[403, 'FORBIDDEN', 'forbidden'], [404, 'NOT_FOUND', 'not-found'], [503, 'SEARCH_UNAVAILABLE', 'unavailable']]) {
    const store = createWorkspaceState({ search: async () => { throw new ApiError(status, code, 'failure'); } });
    store.switchWorkspace('workspace-a');
    store.setFilters({ query: 'keep' });
    await store.search();
    assert.equal(store.snapshot().workspaceId, 'workspace-a');
    assert.equal(store.snapshot().filters.query, 'keep');
    assert.equal(store.snapshot().data, null);
    assert.equal(store.snapshot().status, kind);
    store.dispose();
  }
});

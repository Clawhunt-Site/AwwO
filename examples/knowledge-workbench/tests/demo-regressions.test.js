import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoService } from '../src/demo.js';

const base = '/workspaces/ws-product';
const tag = 'tag-ws-product-1';
const collection = 'col-ws-product-1';
const input = (extra = {}) => ({
  title: 'Regression fixture', content: 'Contract review fixture', content_format: 'text',
  category_id: 'cat-ws-product-1', owner_id: 'user-editor', tag_ids: [tag],
  collection_id: collection, language: 'de', source: { kind: 'manual' }, ...extra,
});
const write = (service, path, method, body) => service.request(`${base}${path}`, { method, body });
const fixture = async (extra = {}) => {
  const service = createDemoService(); service.login('Owner');
  const doc = await write(service, '/documents', 'POST', input(extra));
  return { service, doc };
};
const publish = (service, doc) => write(service, `/documents/${doc.doc_id}/publish`, 'POST', {
  version_id: doc.latest_draft_version_id, expected_revision: doc.revision,
});
const failPublish = (service, doc, rule) => assert.rejects(() => publish(service, doc), error => {
  assert.equal(error.status, 422); assert.equal(error.code, 'QUALITY_FAILED');
  assert.ok(error.details.findings.some(finding => finding.rule_id === rule && !finding.passed));
  return true;
});
const counts = async (service, blocked, unchecked) => {
  const dashboard = await service.request(`${base}/dashboard?view=governance`);
  const g = dashboard.governance;
  assert.equal(g.blocked_draft_count, blocked);
  assert.equal(g.unchecked_draft_count, unchecked);
  assert.equal(g.draft_count, blocked + unchecked + g.error_draft_count + g.passed_draft_count);
  return dashboard;
};
const version = (service, doc) => service.request(`${base}/documents/${doc.doc_id}/versions/${doc.latest_draft_version_id}`);

test('main demo search folds title, body and query using locale-independent Unicode semantics', async () => {
  const pairs = [['Straße', 'STRASSE'], ['ΟΣ', 'ος'], ['Ꭰ', 'ꭰ'], ['ᾈ', 'ἀι'], ['ﬃ', 'FFI'], ['𐐀', '𐐨'],
    ['𝐀', 'a'], ['J̌', 'ǰ'], ['İ', 'i\u0307'], ['ＡＢＣ', 'abc']];
  for (const [saved, query] of pairs) {
    for (const field of ['title', 'content']) {
      const { service, doc } = await fixture({ title: 'Fixture', content: 'Fixture', [field]: saved });
      await publish(service, doc);
      const exact = await service.request(`${base}/search?query=${encodeURIComponent(saved)}`);
      const folded = await service.request(`${base}/search?query=${encodeURIComponent(query)}`);
      assert.equal(exact.total, 1, `${field}: ${saved}`);
      assert.equal(folded.total, 1, `${field}: ${saved} / ${query}`);
      assert.equal(folded.hits[0].doc_id, doc.doc_id);
      assert.equal(folded.published_view_revision, exact.published_view_revision);
      assert.deepEqual(folded.facets, exact.facets);
    }
  }
});

test('tag and collection restoration invalidate failed checks without changing historical runs', async () => {
  for (const [kind, id] of [['tags', tag], ['collections', collection]]) {
    const { service, doc } = await fixture();
    const retired = await write(service, `/${kind}/${id}`, 'PATCH', { state: 'retired', expected_revision: 1 });
    await failPublish(service, doc, 'REF_INTEGRITY');
    const before = await counts(service, 1, 2);
    assert.equal((await version(service, doc)).quality_status, 'failed');
    const historyPath = `${base}/documents/${doc.doc_id}/quality-runs`;
    const history = await service.request(historyPath);
    await write(service, `/${kind}/${id}`, 'PATCH', { state: 'active', expected_revision: retired.revision });
    const after = await counts(service, 0, 3);
    assert.equal(after.published_view_revision, before.published_view_revision);
    assert.equal((await version(service, doc)).quality_status, 'unchecked');
    const versions = await service.request(`${base}/documents/${doc.doc_id}/versions`);
    assert.equal(versions.items[0].quality_status, 'unchecked');
    assert.deepEqual(await service.request(historyPath), history, 'historical results stay immutable');
    assert.equal((await service.request(`${base}/documents/${doc.doc_id}/manage`)).revision, doc.revision);
    await publish(service, doc);
    await counts(service, 0, 2);
  }
});

test('owner membership restoration invalidates the old failure and rechecks before publication', async () => {
  const { service, doc } = await fixture();
  const memberPath = '/members/member-ws-product-editor';
  const disabled = await write(service, memberPath, 'PATCH', { status: 'disabled', expected_revision: 1 });
  await failPublish(service, doc, 'OWNER_INACTIVE');
  await counts(service, 1, 2);
  await write(service, memberPath, 'PATCH', { status: 'active', expected_revision: disabled.membership_revision });
  await counts(service, 0, 3);
  await publish(service, doc);
});

test('related dictionary revisions, owner role/removal and ruleset changes all invalidate completed checks', async () => {
  const changes = [
    ['/tags/' + tag, 'PATCH', { name: 'Renamed tag', expected_revision: 1 }],
    ['/collections/' + collection, 'PATCH', { name: 'Renamed collection', expected_revision: 1 }],
    ['/members/member-ws-product-editor', 'PATCH', { role: 'Viewer', expected_revision: 1 }],
    ['/members/member-ws-product-editor', 'DELETE', { expected_revision: 1 }],
    ['/governance/config', 'PUT', { stale_after_days: 30, expected_revision: 1 }],
  ];
  for (const [path, method, body] of changes) {
    const { service, doc } = await fixture({ content: '' });
    await failPublish(service, doc, 'CONTENT_REQUIRED');
    await counts(service, 1, 2);
    await write(service, path, method, body);
    await counts(service, 0, 3);
    await failPublish(service, doc, 'CONTENT_REQUIRED');
    await counts(service, 1, 2);
  }
});

test('restoring a dependency to the same state cannot resurrect an earlier completed result', async () => {
  const { service, doc } = await fixture({ content: '' });
  await failPublish(service, doc, 'CONTENT_REQUIRED');
  await write(service, `/tags/${tag}`, 'PATCH', { state: 'retired', expected_revision: 1 });
  await write(service, `/tags/${tag}`, 'PATCH', { state: 'active', expected_revision: 2 });
  await counts(service, 0, 3);
});

test('unrelated dictionary, member and workspace changes retain valid checks', async () => {
  const { service, doc } = await fixture({ content: '' });
  await failPublish(service, doc, 'CONTENT_REQUIRED');
  await write(service, '/tags/tag-ws-product-4', 'PATCH', { state: 'retired', expected_revision: 1 });
  await write(service, '/members/member-ws-product-viewer', 'PATCH', { status: 'disabled', expected_revision: 1 });
  await write(service, '', 'PATCH', { name: 'Renamed workspace', expected_revision: 1 });
  await counts(service, 1, 2);
  assert.equal((await version(service, doc)).quality_status, 'failed');
  const other = await service.request('/workspaces/ws-support/dashboard');
  assert.equal(other.published_count, 3); assert.equal('governance' in other, false);
});

test('new drafts do not reuse earlier version results and Viewer never sees governance', async () => {
  const { service, doc } = await fixture({ content: '' });
  await failPublish(service, doc, 'CONTENT_REQUIRED');
  const next = await write(service, `/documents/${doc.doc_id}/versions`, 'POST', input({ expected_revision: doc.revision }));
  await counts(service, 0, 3);
  assert.equal((await version(service, doc)).quality_status, 'failed', 'old version remains historical');
  assert.equal((await version(service, next.document)).quality_status, 'unchecked');
  service.login('Viewer');
  await assert.rejects(() => service.request(`${base}/dashboard?view=governance`), { status: 403, code: 'FORBIDDEN' });
  assert.equal('governance' in await service.request(`${base}/dashboard`), false);
});

/** Deterministic, process-memory-only UI fixtures. This is not an auth service. */
import { unicodeCaseFold } from './unicode-casefold.js';

export class ApiError extends Error {
  constructor(status, code, message, details = {}, request_id = null, retryable = false) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, { status, code, details, request_id, retryable });
  }
}

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
const normalizeSearch = value => unicodeCaseFold(String(value ?? '').normalize('NFKC'));
const isManager = role => ['Owner', 'Admin', 'Editor'].includes(role);
const isAdmin = role => ['Owner', 'Admin'].includes(role);
const BLOCKER_RULES = ['META_REQUIRED', 'CONTENT_REQUIRED', 'REF_INTEGRITY', 'CONTENT_INTEGRITY', 'OWNER_INACTIVE'];
const BASE_CAPS = ['workspace.read', 'membership.read.self', 'membership.leave',
  'document.read.published', 'search.query', 'dashboard.read.published'];
const EDIT_CAPS = ['document.create', 'document.read.draft', 'document.read.versions',
  'document.read.governance', 'document.edit', 'document.metadata.update', 'document.tag.assign',
  'document.publish', 'document.archive', 'document.soft-delete', 'collection.read', 'tag.read',
  'tag.create', 'tag.update', 'tag.delete-unused', 'dashboard.read.governance'];
const ADMIN_CAPS = ['membership.read', 'membership.invite', 'membership.role.update',
  'membership.disable', 'membership.enable', 'membership.remove', 'collection.create',
  'collection.update', 'collection.delete-empty', 'governance.rules.update', 'audit.read'];
const roleCaps = role => [...BASE_CAPS, ...(isManager(role) ? EDIT_CAPS : []),
  ...(isAdmin(role) ? ADMIN_CAPS : []), ...(role === 'Owner' ? ['workspace.settings.update', 'workspace.owner.transfer'] : [])];

function initialState() {
  const workspaces = [
    { workspace_id: 'ws-product', name: '知序 · 产品与设计', revision: 1, publishedRevision: 1, changeRevision: 1 },
    { workspace_id: 'ws-support', name: '客户成功中心', revision: 1, publishedRevision: 1, changeRevision: 1 },
  ];
  const dictionaries = Object.fromEntries(workspaces.map(w => [w.workspace_id, {
    categories: ['产品指南', '团队流程', '设计规范'].map((name, i) => ({ id: `cat-${w.workspace_id}-${i + 1}`, name, state: 'active', revision: 1 })),
    tags: ['新成员', '精选', '协作', '研究'].map((name, i) => ({ id: `tag-${w.workspace_id}-${i + 1}`, name, state: 'active', revision: 1 })),
    collections: ['团队手册', '产品设计', '研究洞察'].map((name, i) => ({ id: `col-${w.workspace_id}-${i + 1}`, name, state: 'active', revision: 1 })),
  }]));
  const memberNames = [
    ['me', '林知', 'lin.zhi@example.test', 'Owner'],
    ['founder', '陈以安', 'chen@example.test', 'Admin'],
    ['admin', '周远', 'zhou@example.test', 'Admin'],
    ['editor', '许言', 'xu@example.test', 'Editor'],
    ['viewer', '赵宁', 'zhao@example.test', 'Viewer'],
  ];
  const members = Object.fromEntries(workspaces.map(w => [w.workspace_id,
    memberNames.map(([id, display_name, email, role]) => ({ membership_id: `member-${w.workspace_id}-${id}`,
      user_id: `user-${id}`, display_name, masked_email: `${email[0]}***@example.test`,
      role: w.workspace_id === 'ws-support' ? (id === 'me' ? 'Viewer' : id === 'founder' ? 'Owner' : role) : role,
      status: 'active', membership_revision: 1 }))]));
  const docs = [];
  const titles = ['新成员入职指南', '产品设计协作流程', '知识库使用手册', '品牌与视觉设计规范',
    '用户访谈准备清单', '每周团队复盘方法', '产品需求文档模板', '远程协作沟通约定'];
  for (const workspace of workspaces) {
    const wid = workspace.workspace_id;
    const dict = dictionaries[wid];
    const count = wid === 'ws-product' ? titles.length : 3;
    for (let i = 0; i < count; i++) {
      const id = `doc-${wid}-${i + 1}`;
      const publishedAt = `2026-09-${String(4 - Math.floor(i / 3)).padStart(2, '0')}T${String(12 - i).padStart(2, '0')}:00:00.000Z`;
      const title = wid === 'ws-product' ? titles[i] : ['客户服务入门', '常见问题与回复模板', '客户反馈处理流程'][i];
      const metadata = {
        title, category: clone(dict.categories[i % 3]), category_id: dict.categories[i % 3].id,
        tags: [clone(dict.tags[i % 4]), ...(i % 2 === 0 ? [clone(dict.tags[1])] : [])]
          .filter((tag, index, all) => all.findIndex(t => t.id === tag.id) === index).map(({ id, name }) => ({ id, name })),
        owner: { user_id: 'user-me', display_name: '林知' }, owner_id: 'user-me',
        source: { id: `source-${id}`, kind: 'manual', origin_ref: `internal:document/${id}`, source_uri: null },
        source_ref: `source-${id}`, language: 'zh-CN',
        collection: { id: dict.collections[i % 3].id, name: dict.collections[i % 3].name }, collection_id: dict.collections[i % 3].id,
      };
      metadata.category = { id: metadata.category.id, name: metadata.category.name };
      metadata.tag_ids = metadata.tags.map(t => t.id);
      const content = `# ${title}\n\n让知识在团队中持续流动，让每一次协作都有据可循。\n\n## 开始之前\n\n明确负责人、目标和预期结果。将重要信息整理到工作区，便于团队成员检索与复用。\n\n## 建议流程\n\n1. 阅读团队约定并确认上下文。\n2. 在文档中记录结论与相关依据。\n3. 完成检查后发布，让团队看到最新版本。\n\n遇到问题，请联系文档负责人。`;
      const version = { version_id: `version-${id}-1`, document_id: id, version_no: 1, parent_version_id: null,
        metadata_snapshot: metadata, content_format: 'markdown', content, checksum: `demo-checksum-${id}-1`,
        quality_status: 'passed', created_by: 'user-me', created_at: publishedAt };
      docs.push({ doc_id: id, workspace_id: wid, state: 'published', revision: 1,
        latest_draft_version_id: null, current_published_version_id: version.version_id,
        created_at: publishedAt, updated_at: publishedAt, published_at: publishedAt, versions: [version], qualityRuns: [] });
    }
  }
  // The secret appears only in management fixtures, never published DTOs, facets or metrics.
  const first = docs[0];
  const secretCategory = { id: 'cat-secret', name: '内部研究草稿', state: 'active', revision: 1 };
  const secretTag = { id: 'tag-secret', name: '未发布保密标签', state: 'active', revision: 1 };
  dictionaries['ws-product'].categories.push(secretCategory);
  dictionaries['ws-product'].tags.push(secretTag);
  const draft = clone(first.versions[0]);
  Object.assign(draft, { version_id: 'version-secret-update', version_no: 2,
    parent_version_id: first.versions[0].version_id, quality_status: 'unchecked' });
  draft.metadata_snapshot.title = '内部草稿：尚未发布的并购计划';
  draft.metadata_snapshot.category = { id: secretCategory.id, name: secretCategory.name };
  draft.metadata_snapshot.category_id = secretCategory.id;
  draft.metadata_snapshot.tags = [{ id: secretTag.id, name: secretTag.name }];
  draft.metadata_snapshot.tag_ids = [secretTag.id];
  draft.content = '# 内部草稿\n\nDRAFT_SECRET_2026 仅管理视图可见。';
  first.versions.push(draft);
  first.latest_draft_version_id = draft.version_id;
  first.revision = 2;
  const secret = clone(first);
  Object.assign(secret, { doc_id: 'doc-secret', state: 'draft', revision: 1,
    current_published_version_id: null, latest_draft_version_id: 'version-secret-only', published_at: null });
  secret.versions = [clone(draft)];
  Object.assign(secret.versions[0], { version_id: 'version-secret-only', document_id: 'doc-secret', version_no: 1, parent_version_id: null });
  secret.versions[0].metadata_snapshot.title = '未发布：季度研究计划';
  secret.versions[0].metadata_snapshot.source = { id: 'source-doc-secret', kind: 'manual', origin_ref: 'internal:document/doc-secret', source_uri: null };
  secret.versions[0].metadata_snapshot.source_ref = 'source-doc-secret';
  docs.push(secret);
  return { workspaces, dictionaries, members, docs, invitations: { 'ws-product': [], 'ws-support': [] },
    session: null, nextFailure: null, sequence: 100, cursors: new Map(),
    governance: Object.fromEntries(workspaces.map(w => [w.workspace_id, { revision: 1, ruleset_revision: 'demo-rules-1', stale_after_days: null }])) };
}

export function createDemoService() {
  let state = initialState();
  // Private bindings keep historical QualityResult DTOs immutable and unchanged.
  const qualityContexts = new WeakMap();
  const error = (status, code, message, details = {}) => {
    throw new ApiError(status, code, message, details, `demo-request-${++state.sequence}`, status >= 500);
  };
  const denied = () => error(403, 'FORBIDDEN', '当前角色无权执行此操作。');
  const missing = () => error(404, 'NOT_FOUND', '内容不存在或当前不可见。');
  const validation = (field, message = '请检查输入内容。') => error(422, 'VALIDATION_FAILED', message, { fields: [field] });
  const revision = (resource, body, field = 'revision') => {
    if (body?.expected_revision !== resource[field]) error(409, 'REVISION_CONFLICT', '内容已更新，请重新加载后再操作。', { current_revision: resource[field] });
  };
  const activeDocs = wid => state.docs.filter(d => d.workspace_id === wid && ['draft', 'published'].includes(d.state));
  const publishedDocs = wid => activeDocs(wid).filter(d => d.state === 'published' && d.current_published_version_id);
  const latest = doc => doc.versions.find(v => v.version_id === (doc.latest_draft_version_id || doc.current_published_version_id));
  const publishedVersion = doc => doc.versions.find(v => v.version_id === doc.current_published_version_id);
  const qualityContext = (doc, version) => {
    const wid = doc.workspace_id, m = version.metadata_snapshot;
    const reference = (kind, id) => {
      const entry = state.dictionaries[wid][kind].find(item => item.id === id);
      return [id, entry?.revision ?? null, entry?.state ?? null];
    };
    const owner = state.members[wid].find(member => member.user_id === m.owner_id);
    return JSON.stringify({
      document_revision: doc.revision, version_id: version.version_id,
      ruleset_revision: state.governance[wid].ruleset_revision,
      category: reference('categories', m.category_id), collection: reference('collections', m.collection_id),
      tags: m.tag_ids.map(id => reference('tags', id)),
      owner: [m.owner_id, owner?.membership_revision ?? null, owner?.status ?? null, owner?.role ?? null],
    });
  };
  const draftQualityStatus = doc => {
    const version = latest(doc), context = qualityContext(doc, version);
    const run = doc.qualityRuns.find(item => item.version_id === version.version_id && qualityContexts.get(item) === context);
    if (!run) return 'unchecked';
    if (run.status === 'error') return 'error';
    if (run.status !== 'completed') return 'unchecked';
    const blockers = run.findings.filter(finding => finding.severity === 'blocker');
    if (blockers.some(finding => finding.passed === false)) return 'failed';
    return BLOCKER_RULES.every(rule => blockers.some(finding => finding.rule_id === rule && finding.passed === true))
      ? 'passed' : 'unchecked';
  };
  // Only the current draft is projected against live dependencies. Older versions
  // and quality-runs retain their recorded status for historical inspection.
  const versionQualityStatus = (doc, version) => version.version_id === doc.latest_draft_version_id
    ? draftQualityStatus(doc) : version.quality_status;
  const changed = (ws, published = false) => { ws.changeRevision++; if (published) ws.publishedRevision++; };
  const metadataPublic = metadata => clone(metadata);
  const managed = (doc, role) => ['archived', 'deleted'].includes(doc.state)
    ? { doc_id: doc.doc_id, state: doc.state, revision: doc.revision, archived_at: doc.archived_at ?? null, deleted_at: doc.deleted_at ?? null }
    : { doc_id: doc.doc_id, workspace_id: doc.workspace_id, state: doc.state, revision: doc.revision,
      latest_draft_version_id: doc.latest_draft_version_id, current_published_version_id: doc.current_published_version_id,
      latest_metadata: metadataPublic(latest(doc).metadata_snapshot), created_at: doc.created_at,
      updated_at: doc.updated_at, published_at: doc.published_at, capabilities: roleCaps(role).filter(c => c.startsWith('document.')) };
  const published = (doc, role) => {
    const version = publishedVersion(doc), m = version.metadata_snapshot;
    return { doc_id: doc.doc_id, workspace_id: doc.workspace_id, version_id: version.version_id,
      title: m.title, content_format: version.content_format, content: version.content,
      category: clone(m.category), tags: clone(m.tags), owner: clone(m.owner), source: clone(m.source),
      collection: clone(m.collection), language: m.language, published_at: doc.published_at,
      capabilities: roleCaps(role).filter(c => c.startsWith('document.')) };
  };
  const filterDocs = (docs, params, versionOf = publishedVersion) => {
    const words = normalizeSearch(params.get('query') || '').trim().split(/\s+/u).filter(Boolean);
    const tags = [...new Set((params.get('tags') || '').split(',').filter(Boolean))];
    if ((params.get('query') || '').length > 200) validation('query');
    if (tags.length > 20) validation('tags');
    return docs.filter(doc => {
      const v = versionOf(doc), m = v.metadata_snapshot;
      return words.every(word => normalizeSearch(`${m.title}\n${v.content}`).includes(word))
        && (!params.get('category') || m.category?.id === params.get('category'))
        && (!params.get('collection') || m.collection?.id === params.get('collection'))
        && tags.every(id => m.tags.some(tag => tag.id === id));
    });
  };
  const facets = docs => {
    const categories = new Map(), tags = new Map();
    const add = (map, item) => { if (!item) return; const key = `${item.id}\0${item.name}`;
      if (!map.has(key)) map.set(key, { id: item.id, name: item.name, count: 0 }); map.get(key).count++; };
    for (const doc of docs) { const m = publishedVersion(doc).metadata_snapshot;
      add(categories, m.category); for (const tag of m.tags) add(tags, tag); }
    return { categories: [...categories.values()], tags: [...tags.values()] };
  };
  const page = (items, params, binding) => {
    const limit = params.has('limit') ? Number(params.get('limit')) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) validation('limit');
    const cursor = params.get('cursor');
    const query = new URLSearchParams(params); query.delete('cursor'); query.sort();
    const key = JSON.stringify({ ...binding, role: state.session.role, query: query.toString(), limit });
    let offset = 0;
    if (cursor) {
      const stored = state.cursors.get(cursor);
      if (!stored) validation('cursor', '分页标记无效，请重新搜索。');
      if (stored.key !== key) error(409, 'CURSOR_STALE', '列表已变化，请重新加载第一页。');
      offset = stored.offset;
    }
    let next_cursor = null;
    if (offset + limit < items.length) {
      next_cursor = `demo-cursor-${++state.sequence}`;
      state.cursors.set(next_cursor, { key, offset: offset + limit });
    }
    return { items: clone(items.slice(offset, offset + limit)), next_cursor };
  };
  const contentInput = (wid, doc, body) => {
    const fields = ['content_format', 'content', 'title', 'category_id', 'tag_ids', 'owner_id', 'collection_id', 'language'];
    for (const field of fields) if (!Object.hasOwn(body, field)) validation(field, '请填写完整的文档字段。');
    const allowed = new Set([...fields, 'source', 'source_ref', 'expected_revision', 'idempotency_key']);
    for (const field of Object.keys(body)) if (!allowed.has(field)) validation(field);
    if (!['text', 'markdown'].includes(body.content_format)) validation('content_format');
    for (const [field, maximum] of [['title', 200], ['language', 35]]) {
      if (typeof body[field] !== 'string' || [...body[field]].length > maximum || body[field].includes('\0')) validation(field);
    }
    if (typeof body.content !== 'string' || body.content.includes('\0') || new TextEncoder().encode(body.content).length > 1048576) validation('content');
    if (!Array.isArray(body.tag_ids) || body.tag_ids.length > 20 || new Set(body.tag_ids).size !== body.tag_ids.length
      || body.tag_ids.some(id => typeof id !== 'string' || !id)) validation('tag_ids');
    const getRef = (kind, id) => { if (id === null) return null;
      const entry = state.dictionaries[wid][kind].find(item => item.id === id && item.state === 'active');
      if (!entry) error(422, 'INVALID_REFERENCE', '关联内容不可用。', { fields: [kind] });
      return { id: entry.id, name: entry.name }; };
    const category = getRef('categories', body.category_id);
    const collection = getRef('collections', body.collection_id);
    const tags = body.tag_ids.map(id => getRef('tags', id));
    let owner = null;
    if (body.owner_id !== null) {
      const member = state.members[wid].find(m => m.user_id === body.owner_id && m.status === 'active');
      if (!member) error(422, 'INVALID_REFERENCE', '关联内容不可用。', { fields: ['owner_id'] });
      owner = { user_id: member.user_id, display_name: member.display_name };
    }
    if (Boolean(body.source) === Boolean(body.source_ref)) validation('source', '请选择一个有效来源。');
    let source;
    if (body.source_ref) {
      source = doc?.versions.map(v => v.metadata_snapshot.source).find(s => s.id === body.source_ref);
      if (!source) error(422, 'INVALID_REFERENCE', '关联内容不可用。', { fields: ['source_ref'] });
    } else {
      if (typeof body.source !== 'object' || Array.isArray(body.source)) validation('source');
      if (!['manual', 'markdown_import'].includes(body.source.kind)) validation('source.kind');
      for (const field of Object.keys(body.source)) if (!['kind', 'source_uri'].includes(field)) validation(`source.${field}`);
      if (body.source.source_uri) {
        let uri; try { uri = new URL(body.source.source_uri); } catch { validation('source.source_uri'); }
        if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password || uri.search || uri.hash) validation('source.source_uri');
      }
      const sourceId = `source-created-${++state.sequence}`;
      source = { id: sourceId, kind: body.source.kind,
        origin_ref: body.source.kind === 'manual' ? `internal:document/${doc.doc_id}` : `internal:markdown/${sourceId}`,
        source_uri: body.source.source_uri || null };
    }
    return { title: body.title, category, category_id: body.category_id, tags, tag_ids: clone(body.tag_ids),
      owner, owner_id: body.owner_id, collection, collection_id: body.collection_id,
      language: body.language, source: clone(source), source_ref: source.id };
  };
  const appendVersion = (doc, body, metadata) => {
    const version_no = doc.versions.length + 1;
    const version = { version_id: `version-created-${++state.sequence}`, document_id: doc.doc_id,
      version_no, parent_version_id: doc.versions.at(-1)?.version_id || null,
      metadata_snapshot: metadata, content_format: body.content_format, content: body.content,
      checksum: `demo-only-checksum-${state.sequence}`, quality_status: 'unchecked', created_by: 'user-me', created_at: now() };
    doc.versions.push(version); doc.latest_draft_version_id = version.version_id; doc.updated_at = version.created_at;
    return version;
  };

  const service = {
    login(role = 'Owner') {
      if (!['Owner', 'Admin', 'Editor', 'Viewer'].includes(role)) validation('role');
      state.session = { role, user: { user_id: 'user-me', display_name: '林知' } };
      state.members['ws-product'].find(m => m.user_id === 'user-me').role = role;
      state.members['ws-product'].find(m => m.user_id === 'user-founder').role = role === 'Owner' ? 'Admin' : 'Owner';
      state.cursors.clear();
      return clone(state.session);
    },
    reset() { state = initialState(); },
    failNext(code = 'SEARCH_UNAVAILABLE') { state.nextFailure = code; },
    async request(path, { method = 'GET', body = {}, signal } = {}) {
      if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
      method = method.toUpperCase();
      if (state.nextFailure) {
        const code = state.nextFailure; state.nextFailure = null;
        const statuses = { AUTH_REQUIRED: 401, SESSION_INVALID: 401, FORBIDDEN: 403, REAUTH_REQUIRED: 403,
          NOT_FOUND: 404, REVISION_CONFLICT: 409, CURSOR_STALE: 409, VALIDATION_FAILED: 422, QUALITY_FAILED: 422, RATE_LIMITED: 429 };
        if (statuses[code] === 401) state.session = null;
        error(statuses[code] || 503, code, '已触发演示错误；没有提交本次变更。');
      }
      const url = new URL(path, 'https://demo.invalid');
      const parts = url.pathname.split('/').filter(Boolean), params = url.searchParams;
      if (method === 'POST' && url.pathname === '/auth/logout') { state.session = null; state.cursors.clear(); return { revoked: true }; }
      if (!state.session) error(401, 'AUTH_REQUIRED', '请先登录工作台。');
      if (method === 'GET' && url.pathname === '/session') return { user: clone(state.session.user), csrf_token: 'demo-noncredential-csrf', capabilities: ['workspace.create'] };
      if (method === 'POST' && url.pathname === '/auth/logout-all') { state.session = null; state.cursors.clear(); return { revoked: true }; }
      if (parts[0] !== 'workspaces') missing();
      if (parts.length === 1) {
        if (method === 'GET') {
          const items = state.workspaces.filter(w => state.members[w.workspace_id]?.some(m => m.user_id === 'user-me' && m.status === 'active'))
            .map(w => ({ workspace_id: w.workspace_id, name: w.name, revision: w.revision,
              role: state.members[w.workspace_id].find(m => m.user_id === 'user-me').role }));
          return page(items, params, { route: '/workspaces', version: state.workspaces.length });
        }
        if (method === 'POST') {
          if (typeof body.name !== 'string' || !body.name.trim() || [...body.name].length > 100) validation('name');
          const workspace = { workspace_id: `ws-created-${++state.sequence}`, name: body.name.trim(), revision: 1, publishedRevision: 1, changeRevision: 1 };
          state.workspaces.push(workspace);
          state.members[workspace.workspace_id] = [{ membership_id: `member-created-${state.sequence}`, user_id: 'user-me',
            display_name: '林知', masked_email: 'l***@example.test', role: 'Owner', status: 'active', membership_revision: 1 }];
          state.dictionaries[workspace.workspace_id] = { categories: [], tags: [], collections: [] };
          state.invitations[workspace.workspace_id] = [];
          state.governance[workspace.workspace_id] = { revision: 1, ruleset_revision: 'demo-rules-1', stale_after_days: null };
          return { workspace_id: workspace.workspace_id, name: workspace.name, revision: 1, role: 'Owner' };
        }
        missing();
      }
      const wid = parts[1], ws = state.workspaces.find(w => w.workspace_id === wid);
      const me = state.members[wid]?.find(m => m.user_id === 'user-me' && m.status === 'active');
      if (!ws || !me) missing();
      const role = me.role;
      if (parts.length === 2) {
        if (method === 'PATCH') {
          if (role !== 'Owner') denied();
          revision(ws, body);
          if (typeof body.name !== 'string' || !body.name.trim() || [...body.name].length > 100 || body.name.includes('\0')) validation('name');
          ws.name = body.name.trim(); ws.revision++; changed(ws);
        } else if (method !== 'GET') missing();
        return { workspace_id: wid, name: ws.name, revision: ws.revision, role, capabilities: roleCaps(role) };
      }
      if (parts[2] === 'search' && method === 'GET') {
        const docs = filterDocs(publishedDocs(wid), params).sort((a, b) => b.published_at.localeCompare(a.published_at) || a.doc_id.localeCompare(b.doc_id));
        const hits = docs.map(doc => { const p = published(doc, role);
          return { doc_id: p.doc_id, version_id: p.version_id, title: p.title,
            snippet: [...p.content.replace(/<[^>]*>/gu, '').replace(/[#*`>]/gu, '').replace(/\s+/gu, ' ')].slice(0, 240).join(''),
            category: p.category, tags: p.tags, collection: p.collection, published_at: p.published_at }; });
        const result = page(hits, params, { route: url.pathname, version: ws.publishedRevision });
        return { scope: { workspace_id: wid, view: 'published', filters: { query: params.get('query') || '',
          category: params.get('category') || null, collection: params.get('collection') || null, tags: (params.get('tags') || '').split(',').filter(Boolean) } },
          as_of: now(), published_view_revision: `demo-published-${ws.publishedRevision}`, consistency: 'authoritative_published_snapshot',
          index_watermark: null, total: docs.length, hits: result.items, facets: facets(docs), next_cursor: result.next_cursor };
      }
      if (parts[2] === 'dashboard' && method === 'GET') {
        const view = params.get('view') || 'published';
        if (!['published', 'governance'].includes(view)) validation('view');
        if (view === 'governance' && !isManager(role)) denied();
        const docs = filterDocs(publishedDocs(wid), params);
        const result = { scope: { workspace_id: wid, view, filters: { category: params.get('category') || null,
          collection: params.get('collection') || null, tags: (params.get('tags') || '').split(',').filter(Boolean) } },
          as_of: now(), published_view_revision: `demo-published-${ws.publishedRevision}`, metric_revision: '1',
          published_count: docs.length, by_category: facets(docs).categories,
          definitions: { published_count: 'distinct current published document', by_category: 'same authorized published scope' } };
        if (view === 'governance') {
          result.scope.draft_filter_basis = 'latest_draft_snapshot';
          const drafts = filterDocs(activeDocs(wid).filter(d => d.latest_draft_version_id), params, latest);
          const counts = { unchecked: 0, failed: 0, error: 0, passed: 0 };
          for (const doc of drafts) counts[draftQualityStatus(doc)]++;
          result.governance = { draft_count: drafts.length, blocked_draft_count: counts.failed,
            unchecked_draft_count: counts.unchecked, error_draft_count: counts.error, passed_draft_count: counts.passed,
            published_findings: { documents_with_blockers: 0, documents_with_warnings: 0, checked_documents: 0,
              unchecked_documents: docs.length, error_documents: 0, last_checked_at: null }, rules_not_run: ['STALE_CONTENT'] };
        }
        return result;
      }
      if (['categories', 'tags', 'collections'].includes(parts[2])) {
        const kind = parts[2], entries = state.dictionaries[wid][kind];
        const view = params.get('view') || 'published';
        if (method === 'GET' && parts.length === 3) {
          if (!['published', 'manage'].includes(view)) validation('view');
          if (view === 'manage' && !isManager(role)) denied();
          let items;
          if (view === 'manage') items = kind === 'categories'
            ? entries.filter(entry => entry.state === 'active') : [...entries];
          else { const unique = new Map();
            for (const doc of publishedDocs(wid)) { const metadata = publishedVersion(doc).metadata_snapshot;
              const refs = kind === 'tags' ? metadata.tags : [metadata[kind === 'categories' ? 'category' : 'collection']];
              for (const ref of refs.filter(Boolean)) unique.set(`${ref.id}\0${ref.name}`, { id: ref.id, name: ref.name }); }
            items = [...unique.values()]; }
          items.sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)) || a.id.localeCompare(b.id));
          return page(items, params, { route: url.pathname, version: view === 'published' ? ws.publishedRevision : ws.changeRevision });
        }
        if (kind === 'categories' || (kind === 'collections' ? !isAdmin(role) : !isManager(role))) denied();
        const checkName = name => { if (typeof name !== 'string' || !name.trim() || [...name].length > 80 || name.includes('\0')) validation('name');
          if (entries.some(e => e.id !== parts[3] && normalize(e.name.trim()) === normalize(name.trim()))) error(409, 'RESOURCE_IN_USE', '同名条目已存在。'); };
        if (method === 'POST' && parts.length === 3) {
          checkName(body.name);
          const item = { id: `${kind}-${++state.sequence}`, name: body.name.trim(), state: 'active', revision: 1 };
          entries.push(item); changed(ws); return clone(item);
        }
        const item = entries.find(e => e.id === parts[3]); if (!item) missing();
        revision(item, body);
        if (method === 'PATCH') {
          if (body.name === undefined && body.state === undefined) validation('name');
          if (body.name !== undefined) checkName(body.name);
          if (body.state !== undefined && !['active', 'retired'].includes(body.state)) validation('state');
          if (body.name !== undefined) item.name = body.name.trim();
          if (body.state !== undefined) item.state = body.state;
          item.revision++; changed(ws); return clone(item);
        }
        if (method === 'DELETE') {
          const used = state.docs.filter(d => d.workspace_id === wid).some(d => d.versions.some(v => kind === 'tags'
            ? v.metadata_snapshot.tags.some(tag => tag.id === item.id) : v.metadata_snapshot.collection?.id === item.id));
          if (used) error(409, 'RESOURCE_IN_USE', '历史或当前文档仍引用此条目，无法删除。');
          entries.splice(entries.indexOf(item), 1); changed(ws); return { deleted: true };
        }
        missing();
      }
      if (parts[2] === 'members') {
        if (method === 'GET' && parts[3] === 'me' && parts.length === 4) return clone(me);
        if (method === 'POST' && parts[3] === 'me' && parts[4] === 'leave') {
          if (role === 'Owner') error(409, 'OWNER_TRANSFER_REQUIRED', '请先完成工作区所有者转移。');
          revision(me, body, 'membership_revision'); me.status = 'removed'; me.membership_revision++; changed(ws); return { removed: true };
        }
        if (!isAdmin(role)) denied();
        if (method === 'GET' && parts.length === 3) return page(state.members[wid].filter(m => m.status !== 'removed'), params,
          { route: url.pathname, version: ws.changeRevision });
        const member = state.members[wid].find(m => m.membership_id === parts[3]); if (!member) missing();
        if (member.role === 'Owner') denied();
        if (role === 'Admin' && (member.user_id === me.user_id || !['Editor', 'Viewer'].includes(member.role)
          || (body.role !== undefined && !['Editor', 'Viewer'].includes(body.role)))) denied();
        if (!['PATCH', 'DELETE'].includes(method)) missing();
        revision(member, body, 'membership_revision');
        if (member.status === 'removed') error(409, 'INVALID_STATE', '此成员已移除。');
        if (method === 'DELETE') { member.status = 'removed'; member.membership_revision++; changed(ws); return { removed: true, membership_revision: member.membership_revision }; }
        if (body.role === undefined && body.status === undefined) validation('role');
        if (body.role !== undefined && !['Admin', 'Editor', 'Viewer'].includes(body.role)) validation('role');
        if (body.status !== undefined && !['active', 'disabled'].includes(body.status)) validation('status');
        if (body.role !== undefined) member.role = body.role;
        if (body.status !== undefined) member.status = body.status;
        member.membership_revision++; changed(ws); return clone(member);
      }
      if (parts[2] === 'invitations') {
        if (!isAdmin(role)) denied();
        if (method === 'GET') return page(state.invitations[wid], params, { route: url.pathname, version: ws.changeRevision });
        if (method === 'POST' && parts.length === 3) {
          const inviteRole = body.role || 'Viewer';
          if (!['Admin', 'Editor', 'Viewer'].includes(inviteRole)) validation('role');
          if (role === 'Admin' && inviteRole === 'Admin') denied();
          if (typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.email)) validation('email');
          const invitation = { invitation_id: `invitation-${++state.sequence}`, role: inviteRole, status: 'pending', revision: 1,
            expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), masked_email: `${body.email[0]}***@${body.email.split('@')[1]}` };
          state.invitations[wid].push(invitation); changed(ws); return { ...clone(invitation), delivery_status: 'pending' };
        }
        const invitation = state.invitations[wid].find(i => i.invitation_id === parts[3]); if (!invitation) missing();
        if (role === 'Admin' && invitation.role === 'Admin') denied();
        if (method === 'POST' && parts[4] === 'revoke') {
          revision(invitation, body);
          if (invitation.status !== 'pending') error(409, 'INVALID_STATE', '此邀请无法撤销。');
          invitation.status = 'revoked'; invitation.revision++; changed(ws); return { status: invitation.status, revision: invitation.revision };
        }
        missing();
      }
      if (parts[2] === 'governance') {
        if (!isManager(role)) denied();
        const config = state.governance[wid];
        if (parts[3] === 'rules' && method === 'GET') return { ...clone(config),
          rules: BLOCKER_RULES.map(rule_id => ({ rule_id, severity: 'blocker', enabled: true })) };
        if (parts[3] === 'config' && method === 'PUT') {
          if (!isAdmin(role)) denied(); revision(config, body);
          if (!Number.isInteger(body.stale_after_days) || body.stale_after_days < 1 || body.stale_after_days > 3650) validation('stale_after_days');
          config.stale_after_days = body.stale_after_days; config.revision++; config.ruleset_revision = `demo-rules-${config.revision}`;
          changed(ws); return clone(config);
        }
        missing();
      }
      if (parts[2] === 'audit-events') { if (!isAdmin(role)) denied(); return { items: [], next_cursor: null }; }
      if (parts[2] !== 'documents') missing();
      if (parts[3] === 'manage' && method === 'GET') {
        if (!isManager(role)) denied();
        const requestedState = params.get('state');
        if (requestedState && !['draft', 'published', 'archived', 'deleted'].includes(requestedState)) validation('state');
        const docs = state.docs.filter(d => d.workspace_id === wid && (requestedState ? d.state === requestedState : ['draft', 'published'].includes(d.state)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.doc_id.localeCompare(b.doc_id));
        return page(docs.map(d => managed(d, role)), params, { route: url.pathname, version: ws.changeRevision });
      }
      if (parts.length === 3 && method === 'POST') {
        if (!isManager(role)) denied();
        const doc = { doc_id: `doc-created-${++state.sequence}`, workspace_id: wid, state: 'draft', revision: 1,
          latest_draft_version_id: null, current_published_version_id: null, created_at: now(), updated_at: now(),
          published_at: null, versions: [], qualityRuns: [] };
        const metadata = contentInput(wid, doc, body);
        appendVersion(doc, body, metadata); state.docs.push(doc); changed(ws); return clone(managed(doc, role));
      }
      const doc = state.docs.find(d => d.workspace_id === wid && d.doc_id === parts[3]);
      if (!doc) missing();
      const publicVisible = doc.state === 'published' && doc.current_published_version_id;
      if (method === 'GET' && parts.length === 4) { if (!publicVisible) missing(); return published(doc, role); }
      if (!isManager(role)) {
        if (!publicVisible || method === 'GET') missing();
        denied();
      }
      if (parts[4] === 'manage' && method === 'GET') return clone(managed(doc, role));
      if (!['draft', 'published'].includes(doc.state) && !(method === 'DELETE' && parts.length === 4)) missing();
      if (parts[4] === 'versions') {
        if (method === 'GET' && parts.length === 5) return page([...doc.versions].reverse().map(v => ({ version_id: v.version_id,
          version_no: v.version_no, created_by: v.created_by, created_at: v.created_at, quality_status: versionQualityStatus(doc, v) })), params,
          { route: url.pathname, version: doc.revision });
        if (method === 'GET' && parts.length === 6) {
          const version = doc.versions.find(v => v.version_id === parts[5]); if (!version) missing();
          return { ...clone(version), quality_status: versionQualityStatus(doc, version) };
        }
        if (method === 'POST' && parts.length === 5) {
          revision(doc, body); const metadata = contentInput(wid, doc, body);
          const version = appendVersion(doc, body, metadata); doc.revision++; changed(ws);
          return { document: clone(managed(doc, role)), version_id: version.version_id };
        }
        missing();
      }
      if (parts[4] === 'quality-runs' && method === 'GET') return page(doc.qualityRuns.filter(run => !params.get('version_id') || run.version_id === params.get('version_id')),
        params, { route: url.pathname, version: doc.revision });
      if (parts[4] === 'publish' && method === 'POST') {
        revision(doc, body);
        if (!doc.latest_draft_version_id || body.version_id !== doc.latest_draft_version_id) error(409, 'INVALID_STATE', '只能发布当前最新草稿。');
        const v = latest(doc), m = v.metadata_snapshot;
        const ownerActive = m.owner_id && state.members[wid].some(member => member.user_id === m.owner_id && member.status === 'active');
        const validRef = (kind, id) => id === null || state.dictionaries[wid][kind].some(item => item.id === id && item.state === 'active');
        const checks = [
          ['META_REQUIRED', 'metadata', Boolean(m.title.trim() && m.category && m.owner && m.source)],
          ['CONTENT_REQUIRED', 'content', Boolean(v.content.trim())],
          ['REF_INTEGRITY', 'metadata', validRef('categories', m.category_id) && validRef('collections', m.collection_id) && m.tag_ids.every(id => validRef('tags', id))],
          ['CONTENT_INTEGRITY', 'content', Boolean(v.checksum)], ['OWNER_INACTIVE', 'owner_id', Boolean(ownerActive)],
        ];
        const findings = checks.map(([rule_id, field, passed]) => ({ rule_id, severity: 'blocker', field, passed,
          message: passed ? '检查通过' : ({ META_REQUIRED: '请补齐标题、分类和负责人。', CONTENT_REQUIRED: '正文不能为空。',
            REF_INTEGRITY: '关联条目已停用。', CONTENT_INTEGRITY: '正文完整性不可确认。', OWNER_INACTIVE: '负责人必须是有效成员。' }[rule_id]) }));
        const passed = findings.every(f => f.passed), run_id = `quality-${++state.sequence}`;
        const run = { run_id, document_id: doc.doc_id, version_id: v.version_id, document_revision: doc.revision,
          ruleset_revision: state.governance[wid].ruleset_revision, checked_at: now(), status: 'completed', quality_status: passed ? 'passed' : 'failed',
          findings, not_run_rules: ['STALE_CONTENT'] };
        qualityContexts.set(run, qualityContext(doc, v));
        doc.qualityRuns.unshift(run); v.quality_status = run.quality_status;
        if (!passed) error(422, 'QUALITY_FAILED', '草稿未通过发布检查，请补齐信息后再试。', { findings: clone(findings.filter(f => !f.passed)), quality_run_id: run_id });
        doc.state = 'published'; doc.current_published_version_id = v.version_id; doc.latest_draft_version_id = null;
        doc.published_at = now(); doc.updated_at = doc.published_at; doc.revision++; changed(ws, true);
        return { document: clone(managed(doc, role)), published: published(doc, role), quality_run_id: run_id };
      }
      if (parts[4] === 'archive' && method === 'POST') {
        revision(doc, body); if (doc.state !== 'published') error(409, 'INVALID_STATE', '仅已发布文档可归档。');
        doc.state = 'archived'; doc.archived_at = now(); doc.revision++; changed(ws, true);
        return { doc_id: doc.doc_id, state: doc.state, revision: doc.revision };
      }
      if (parts.length === 4 && method === 'DELETE') {
        revision(doc, body); if (doc.state === 'deleted') error(409, 'INVALID_STATE', '文档已删除。');
        const wasPublished = doc.state === 'published'; doc.state = 'deleted'; doc.deleted_at = now(); doc.revision++; changed(ws, wasPublished);
        return { doc_id: doc.doc_id, state: doc.state, revision: doc.revision };
      }
      missing();
    },
  };
  return service;
}

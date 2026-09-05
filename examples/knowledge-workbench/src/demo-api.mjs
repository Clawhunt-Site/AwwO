import { ApiError } from './api.mjs';
import { can, capabilitiesFor, ROLES } from './permissions.mjs';

const clone = value => structuredClone(value);
const fail = (status, code, message, details) => { throw new ApiError(status, code, message, { details }); };
const id = () => globalThis.crypto.randomUUID();
const now = () => new Date().toISOString();
const normalize = value => value.normalize('NFKC').toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const validate = (valid, field) => { if (!valid) fail(422, 'VALIDATION_FAILED', '请检查输入字段。', { field }); };
const checkFields = (input, allowed) => {
  validate(input && typeof input === 'object' && !Array.isArray(input), 'input');
  for (const key of Object.keys(input)) validate(allowed.includes(key), key);
};
const keyOrder = value => Array.isArray(value) ? value.map(keyOrder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, keyOrder(value[key])])) : value;
const fingerprint = value => JSON.stringify(keyOrder(value));
const makeId = (group, index) => `${group.toString(16).padStart(8, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
export const DEMO_IDS = Object.freeze({ workspaceA: makeId(1, 1), workspaceB: makeId(1, 2),
  published: makeId(4, 1), secondPublished: makeId(4, 2), draft: makeId(4, 3),
  archived: makeId(4, 4), deleted: makeId(4, 5), otherPublished: makeId(4, 6) });

// This is a disposable in-memory UI fixture, not authentication or backend enforcement.
// Never use its role selector, cursors or validation as production authorization.
export function createDemoApi() {
  let persona = null;
  const users = Object.fromEntries(ROLES.map((role, i) => [role, { user_id: makeId(2, i + 1), status: 'active', display_name: `演示${role}` }]));
  const spaces = [DEMO_IDS.workspaceA, DEMO_IDS.workspaceB].map((workspace_id, i) => ({
    workspace_id, name: i ? '客户知识库（演示）' : '产品知识库（演示）', status: 'active', revision: 1,
  }));
  const memberships = spaces.flatMap((space, j) => ROLES.map((role, i) => ({
    workspace_id: space.workspace_id, membership_id: makeId(3, j * 10 + i + 1),
    user_id: users[role].user_id, display_name: users[role].display_name, masked_email: 'demo***@example.invalid',
    role: j && role !== 'Owner' ? 'Viewer' : role, status: 'active', membership_revision: 1,
  })));
  const dictionaries = Object.fromEntries(spaces.map((space, j) => [space.workspace_id,
    Object.fromEntries(['categories', 'tags', 'collections'].map((kind, k) => [kind,
      [0, 1].map(i => ({ id: makeId(10 + j * 10 + k, i + 1), name: (['使用指南', '入门', '团队手册'][k]) + (i ? '（草稿候选）' : ''),
        state: 'active', revision: 1 }))]))]));
  const docs = new Map();
  const publishRevisions = new Map(spaces.map(space => [space.workspace_id, 1]));
  const mutations = new Map(spaces.map(space => [space.workspace_id, 1]));
  const cursors = new Map();
  const replay = new Map();
  const blockRules = ['META_REQUIRED', 'CONTENT_REQUIRED', 'REF_INTEGRITY', 'CONTENT_INTEGRITY', 'OWNER_INACTIVE'];

  function session() {
    if (!persona || users[persona]?.status !== 'active') fail(401, 'AUTH_REQUIRED', '请先进入演示工作区。');
    return users[persona];
  }
  function context(wid) {
    const user = session();
    const workspace = spaces.find(space => space.workspace_id === wid && space.status === 'active');
    const membership = memberships.find(member => member.workspace_id === wid && member.user_id === user.user_id && member.status === 'active');
    if (!workspace || !membership) fail(404, 'NOT_FOUND', '工作区不存在或不可访问。');
    return { sessionValid: true, user, workspace, membership };
  }
  function authorize(wid, action, target) {
    const ctx = context(wid);
    if (!can(ctx, action, target)) fail(403, 'FORBIDDEN', '你没有执行此操作的权限。');
    return ctx;
  }
  function findDocument(wid, did, action = 'document.read.published', management = false) {
    const ctx = context(wid), doc = docs.get(did);
    if (!doc || doc.workspace_id !== wid) fail(404, 'NOT_FOUND', '内容不存在或不可访问。');
    if (!can(ctx, 'document.read.draft') && (management || doc.state !== 'published' || !doc.published)) {
      fail(404, 'NOT_FOUND', '内容不存在或不可访问。');
    }
    if (!can(ctx, action)) fail(403, 'FORBIDDEN', '你没有执行此操作的权限。');
    return doc;
  }
  function readable(doc) {
    if (!['draft', 'published'].includes(doc.state)) fail(404, 'NOT_FOUND', '内容不存在或不可访问。');
  }
  function managed(doc) {
    if (!['draft', 'published'].includes(doc.state)) return { doc_id: doc.doc_id, state: doc.state,
      revision: doc.revision, archived_at: doc.archived_at ?? null, deleted_at: doc.deleted_at ?? null };
    const latest = doc.versions.at(-1);
    return { doc_id: doc.doc_id, workspace_id: doc.workspace_id, state: doc.state, revision: doc.revision,
      latest_draft_version_id: doc.draft, current_published_version_id: doc.published,
      latest_metadata: clone(latest.metadata_snapshot), created_at: doc.created_at, updated_at: doc.updated_at,
      published_at: doc.published_at, capabilities: capabilitiesFor(context(doc.workspace_id)) };
  }
  const publishedVersion = doc => doc.versions.find(version => version.version_id === doc.published);
  function published(doc) {
    if (doc.state !== 'published' || !doc.published) fail(404, 'NOT_FOUND', '内容不存在或不可访问。');
    const version = publishedVersion(doc), meta = version.metadata_snapshot;
    return { doc_id: doc.doc_id, workspace_id: doc.workspace_id, version_id: version.version_id,
      title: meta.title, category: clone(meta.category), tags: clone(meta.tags), owner: clone(meta.owner),
      source: clone(meta.source), collection: clone(meta.collection), language: meta.language,
      content_format: version.content_format, content: version.content, published_at: doc.published_at,
      capabilities: capabilitiesFor(context(doc.workspace_id)) };
  }
  function changed(wid, publishing = false) {
    mutations.set(wid, mutations.get(wid) + 1);
    if (publishing) publishRevisions.set(wid, publishRevisions.get(wid) + 1);
  }
  function qualityDependencies(wid, meta) {
    return fingerprint({
      owner: memberships.find(member => member.workspace_id === wid && member.user_id === meta.owner_id) ?? null,
      dictionaries: [['categories', [meta.category_id]], ['tags', meta.tag_ids], ['collections', [meta.collection_id]]]
        .map(([kind, refs]) => refs.filter(Boolean).map(ref => dictionaries[wid][kind].find(item => item.id === ref) ?? null)),
    });
  }
  function revision(entity, expected, field = 'revision') {
    validate(Number.isInteger(expected) && expected > 0, 'expected_revision');
    if (entity[field] !== expected) fail(409, 'REVISION_CONFLICT', '内容已变化，请刷新后再保存。', { current_revision: entity[field] });
  }
  function mutate(wid, route, body, guard, execute, readback) {
    guard(); validate(typeof body.idempotency_key === 'string' && uuid.test(body.idempotency_key), 'idempotency_key');
    const key = `${session().user_id}:${wid}:${route}:${body.idempotency_key}`, fp = fingerprint(body), prior = replay.get(key);
    if (prior) {
      if (prior.fingerprint !== fp) fail(409, 'IDEMPOTENCY_CONFLICT', '同一操作标识不能用于不同请求。');
      return readback ? readback(prior.result) : clone(prior.result);
    }
    const result = execute(); replay.set(key, { fingerprint: fp, result: clone(result) }); return clone(result);
  }
  function paginate(items, query, binding) {
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    validate(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit');
    const bound = fingerprint({ ...binding, user: session().user_id, limit });
    let offset = 0;
    if (query.cursor) {
      const saved = cursors.get(query.cursor);
      if (!saved) fail(422, 'VALIDATION_FAILED', '分页标识无效。');
      if (saved.bound !== bound) fail(409, 'CURSOR_STALE', '检索条件或权限已变化，请重新检索。');
      offset = saved.offset;
    }
    let next_cursor = null;
    if (offset + limit < items.length) { next_cursor = id(); cursors.set(next_cursor, { bound, offset: offset + limit }); }
    return { items: clone(items.slice(offset, offset + limit)), next_cursor };
  }
  function filters(input = {}, allowQuery = true) {
    checkFields(input, [...(allowQuery ? ['query', 'cursor', 'limit'] : ['view']), 'category', 'tags', 'collection']);
    const query = input.query ?? '';
    validate(typeof query === 'string' && [...query].length <= 200 && !query.includes('\0'), 'query');
    const tags = typeof input.tags === 'string' ? input.tags.split(',').filter(Boolean) : input.tags ?? [];
    validate(Array.isArray(tags) && tags.length <= 20 && tags.every(tag => typeof tag === 'string' && uuid.test(tag)), 'tags');
    for (const field of ['category', 'collection']) if (input[field]) validate(uuid.test(input[field]), field);
    return { query, category: input.category || null, tags: [...new Set(tags)].sort(), collection: input.collection || null };
  }
  const matches = (meta, filter) => (!filter.category || meta.category?.id === filter.category) &&
    (!filter.collection || meta.collection?.id === filter.collection) && filter.tags.every(tag => meta.tags.some(item => item.id === tag));
  function publishedSet(wid, filter) {
    const words = normalize(filter.query).split(/\s+/u).filter(Boolean);
    return [...docs.values()].filter(doc => {
      if (doc.workspace_id !== wid || doc.state !== 'published' || !doc.published) return false;
      const version = publishedVersion(doc);
      const text = normalize(`${version.metadata_snapshot.title}\n${version.content}`);
      return matches(version.metadata_snapshot, filter) && words.every(word => text.includes(word));
    }).sort((a, b) => b.published_at.localeCompare(a.published_at) || a.doc_id.localeCompare(b.doc_id));
  }
  function facets(set, field) {
    const counts = new Map();
    for (const doc of set) {
      const value = publishedVersion(doc).metadata_snapshot[field];
      const unique = new Map((Array.isArray(value) ? value : value ? [value] : []).map(item => [fingerprint([item.id, item.name]), item]));
      for (const [key, item] of unique) counts.set(key, { id: item.id, name: item.name, count: (counts.get(key)?.count ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name));
  }
  const contentFields = ['content_format', 'content', 'title', 'category_id', 'tag_ids', 'owner_id', 'collection_id', 'language', 'source', 'source_ref'];
  function contentInput(wid, body, doc) {
    checkFields(body, [...contentFields, 'idempotency_key', ...(doc ? ['expected_revision'] : [])]);
    for (const field of ['content', 'title', 'language']) validate(typeof body[field] === 'string' && !body[field].includes('\0'), field);
    validate([...body.title].length <= 200, 'title'); validate([...body.language].length <= 35, 'language');
    validate(new TextEncoder().encode(body.content).length <= 1024 * 1024, 'content');
    validate(['text', 'markdown'].includes(body.content_format), 'content_format');
    validate(Array.isArray(body.tag_ids) && body.tag_ids.length <= 20, 'tag_ids');
    const lookup = (kind, value) => {
      if (value === null) return null;
      const item = dictionaries[wid][kind].find(candidate => candidate.id === value && candidate.state === 'active');
      if (!item) fail(422, 'INVALID_REFERENCE', '引用不可用。');
      return { id: item.id, name: item.name };
    };
    const category = lookup('categories', body.category_id), collection = lookup('collections', body.collection_id);
    const tags = [...new Set(body.tag_ids)].map(value => lookup('tags', value));
    validate(tags.every(Boolean), 'tag_ids');
    let owner = null;
    if (body.owner_id !== null) {
      const member = memberships.find(item => item.workspace_id === wid && item.user_id === body.owner_id && item.status === 'active');
      if (!member) fail(422, 'INVALID_REFERENCE', '引用不可用。');
      owner = { user_id: member.user_id, display_name: member.display_name };
    }
    validate(('source' in body) !== ('source_ref' in body), 'source');
    let source;
    if ('source_ref' in body) {
      source = doc?.versions.map(version => version.metadata_snapshot.source).find(item => item.id === body.source_ref);
      if (!source) fail(422, 'INVALID_REFERENCE', '引用不可用。');
    } else {
      checkFields(body.source, ['kind', 'source_uri']);
      validate(['manual', 'markdown_import'].includes(body.source.kind), 'source.kind');
      if (body.source.source_uri) {
        let url; try { url = new URL(body.source.source_uri); } catch { validate(false, 'source.source_uri'); }
        validate(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'source.source_uri');
      }
      source = { id: id(), kind: body.source.kind, origin_ref: `internal:document/${doc?.doc_id ?? 'pending'}`,
        source_uri: body.source.source_uri ?? null };
    }
    return { title: body.title, category_id: body.category_id, category, tag_ids: tags.map(tag => tag.id), tags,
      owner_id: body.owner_id, owner, collection_id: body.collection_id, collection, language: body.language,
      source_ref: source.id, source: clone(source) };
  }
  function addVersion(doc, body, meta) {
    const version = { version_id: id(), document_id: doc.doc_id, version_no: doc.versions.length + 1,
      parent_version_id: doc.versions.at(-1)?.version_id ?? null, metadata_snapshot: clone(meta),
      content_format: body.content_format, content: body.content, checksum: null,
      quality_status: 'unchecked', created_by: session().user_id, created_at: now() };
    doc.versions.push(version); doc.draft = version.version_id; return version;
  }
  function newDocument(wid, body, meta, docId = id()) {
    const doc = { doc_id: docId, workspace_id: wid, state: 'draft', revision: 1, versions: [],
      draft: null, published: null, created_at: now(), updated_at: now(), published_at: null, quality: null };
    if (meta.source.origin_ref.endsWith('/pending')) meta.source.origin_ref = `internal:document/${docId}`;
    addVersion(doc, body, meta); docs.set(doc.doc_id, doc); return doc;
  }
  // Immutable source objects are kept private; every public read returns a copy.
  persona = 'Owner';
  for (const [index, docId] of [DEMO_IDS.published, DEMO_IDS.secondPublished, DEMO_IDS.draft,
    DEMO_IDS.archived, DEMO_IDS.deleted, DEMO_IDS.otherPublished].entries()) {
    const wid = index === 5 ? DEMO_IDS.workspaceB : DEMO_IDS.workspaceA, dict = dictionaries[wid];
    const body = { content_format: 'markdown', content: index === 2 ? 'SECRET_DRAFT_ONLY 未发布演示内容' : '# 团队知识\n欢迎使用团队知识库。这是虚构的演示文档。',
      title: ['快速入门', '知识整理规范', 'SECRET_DRAFT_TITLE', '已归档演示', '已删除演示', '客户知识入门'][index],
      category_id: dict.categories[0].id, tag_ids: [dict.tags[index === 2 ? 1 : 0].id], owner_id: users.Owner.user_id,
      collection_id: dict.collections[0].id, language: 'zh-CN', source: { kind: 'manual' } };
    const doc = newDocument(wid, body, contentInput(wid, body), docId);
    if (index !== 2) { doc.published = doc.draft; doc.draft = null; doc.state = 'published'; doc.published_at = '2026-09-01T08:00:00Z'; }
    if (index === 3) { doc.state = 'archived'; doc.archived_at = now(); }
    if (index === 4) { doc.state = 'deleted'; doc.deleted_at = now(); }
  }
  persona = null;

  const api = {
    mode: 'demo', label: '演示模式 · 虚构数据 · 不连接真实账号，刷新即重置',
    personas: ROLES.map(role => ({ role, user_id: users[role].user_id, label: `以${role}演示` })),
    async enterDemo(role = 'Viewer') { validate(ROLES.includes(role), 'persona'); persona = role; return api.getSession(); },
    async getSession() { return { user: { user_id: session().user_id }, capabilities: [], demo: true }; },
    async logout() { persona = null; return { revoked: true, demo: true }; },
    clearSession() { persona = null; },
    async startLogin() { fail(503, 'AUTH_DEPENDENCY_UNAVAILABLE', '真实身份源尚未接入，请使用明确标示的演示入口。'); },
    async completeLogin() { fail(503, 'AUTH_DEPENDENCY_UNAVAILABLE', '真实身份源尚未接入。'); },
    async listWorkspaces(query = {}) {
      const user = session();
      const items = spaces.filter(space => space.status === 'active').flatMap(space => {
        const member = memberships.find(item => item.workspace_id === space.workspace_id && item.user_id === user.user_id && item.status === 'active');
        return member ? [{ workspace_id: space.workspace_id, name: space.name, revision: space.revision, role: member.role }] : [];
      });
      return paginate(items, query, { list: 'workspaces', memberships: memberships.map(item => item.membership_revision), spaces });
    },
    async getWorkspace(wid) { const ctx = context(wid); return { workspace_id: wid, name: ctx.workspace.name,
      role: ctx.membership.role, revision: ctx.workspace.revision, capabilities: capabilitiesFor(ctx) }; },
    async getMe(wid) { const { workspace_id, ...member } = context(wid).membership; return clone(member); },
    async listMembers(wid, query = {}) {
      const ctx = authorize(wid, 'membership.read');
      return paginate(memberships.filter(member => member.workspace_id === wid).map(({ workspace_id, ...member }) => member), query,
        { wid, list: 'members', revision: mutations.get(wid), membership: ctx.membership.membership_revision });
    },
    async updateWorkspace(wid, body) {
      checkFields(body, ['name', 'expected_revision', 'idempotency_key']);
      return mutate(wid, 'PATCH workspace', body, () => authorize(wid, 'workspace.settings.update'), () => {
        const space = context(wid).workspace; revision(space, body.expected_revision);
        validate(typeof body.name === 'string' && body.name.trim().length > 0 && [...body.name].length <= 100 && !body.name.includes('\0'), 'name');
        space.name = body.name.trim(); space.revision++; changed(wid); return { workspace_id: wid, name: space.name, revision: space.revision, role: 'Owner' };
      });
    },
    async updateMember(wid, mid, body) {
      checkFields(body, ['role', 'status', 'expected_revision', 'idempotency_key']);
      validate(body.role !== undefined || body.status !== undefined, 'role/status');
      if (body.role !== undefined) validate(ROLES.includes(body.role), 'role');
      if (body.status !== undefined) validate(['active', 'disabled'].includes(body.status), 'status');
      const guard = () => {
        authorize(wid, 'membership.read'); const member = memberships.find(item => item.workspace_id === wid && item.membership_id === mid);
        if (!member) fail(404, 'NOT_FOUND', '成员不存在或不可访问。');
        if (body.role !== undefined) authorize(wid, 'membership.role.update', { ...member, next_role: body.role });
        if (body.status !== undefined) authorize(wid, body.status === 'disabled' ? 'membership.disable' : 'membership.enable', member);
        return member;
      };
      return mutate(wid, `PATCH member/${mid}`, body, guard, () => {
        const member = guard(); revision(member, body.expected_revision, 'membership_revision');
        if (body.role !== undefined) member.role = body.role;
        if (body.status !== undefined) member.status = body.status;
        member.membership_revision++; changed(wid); const { workspace_id, ...dto } = member; return dto;
      });
    },
    async removeMember(wid, mid, body) {
      checkFields(body, ['expected_revision', 'idempotency_key']);
      const guard = () => {
        authorize(wid, 'membership.read'); const member = memberships.find(item => item.workspace_id === wid && item.membership_id === mid);
        if (!member) fail(404, 'NOT_FOUND', '成员不存在或不可访问。');
        authorize(wid, 'membership.remove', member); return member;
      };
      return mutate(wid, `DELETE member/${mid}`, body, guard, () => {
        const member = guard(); revision(member, body.expected_revision, 'membership_revision');
        member.status = 'removed'; member.membership_revision++; changed(wid);
        return { removed: true, membership_revision: member.membership_revision };
      });
    },
    async search(wid, query = {}) {
      const ctx = authorize(wid, 'search.query'), filter = filters(query), set = publishedSet(wid, filter);
      const page = paginate(set.map(doc => {
        const dto = published(doc); return { doc_id: dto.doc_id, version_id: dto.version_id, title: dto.title,
          snippet: [...dto.content].slice(0, 240).join(''), category: dto.category, tags: dto.tags,
          collection: dto.collection, published_at: dto.published_at };
      }), query, { wid, type: 'search', filter, revision: publishRevisions.get(wid), membership: ctx.membership.membership_revision });
      return { scope: { workspace_id: wid, view: 'published', filters: filter }, as_of: now(),
        published_view_revision: `demo-pub-${publishRevisions.get(wid)}`, consistency: 'authoritative_published_snapshot',
        index_watermark: null, total: set.length, hits: page.items,
        facets: { categories: facets(set, 'category'), tags: facets(set, 'tags') }, next_cursor: page.next_cursor };
    },
    async dashboard(wid, query = {}) {
      authorize(wid, 'dashboard.read.published'); validate(['published', 'governance'].includes(query.view ?? 'published'), 'view');
      if (query.view === 'governance') authorize(wid, 'dashboard.read.governance');
      const filter = filters(query, false), set = publishedSet(wid, filter);
      const result = { scope: { workspace_id: wid, view: query.view ?? 'published', filters: filter }, as_of: now(),
        published_view_revision: `demo-pub-${publishRevisions.get(wid)}`, metric_revision: '1',
        published_count: set.length, by_category: facets(set, 'category'),
        definitions: { published_count: 'distinct current published document', by_category: 'same authorized published scope' } };
      if (query.view === 'governance') {
        const drafts = [...docs.values()].filter(doc => doc.workspace_id === wid && ['draft', 'published'].includes(doc.state) && doc.draft && matches(doc.versions.at(-1).metadata_snapshot, filter));
        const blocked = drafts.filter(doc => doc.quality?.revision === doc.revision && doc.quality.status === 'failed' &&
          doc.quality.dependencies === qualityDependencies(wid, doc.versions.at(-1).metadata_snapshot)).length;
        result.scope.draft_filter_basis = 'latest_draft_snapshot';
        result.governance = { draft_count: drafts.length, blocked_draft_count: blocked,
          unchecked_draft_count: drafts.length - blocked, error_draft_count: 0, passed_draft_count: 0,
          published_findings: { documents_with_blockers: 0, documents_with_warnings: 0, checked_documents: 0,
            unchecked_documents: set.length, error_documents: 0, last_checked_at: null },
          rules_not_run: [...blockRules, 'TITLE_DUPLICATE', 'CONTENT_DUPLICATE', 'STALE_CONTENT'] };
      }
      return result;
    },
    async listDocuments(wid, query = {}) {
      const ctx = authorize(wid, 'document.read.draft');
      if (query.state !== undefined) validate(['draft', 'published', 'archived', 'deleted'].includes(query.state), 'state');
      const set = [...docs.values()].filter(doc => doc.workspace_id === wid && (query.state ? doc.state === query.state : ['draft', 'published'].includes(doc.state)))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.doc_id.localeCompare(b.doc_id));
      return paginate(set.map(managed), query, { wid, type: 'manage', state: query.state, revision: mutations.get(wid), membership: ctx.membership.membership_revision });
    },
    async getDocument(wid, did) { return published(findDocument(wid, did)); },
    async getManagedDocument(wid, did) { return managed(findDocument(wid, did, 'document.read.draft', true)); },
    async listVersions(wid, did, query = {}) {
      const doc = findDocument(wid, did, 'document.read.versions', true); readable(doc);
      return paginate([...doc.versions].reverse().map(version => ({ version_id: version.version_id, version_no: version.version_no,
        created_by: version.created_by, created_at: version.created_at, quality_status: 'unchecked' })), query,
      { wid, did, type: 'versions', revision: doc.revision, membership: context(wid).membership.membership_revision });
    },
    async getVersion(wid, did, vid) {
      const doc = findDocument(wid, did, 'document.read.versions', true); readable(doc);
      const version = doc.versions.find(item => item.version_id === vid);
      if (!version) fail(404, 'NOT_FOUND', '版本不存在或不可访问。');
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(version.content));
      // Recheck after the async boundary in case the fixture persona changed.
      findDocument(wid, did, 'document.read.versions', true); readable(doc);
      return { ...clone(version), checksum: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
    },
    async createDocument(wid, body) {
      return mutate(wid, 'POST documents', body, () => authorize(wid, 'document.create'), () => {
        const doc = newDocument(wid, body, contentInput(wid, body)); changed(wid); return managed(doc);
      }, prior => managed(findDocument(wid, prior.doc_id, 'document.read.draft', true)));
    },
    async saveVersion(wid, did, body) {
      const guard = () => {
        const doc = findDocument(wid, did, 'document.edit');
        authorize(wid, 'document.metadata.update'); authorize(wid, 'document.tag.assign'); readable(doc); return doc;
      };
      return mutate(wid, `POST documents/${did}/versions`, body, guard, () => {
        const doc = guard(); revision(doc, body.expected_revision); const meta = contentInput(wid, body, doc);
        const version = addVersion(doc, body, meta); doc.revision++; doc.updated_at = now(); doc.quality = null; changed(wid);
        return { document: managed(doc), version_id: version.version_id };
      }, prior => ({ document: managed(guard()), version_id: prior.version_id }));
    },
    async publishDocument(wid, did, body) {
      checkFields(body, ['version_id', 'expected_revision', 'idempotency_key']);
      const guard = () => { const doc = findDocument(wid, did, 'document.publish'); readable(doc); return doc; };
      return mutate(wid, `POST documents/${did}/publish`, body, guard, () => {
        const doc = guard(); revision(doc, body.expected_revision);
        if (!doc.draft || body.version_id !== doc.draft) fail(409, 'INVALID_STATE', '请选择最新草稿。');
        const version = doc.versions.at(-1), meta = version.metadata_snapshot;
        const invalid = [];
        if (!meta.title.trim()) invalid.push('title'); if (!version.content.trim()) invalid.push('content');
        if (!meta.category) invalid.push('category_id'); if (!meta.owner) invalid.push('owner_id');
        if (meta.owner && !memberships.some(member => member.workspace_id === wid && member.user_id === meta.owner.user_id && member.status === 'active')) invalid.push('owner_id');
        for (const [kind, ids] of [['categories', [meta.category_id]], ['tags', meta.tag_ids], ['collections', [meta.collection_id]]]) {
          if (ids.filter(Boolean).some(ref => !dictionaries[wid][kind].some(item => item.id === ref && item.state === 'active'))) invalid.push(kind);
        }
        if (invalid.length) { doc.quality = { revision: doc.revision, status: 'failed', dependencies: qualityDependencies(wid, meta) };
          fail(422, 'QUALITY_FAILED', '发布检查未通过。', { fields: [...new Set(invalid)] }); }
        doc.published = version.version_id; doc.draft = null; doc.state = 'published'; doc.published_at = now();
        doc.updated_at = doc.published_at; doc.revision++; changed(wid, true);
        return { document: managed(doc), published: published(doc), quality_run_id: null, demo_validation_only: true };
      }, () => { const doc = guard(); return { document: managed(doc), published: published(doc), quality_run_id: null, demo_validation_only: true }; });
    },
    async archiveDocument(wid, did, body) { return changeState(wid, did, body, 'archived'); },
    async deleteDocument(wid, did, body) { return changeState(wid, did, body, 'deleted'); },
    async listDictionary(wid, kind, query = {}) {
      const ctx = context(wid); validate(['categories', 'tags', 'collections'].includes(kind), 'kind');
      validate(['published', 'manage'].includes(query.view ?? 'published'), 'view');
      let items;
      if (query.view === 'manage') {
        authorize(wid, kind === 'categories' ? 'document.metadata.update' : kind === 'tags' ? 'tag.read' : 'collection.read');
        items = dictionaries[wid][kind].filter(item => item.state === 'active');
      } else {
        const field = { categories: 'category', tags: 'tags', collections: 'collection' }[kind];
        items = facets(publishedSet(wid, { query: '', tags: [] }), field).map(({ id, name }) => ({ id, name }));
      }
      items = [...items].sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)) || a.id.localeCompare(b.id));
      return paginate(items, query, { wid, kind, view: query.view ?? 'published', membership: ctx.membership.membership_revision,
        revision: query.view === 'manage' ? mutations.get(wid) : publishRevisions.get(wid) });
    },
    async createDictionary(wid, kind, body) { return changeDictionary(wid, kind, null, body, 'create'); },
    async updateDictionary(wid, kind, itemId, body) { return changeDictionary(wid, kind, itemId, body, 'update'); },
    async deleteDictionary(wid, kind, itemId, body) { return changeDictionary(wid, kind, itemId, body, 'delete'); },
  };
  function changeState(wid, did, body, state) {
    checkFields(body, ['expected_revision', 'idempotency_key']);
    const guard = () => findDocument(wid, did, state === 'archived' ? 'document.archive' : 'document.soft-delete');
    return mutate(wid, `${state} documents/${did}`, body, guard, () => {
      const doc = guard(); revision(doc, body.expected_revision);
      if (state === 'archived' ? doc.state !== 'published' : doc.state === 'deleted') fail(409, 'INVALID_STATE', '当前状态不允许此操作。');
      const wasPublished = doc.state === 'published'; doc.state = state; doc[`${state}_at`] = now(); doc.revision++; changed(wid, wasPublished);
      return { doc_id: did, state, revision: doc.revision };
    });
  }
  function changeDictionary(wid, kind, itemId, body, operation) {
    context(wid); if (!['tags', 'collections'].includes(kind)) fail(403, 'FORBIDDEN', '此字典维护尚未开放。');
    checkFields(body, operation === 'create' ? ['name', 'idempotency_key'] : operation === 'update'
      ? ['name', 'state', 'expected_revision', 'idempotency_key'] : ['expected_revision', 'idempotency_key']);
    const action = `${kind === 'tags' ? 'tag' : 'collection'}.${operation === 'delete' ? kind === 'tags' ? 'delete-unused' : 'delete-empty' : operation}`;
    return mutate(wid, `${operation} ${kind}/${itemId ?? ''}`, body, () => authorize(wid, action), () => {
      const items = dictionaries[wid][kind];
      const item = operation === 'create' ? { id: id(), state: 'active', revision: 1 } : items.find(candidate => candidate.id === itemId);
      if (!item) fail(404, 'NOT_FOUND', '条目不存在或不可访问。');
      if (operation !== 'create') revision(item, body.expected_revision);
      if (operation === 'delete') {
        const used = [...docs.values()].some(doc => doc.workspace_id === wid && doc.versions.some(version => kind === 'tags'
          ? version.metadata_snapshot.tag_ids.includes(itemId) : version.metadata_snapshot.collection_id === itemId));
        if (used) fail(409, 'RESOURCE_IN_USE', '条目仍被文档或历史版本引用。');
        items.splice(items.indexOf(item), 1); changed(wid); return { deleted: true };
      }
      validate(operation === 'create' || body.name !== undefined || body.state !== undefined, 'name/state');
      if (body.state !== undefined) validate(['active', 'retired'].includes(body.state), 'state');
      if (body.name !== undefined || operation === 'create') {
        validate(typeof body.name === 'string' && body.name.trim().length > 0 && [...body.name].length <= 80 && !body.name.includes('\0'), 'name');
        if (items.some(other => other.id !== item.id && normalize(other.name.trim()) === normalize(body.name.trim()))) fail(409, 'RESOURCE_IN_USE', '名称已被使用。');
        item.name = body.name.trim();
      }
      if (body.state !== undefined) item.state = body.state;
      if (operation === 'create') items.push(item); else item.revision++;
      changed(wid); return clone(item);
    });
  }
  return Object.freeze(api);
}

import { ApiClient } from './api.js';
import { copy } from './copy.js';
import { initAccessibility } from './accessibility.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const t = key => copy[key] ?? key;
const icon = name => `<span class="ui-icon" aria-hidden="true">${({book:'▤',search:'⌕',chart:'▥',users:'♧',settings:'⚙',tag:'◇',plus:'＋',arrow:'↗',lock:'◈',check:'✓'})[name] ?? '•'}</span>`;
const button = (text, action, cls = 'secondary', extra = '') => `<button type="button" class="button ${cls}" data-action="${action}" ${extra}>${text}</button>`;
const date = value => value ? new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : '未提供';
const state = {
  demo: new URLSearchParams(location.search).get('mode') !== 'live', session:null, workspaces:[], workspace:null,
  route:'', sequence:0, controller:null, dirty:false, busy:false, query:'', category:'', tags:'', collection:'',
  cursor:null, cursorHistory:[], editor:null, navOpen:false, authMessage:'', currentPage:'documents'
};
const pendingIntents=new Map();
const api = new ApiClient({demo:state.demo,onUnauthorized:() => {
  state.session = null; state.workspace = null; state.workspaces = []; state.editor = null;
  state.dirty = false; state.authMessage = t('auth.expired');
  pendingIntents.clear();
  $('#app').replaceChildren();
  queueMicrotask(() => navigate('/login',true));
}});
const allowed = action => Boolean(state.workspace?.capabilities?.includes(action));
const base = () => `/workspaces/${encodeURIComponent(state.workspace.workspace_id)}`;
const path = (page='documents') => `/w/${encodeURIComponent(state.workspace.workspace_id)}/${page}`;
const request = async (url, opts={}) => {
  const write=opts.method && !['GET','HEAD'].includes(opts.method);
  let fingerprint;
  if(write && opts.body?.idempotency_key) {
    const {idempotency_key:ignored,...payload}=opts.body;
    fingerprint=JSON.stringify([url,opts.method,payload]);
    if(!pendingIntents.has(fingerprint))pendingIntents.set(fingerprint,opts.body.idempotency_key);
    opts={...opts,body:{...payload,idempotency_key:pendingIntents.get(fingerprint)}};
  }
  if(write)state.writeInFlight=true;
  try {
    const data=await api.request(url,{signal:state.controller?.signal,...opts});
    if(fingerprint)pendingIntents.delete(fingerprint);
    return data;
  }catch(error){
    // An ambiguous failure may have committed: an explicit retry reuses its key.
    if(fingerprint && [400,403,404,422].includes(error.status))pendingIntents.delete(fingerprint);
    throw error;
  }finally{if(write)state.writeInFlight=false;}
};
async function listAll(url) {
  const parsed=new URL(url,'https://local.invalid');parsed.searchParams.set('limit','100');
  const items=[],seen=new Set();
  for(let page=0;page<100;page++) {
    const result=await request(parsed.pathname+parsed.search);items.push(...result.items);
    if(!result.next_cursor)return {items,next_cursor:null};
    if(seen.has(result.next_cursor))throw new Error('服务返回了重复的分页游标。');
    seen.add(result.next_cursor);parsed.searchParams.set('cursor',result.next_cursor);
  }
  throw new Error('列表超过前端读取上限，请联系管理员缩小范围。');
}
const fresh = sequence => sequence === state.sequence;
const nonce = () => crypto.randomUUID();
let toastTimer;
function toast(message) {
  window.clearTimeout(toastTimer); const target=$('#toast'); target.textContent = message; target.hidden = false;
  toastTimer = window.setTimeout(() => { if(target.isConnected)target.hidden = true; },4500);
}
function dialog(title,body,actions=[{label:'确定',value:true,primary:true},{label:'取消',value:false}]) {
  const el = $('#dialog');
  const opener = document.activeElement;
  el.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2></div><div class="dialog-body">${body}</div><div class="dialog-actions">${actions.map((a,i)=>`<button class="button ${a.primary?'primary':'secondary'}" data-dialog="${i}">${esc(a.label)}</button>`).join('')}</div>`;
  return new Promise(resolve => {
    let result = false;
    el.onclick = event => { const b=event.target.closest('[data-dialog]'); if(b){result=actions[Number(b.dataset.dialog)].value; el.close();} };
    el.onclose = () => { el.onclick=null; if(opener?.isConnected)opener.focus(); else $('h1')?.focus(); resolve(result); };
    el.showModal();
  });
}
async function leaveAllowed() {
  if(state.busy) return false;
  return !state.dirty || await dialog('离开编辑？',`<p>${t('doc.unsaved')}</p>`,[{label:t('doc.stay'),value:false,primary:true},{label:t('doc.leave'),value:true}]);
}
async function navigate(route,force=false) {
  if(!force && !await leaveAllowed()) return;
  state.dirty=false; state.editor=null;
  if(location.hash === `#${route}`) await renderRoute(); else location.hash=route;
}
function heading(title,description='',actions='') {
  return `<section class="page-heading"><div><div class="eyebrow">TEAM KNOWLEDGE</div><h1 tabindex="-1">${esc(title)}</h1><p>${esc(description)}</p></div><div class="heading-actions">${actions}</div></section>`;
}
function notice(message,kind='info') { return `<div class="notice ${kind}" role="${kind==='error'?'alert':'status'}">${esc(message)}</div>`; }
function empty(message,action='') { return `<div class="empty-state"><div class="state-icon">${icon('book')}</div><h2>${esc(message)}</h2>${action}</div>`; }
function scope(data) {
  if(!data?.scope || !data?.as_of) return '';
  return `<p class="filter-note">统计范围：${esc(state.workspace.name)} · ${data.scope.view==='governance'?'授权发布内容与可管理最新草稿':'授权已发布文档'}；更新时间：${esc(date(data.as_of))}。</p>`;
}
function errorText(error) {
  if(error.code==='CURSOR_STALE') return '检索快照已变化，请返回第一页重新加载。';
  if(error.code==='REAUTH_REQUIRED') return '此操作需要重新认证，请完成身份验证后重试。';
  if(error.code==='RESOURCE_IN_USE') return '该标签或集合仍被文档版本引用，暂不能删除。';
  if(error.status===401) return t('auth.expired');
  if(error.status===403) return t('common.forbidden');
  if(error.status===404) return t('doc.unavailable');
  if(error.status===409) return t('doc.conflict');
  if(error.status===422) return t('doc.invalid');
  return t('common.loadError');
}
function errorBlock(error,write=false) {
  const fields=error.details?.fields ?? error.details?.findings ?? [];
  const details = Array.isArray(fields) ? fields.map(f=>typeof f==='string'?f:f.message??f.field).filter(Boolean) : Object.values(fields);
  return `<div class="error-state" role="alert"><h2>${esc(errorText(error))}</h2>${write?`<p>${t('doc.saveError')} 不会自动重放写入。</p>`:''}${details.length?`<ul>${details.map(d=>`<li>${esc(d)}</li>`).join('')}</ul>`:''}<p class="muted">${esc(error.code||'NETWORK_ERROR')}${error.request_id?` · 请求 ${esc(error.request_id)}`:''}</p>${write?'':button(error.code==='CURSOR_STALE'?'回到第一页':t('common.retry'),'retry')}</div>`;
}
function shell() {
  const nav=[['documents','book','文档空间'],['search','search','全文检索'],...(allowed('document.read.draft')?[['manage','book','文档管理']]:[]),['dashboard','chart','数据看板'],['taxonomy','tag','标签与集合'],...(allowed('membership.invite')?[['members','users','成员与角色']]:[]),['settings','settings','工作区设置']];
  $('#app').innerHTML=`${state.demo?`<div class="demo-banner">${icon('lock')}${t('demo.banner')}</div>`:''}<div class="app-shell ${state.navOpen?'nav-open':''}"><aside class="sidebar" aria-label="工作区导航"><a class="brand" href="#/workspaces"><span class="brand-mark">知</span><span>团队知识库<small>让知识持续生长</small></span></a><div class="workspace-switch"><label for="workspace-switch">当前工作区</label><select id="workspace-switch">${state.workspaces.map(w=>`<option value="${esc(w.workspace_id)}" ${w.workspace_id===state.workspace?.workspace_id?'selected':''}>${esc(w.name)} · ${esc(w.role)}</option>`).join('')}</select></div><div class="nav-group"><span class="nav-label">工作台</span>${nav.map(([page,i,label])=>`<button class="nav-item" data-nav="${path(page)}" ${state.currentPage===page?'aria-current="page"':''}>${icon(i)}${label}</button>`).join('')}</div><div class="sidebar-footer"><div class="profile"><span class="avatar">${esc((state.session?.user?.display_name||'我').slice(0,1))}</span><div><strong>${esc(state.session?.user?.display_name||'当前成员')}</strong><small>${esc(state.workspace?.role)} · 当前权限</small></div></div>${button('切换工作区','workspaces','small')}${button('退出登录','logout','small')}</div></aside><main id="main-content" class="main"><header class="topbar"><button class="icon-button mobile-nav-toggle" data-action="toggle-nav" aria-label="展开工作区导航" aria-expanded="${state.navOpen}">☰</button><div class="breadcrumbs">${esc(state.workspace?.name)} <span>/ 工作台</span></div><div class="topbar-actions"><span class="badge neutral">${icon('lock')} 工作区内可见</span>${button('使用指南','help','small')}</div></header><div class="page-content" id="page-content" aria-busy="true"><div class="loading-state"><div class="skeleton"></div><p>${t('common.loading')}</p></div></div>${state.demo?demoTools():''}</main></div>`;
}
function demoTools() {
  return `<details class="demo-tools"><summary>演示验收工具</summary><p>仅影响本页内存夹具。刷新页面重置内容。</p><label>下一次操作的响应<select id="simulate-error"><option value="">选择场景</option><option value="SESSION_INVALID">401 登录失效</option><option value="FORBIDDEN">403 权限不足</option><option value="NOT_FOUND">404 资源不可用</option><option value="REVISION_CONFLICT">409 版本冲突</option><option value="QUALITY_FAILED">422 质检失败</option><option value="SEARCH_UNAVAILABLE">503 服务故障</option><option value="CURSOR_STALE">分页快照失效</option></select></label>${button('注入一次响应','simulate','small')}<p>权限角色在演示登录页选择；这些控制不能验证真实服务端授权。</p></details>`;
}
function content(html,sequence=state.sequence) {
  if(!fresh(sequence)) return;
  const el=$('#page-content'); if(!el) return;
  el.innerHTML=html; el.setAttribute('aria-busy','false');
}
function loginPage() {
  $('#app').innerHTML=`${state.demo?`<div class="demo-banner">${t('demo.banner')}</div>`:''}<main id="main-content" class="login-shell"><section class="login-story"><div class="brand"><span class="brand-mark">知</span>团队知识库</div><div class="eyebrow">A PLACE FOR WHAT YOUR TEAM KNOWS</div><h1>让团队知识<br>有处可查<span class="accent">。</span></h1><p>${t('home.body')}</p><div class="login-art" aria-hidden="true"><div class="orbit-card"><span class="badge success">已发布</span><h3>从一个问题，到团队共识</h3><p>产品指南 · 团队方法 · 实践记录</p><div class="art-lines"><i></i><i></i><i></i></div><span class="tag">有序沉淀</span> <span class="tag">轻松找到</span></div></div><small>每一份经验，都值得被找到。</small></section><section class="login-card"><div class="eyebrow">WELCOME BACK</div><h2>${t('home.cta')}</h2><p class="muted">${t('auth.hint')}</p>${state.authMessage?notice(state.authMessage,'warning'):''}<form id="login-form" class="login-form">${state.demo?`<label for="demo-role">演示身份<select id="demo-role" name="role"><option>Owner</option><option>Admin</option><option>Editor</option><option>Viewer</option></select></label><p class="muted">体验固定四角色的菜单和操作差异。</p><button class="button primary" type="submit">进入演示工作区 ${icon('arrow')}</button><p class="filter-note">本次体验使用内存数据，不创建真实账号。</p>`:`${notice('身份源尚未配置。登录回调适配由身份服务选型后接入。')}<button class="button primary" type="submit">通过身份服务登录</button>`}</form><div id="auth-error"></div><div class="login-help"><strong>知识有边界，协作有秩序</strong><p class="muted">仅显示你已加入的工作区与有权阅读的发布版本。</p></div></section></main>`;
  $('#login-form').onsubmit=async event=>{
    event.preventDefault(); const submit=$('button[type=submit]',event.target); submit.disabled=true;
    try {
      if(state.demo) api.demo.login($('#demo-role').value);
      else {
        await api.request('/auth/login/start',{method:'POST',body:{return_path:'/workspaces'}});
        $('#auth-error').innerHTML=notice('身份挑战已创建；身份源回调适配尚未配置，无法完成登录。','warning'); return;
      }
      state.session=await api.request('/session'); state.authMessage=''; await navigate('/workspaces',true);
    }catch(error){$('#auth-error').innerHTML=errorBlock(error);}finally{submit.disabled=false;}
  };
}
async function workspacePage(sequence) {
  state.workspace=null;
  $('#app').innerHTML=`${state.demo?`<div class="demo-banner">${t('demo.banner')}</div>`:''}<main id="main-content" class="workspace-entry"><div class="brand"><span class="brand-mark">知</span>团队知识库</div><div id="page-content">${notice(t('common.loading'))}</div></main>`;
  const response=await listAll('/workspaces'); if(!fresh(sequence))return;
  state.workspaces=response.items;
  content(`${heading(t('ws.choose'),'从熟悉的工作区，继续你的知识旅程。',button('退出登录','logout'))}${state.workspaces.length?`<div class="workspace-grid">${state.workspaces.map((w,i)=>`<button class="workspace-card" data-nav="/w/${esc(w.workspace_id)}/documents"><div class="workspace-emblem">${i===0?'知':'共'}</div><span class="badge neutral">${esc(w.role)}</span><h2>${esc(w.name)}</h2><p>进入工作区 ${icon('arrow')}</p></button>`).join('')}</div>`:empty(t('ws.empty'))}<section class="panel"><h2>创建新的工作区</h2><p class="muted">建立独立的文档空间。创建后，你将成为此工作区的 Owner。</p><form id="workspace-create" class="inline-form"><label>工作区名称<input name="name" maxlength="100" required placeholder="例如：设计团队"></label><button class="button primary">创建工作区</button></form><div id="create-error"></div></section>`,sequence);
  $('#workspace-create').onsubmit=async event=>{
    event.preventDefault(); const name=new FormData(event.target).get('name').trim(); if(!name)return;
    await mutation(async()=>{const w=await request('/workspaces',{method:'POST',body:{name,idempotency_key:nonce()}}); await navigate(`/w/${w.workspace_id}/documents`,true);},'#create-error');
  };
}
async function renderRoute() {
  const route=location.hash.slice(1)||'/login';
  if(state.writeInFlight){history.replaceState(null,'',`#${state.route}`);toast('正在提交，请等待操作结果。');return;}
  if(state.dirty && route!==state.route && !await leaveAllowed()){history.replaceState(null,'',`#${state.route}`);return;}
  state.dirty=false; state.editor=null; state.navOpen=false;
  state.controller?.abort(); state.controller=new AbortController(); const sequence=++state.sequence;
  state.route=route;
  try {
    if(route==='/login'){loginPage();return;}
    if(route==='/callback') {
      loginPage(); $('#auth-error').innerHTML=notice('身份回调尚未接入。无法确认登录结果，请返回登录入口。','warning');return;
    }
    if(!state.session) state.session=await request('/session');
    if(!fresh(sequence))return;
    if(route==='/workspaces'){await workspacePage(sequence);return;}
    const match=route.match(/^\/w\/([^/]+)\/(documents|search|manage|new|doc|edit|dashboard|members|taxonomy|settings)(?:\/([^/]+))?$/);
    if(!match){await navigate('/workspaces',true);return;}
    const [,wid,page,id]=match; state.currentPage=page;
    // Remove old workspace DOM before any awaited request. Filters alone persist.
    state.workspace=null; $('#app').innerHTML=`${state.demo?`<div class="demo-banner">${t('demo.banner')}</div>`:''}<main class="loading-state">${t('common.loading')}</main>`;
    const [workspace,workspaces]=await Promise.all([request(`/workspaces/${encodeURIComponent(wid)}`),listAll('/workspaces')]);
    if(!fresh(sequence))return; state.workspace=workspace; state.workspaces=workspaces.items;
    shell();
    const pages={documents:searchPage,search:searchPage,manage:managePage,new:editorPage,edit:editorPage,doc:detailPage,dashboard:dashboardPage,members:membersPage,taxonomy:taxonomyPage,settings:settingsPage};
    await pages[page](sequence,id);
    if(fresh(sequence)) $('h1')?.focus({preventScroll:true});
  }catch(error){
    if(!fresh(sequence)||error.name==='AbortError')return;
    if(error.status===401){state.session=null;state.workspace=null;state.editor=null; await navigate('/login',true);return;}
    if(!$('#page-content')) $('#app').innerHTML=`<main id="main-content" class="page-content"><div id="page-content"></div></main>`;
    content(errorBlock(error),sequence);
  }
}
function filterParams(includeQuery=true) {
  const p=new URLSearchParams(); if(includeQuery)p.set('query',state.query);
  for(const key of ['category','tags','collection']) if(state[key])p.set(key,state[key]);
  return p;
}
function optionList(items,value,placeholder='全部') {
  return `<option value="">${placeholder}</option>${value&&!items.some(i=>i.id===value)?`<option value="${esc(value)}" selected>保留的筛选（此工作区无候选）</option>`:''}${items.map(i=>`<option value="${esc(i.id)}" ${i.id===value?'selected':''}>${esc(i.name)}</option>`).join('')}`;
}
async function dictionaries(view='published') {
  const [categories,tags,collections]=await Promise.all(['categories','tags','collections'].map(kind=>listAll(`${base()}/${kind}?view=${view}`)));
  return {categories:categories.items,tags:tags.items,collections:collections.items};
}
async function searchPage(sequence) {
  const params=filterParams(); params.set('limit','6');if(state.cursor)params.set('cursor',state.cursor);
  const [data,dict]=await Promise.all([request(`${base()}/search?${params}`),dictionaries()]); if(!fresh(sequence))return;
  content(`${heading(state.currentPage==='search'?'在知识中找到答案':'文档空间','把经验整理成文档，让下一次协作更轻松。',allowed('document.create')?button(`${icon('plus')} ${t('doc.create')}`,'new','primary'):'')}
    <section class="panel search-panel"><form id="search-form" class="search-form"><label class="search-input">${icon('search')}<input name="query" aria-label="搜索关键词" maxlength="200" placeholder="${t('search.placeholder')}" value="${esc(state.query)}"></label><button class="button primary search-button" type="submit">搜索文档</button></form><div class="filters"><label>分类<select id="filter-category">${optionList(dict.categories,state.category,'所有分类')}</select></label><label>标签<select id="filter-tags">${optionList(dict.tags,state.tags,'所有标签')}</select></label><label>集合<select id="filter-collection">${optionList(dict.collections,state.collection,'所有集合')}</select></label>${button(t('search.clear'),'clear-filters','small')}</div><p class="filter-note">仅检索有权查看的已发布版本 · 按发布时间排序 · 切换工作区保留检索条件</p></section>
    <div class="section-heading"><h2>${state.query?'检索结果':'最近发布'}</h2><span class="result-meta">${Number(data.total)} 篇文档</span></div>${scope(data)}
    ${data.hits.length?`<div class="document-grid">${data.hits.map(hit=>`<article class="document-card"><div class="card-meta"><span class="doc-icon">${icon('book')}</span><span class="badge success">已发布</span></div><button class="document-title" data-nav="${path(`doc/${hit.doc_id}`)}"><h3>${esc(hit.title||'未命名文档')}</h3></button><p class="document-snippet">${esc(hit.snippet||'打开查看文档内容。')}</p><div class="tag-list">${(hit.tags||[]).map(tag=>`<span class="tag">${esc(tag.name)}</span>`).join('')}</div><div class="card-footer"><span>${esc(hit.category?.name||'未分类')}</span><time>${esc(date(hit.published_at))}</time></div></article>`).join('')}</div>`:empty(state.query||state.category||state.tags||state.collection?t('search.empty'):t('doc.empty'),button(t('search.clear'),'clear-filters'))}
    <div class="pagination">${button('上一页','previous','secondary',''+(state.cursorHistory.length?'':'disabled'))}<span>第 ${state.cursorHistory.length+1} 页</span>${button('下一页','next','secondary',data.next_cursor?`data-cursor="${esc(data.next_cursor)}"`:'disabled')}</div>
    <details class="panel facets"><summary>当前筛选的分类与标签分布</summary><div class="tag-list">${[...(data.facets?.categories||[]),...(data.facets?.tags||[])].map(f=>`<span class="tag">${esc(f.name)} · ${Number(f.count)}</span>`).join('')||'<p>暂无分布数据。</p>'}</div></details>`,sequence);
  $('#search-form').onsubmit=event=>{event.preventDefault();state.query=new FormData(event.target).get('query');resetCursor();renderRoute();};
  for(const key of ['category','tags','collection'])$(`#filter-${key}`).onchange=event=>{state[key]=event.target.value;resetCursor();renderRoute();};
}
function resetCursor(){state.cursor=null;state.cursorHistory=[];}
async function managePage(sequence) {
  if(!allowed('document.read.draft')){content(notice(t('common.forbidden'),'error'));return;}
  const data=await listAll(`${base()}/documents/manage`);if(!fresh(sequence))return;
  content(`${heading('文档管理','草稿仅对有权管理的成员可见。修改已发布文档时，原发布版继续可读。',allowed('document.create')?button(t('doc.create'),'new','primary'):'')}${data.items.length?`<div class="panel table-wrap"><table class="data-table"><thead><tr><th>文档</th><th>发布状态</th><th>修订</th><th>最近更新</th><th>操作</th></tr></thead><tbody>${data.items.map(doc=>`<tr><td><strong>${esc(doc.latest_metadata?.title||'未命名草稿')}</strong></td><td><span class="badge ${doc.current_published_version_id?'success':'warning'}">${doc.current_published_version_id?'已有发布版':'未发布'}</span> ${doc.latest_draft_version_id?'<span class="badge neutral">有草稿</span>':''}</td><td>${doc.revision}</td><td>${esc(date(doc.updated_at))}</td><td><button class="button small" data-nav="${path(`edit/${doc.doc_id}`)}">编辑</button>${doc.current_published_version_id?`<button class="button small" data-nav="${path(`doc/${doc.doc_id}`)}">发布版</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:empty(t('doc.first'),button(t('doc.create'),'new','primary'))}`,sequence);
}
async function detailPage(sequence,id) {
  const data=await request(`${base()}/documents/${encodeURIComponent(id)}`);if(!fresh(sequence))return;
  const caps=data.capabilities||[];
  content(`${heading(data.title,'正在阅读已发布版本',caps.includes('document.edit')?button('编辑新草稿','edit','primary',`data-id="${esc(id)}"`):'')}<div class="detail-layout"><article class="panel document-body"><div class="tag-list">${(data.tags||[]).map(tag=>`<span class="tag">${esc(tag.name)}</span>`).join('')}</div><pre>${esc(data.content)}</pre></article><aside class="panel metadata-list"><h2>文档信息</h2><dl><dt>可见范围</dt><dd>当前工作区</dd><dt>版本状态</dt><dd><span class="badge success">已发布</span></dd><dt>分类</dt><dd>${esc(data.category?.name||'未分类')}</dd><dt>集合</dt><dd>${esc(data.collection?.name||'无集合')}</dd><dt>责任人</dt><dd>${esc(data.owner?.display_name||'未提供')}</dd><dt>来源引用</dt><dd>${esc(data.source?.source_uri||data.source?.origin_ref||'未提供')}</dd><dt>发布时间</dt><dd>${esc(date(data.published_at))}</dd></dl>${button(t('common.back'),'documents','small')}</aside></div>`,sequence);
}
function editorForm(dict,metadata={},body='',id=null) {
  const tagIds=(metadata.tags||[]).map(i=>i.id); const ownerId=metadata.owner?.user_id||'';
  const owners=[{id:state.session.user.user_id,name:state.session.user.display_name||'我'}];
  if(ownerId&&!owners.some(o=>o.id===ownerId))owners.push({id:ownerId,name:metadata.owner.display_name||'当前责任人'});
  return `<form id="editor-form"><div id="editor-error"></div><div class="editor-layout"><section class="panel"><div class="form-grid"><label class="full-width">标题<input name="title" maxlength="200" value="${esc(metadata.title||'')}" placeholder="给这份知识一个清晰的标题"></label><label>正文格式<select name="content_format"><option value="markdown" ${state.editor?.format!=='text'?'selected':''}>Markdown 原文</option><option value="text" ${state.editor?.format==='text'?'selected':''}>纯文本</option></select></label><label>语言<input name="language" maxlength="35" value="${esc(metadata.language||'zh-CN')}"></label><label class="full-width">正文<textarea class="editor-textarea" name="content" rows="18" placeholder="记录背景、方法与下一步…">${esc(body)}</textarea></label></div><p class="filter-note">正文按纯文本安全呈现；Markdown 排版渲染未接入。</p></section><aside class="panel editor-aside"><h2>发布信息</h2><label>分类<select name="category_id">${optionList(dict.categories,metadata.category?.id||'','请选择分类')}</select></label><label>责任人<select name="owner_id" id="owner-select">${optionList(owners,ownerId,'请选择责任人')}</select></label><label>集合（可选）<select name="collection_id">${optionList(dict.collections,metadata.collection?.id||'','不归入集合')}</select></label><fieldset><legend>标签（最多 20 个）</legend><div class="checkbox-group">${dict.tags.map(tag=>`<label><input type="checkbox" name="tag_ids" value="${esc(tag.id)}" ${tagIds.includes(tag.id)?'checked':''}>${esc(tag.name)}</label>`).join('')||'<p class="muted">暂无标签</p>'}</div></fieldset><label>来源链接（可选）<input name="source_uri" type="url" value="${esc(metadata.source?.source_uri||'')}" placeholder="https://example.com/guide"></label><p class="filter-note">可留空，保存为人工记录。链接不得包含账号、查询参数或片段。</p><div class="notice info">发布需填写标题、分类、责任人和正文，并通过服务端质检。</div></aside></div><div class="form-actions"><span id="dirty-status" class="muted">${id?'正在编辑最新版本':'新文档 · 尚未保存'}</span><div>${button('返回管理','manage')}${allowed('document.create')||allowed('document.edit')?'<button class="button primary" type="submit">保存草稿</button>':''}${id&&state.editor.doc.latest_draft_version_id&&allowed('document.publish')?button(t('doc.publish'),'publish','primary'):''}</div></div></form>${id?`<section class="panel"><h2>版本与生命周期</h2><div class="heading-actions">${button('查看版本记录','versions','small')}${state.editor.doc.current_published_version_id?button('归档文档','archive','small'):''}${button('软删除文档','delete-document','danger small')}</div><div id="version-history"></div></section>`:''}`;
}
async function editorPage(sequence,id) {
  if(!allowed(id?'document.edit':'document.create')){content(notice(t('common.forbidden'),'error'));return;}
  const dict=await dictionaries('manage');
  for(const key of ['categories','tags','collections'])dict[key]=dict[key].filter(item=>!item.state||item.state==='active');
  let doc=null,version=null,members=null;
  if(id){doc=await request(`${base()}/documents/${id}/manage`);const vid=doc.latest_draft_version_id||doc.current_published_version_id;if(!vid){content(notice(t('doc.unavailable'),'error'));return;}version=await request(`${base()}/documents/${id}/versions/${vid}`);}
  if(['Owner','Admin'].includes(state.workspace.role)) members=await listAll(`${base()}/members`);
  if(!fresh(sequence))return;
  state.editor={doc,version,format:version?.content_format||'markdown',dict};
  content(`${heading(id?'编辑文档':'新建文档',id?'每次保存追加一个版本，发布前不会替换已有发布内容。':'先留下想法，再完善发布信息。')} ${editorForm(dict,version?.metadata_snapshot,version?.content,id)}`,sequence);
  if(members) {
    const select=$('#owner-select'); const value=select.value;
    select.innerHTML=optionList(members.items.filter(m=>m.status==='active').map(m=>({id:m.user_id,name:m.display_name})),value,'请选择责任人');
  }
  $('#editor-form').oninput=()=>{state.dirty=true;$('#dirty-status').textContent='有未保存的修改';};
  $('#editor-form').onsubmit=saveDraft;
}
function getEditorInput() {
  const form=new FormData($('#editor-form')); const sourceUri=form.get('source_uri').trim();
  const input={content_format:form.get('content_format'),content:form.get('content'),title:form.get('title'),category_id:form.get('category_id')||null,tag_ids:form.getAll('tag_ids'),owner_id:form.get('owner_id')||null,collection_id:form.get('collection_id')||null,language:form.get('language'),source:{kind:'manual'}};
  if(sourceUri){const u=new URL(sourceUri);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('来源链接仅支持不含账号、参数和片段的 HTTP/HTTPS 地址。');input.source.source_uri=sourceUri;}
  const original=state.editor.version?.metadata_snapshot;
  if(original?.source_ref && sourceUri===(original.source?.source_uri||'')) {delete input.source;input.source_ref=original.source_ref;}
  if(new TextEncoder().encode(input.content).length>1048576)throw new Error('正文不得超过 1 MiB，请保留当前内容并缩减后保存。');
  if([...input.title].length>200||input.tag_ids.length>20)throw new Error('标题最多 200 个字符，标签最多 20 个。');
  return input;
}
async function mutation(fn,errorSelector='#editor-error') {
  if(state.busy)return;
  state.busy=true; const disabled=new Map();
  // Inert keeps FormData intact while preventing edits during a pending write.
  const forms=[...document.querySelectorAll('form')]; forms.forEach(form=>form.inert=true);
  document.querySelectorAll('button,#workspace-switch').forEach(el=>{disabled.set(el,el.disabled);el.disabled=true;});
  try{await fn();}catch(error){
    if(error.status===401){state.session=null;state.workspace=null;state.dirty=false;state.editor=null;await navigate('/login',true);}
    else { const target=$(errorSelector);if(target){target.innerHTML=error.code?errorBlock(error,true):notice(error.message,'error');target.scrollIntoView({block:'nearest'});}else toast(errorText(error)); }
  }finally{state.busy=false;forms.forEach(form=>form.inert=false);disabled.forEach((value,el)=>{if(el.isConnected)el.disabled=value;});}
}
async function saveDraft(event) {
  event.preventDefault();
  await mutation(async()=>{
    const input=getEditorInput();const current=state.editor.doc;
    const result=await request(current?`${base()}/documents/${current.doc_id}/versions`:`${base()}/documents`,{method:'POST',body:{...input,...(current?{expected_revision:current.revision}:{}),idempotency_key:nonce()}});
    const doc=result.document||result;state.dirty=false;toast(t('doc.saved'));await navigate(path(`edit/${doc.doc_id}`),true);
  });
}
async function publish() {
  if(state.dirty){toast('请先保存草稿，再发布。');return;}
  if(!await dialog('发布当前草稿？','<p>通过质检后，此版本将对当前工作区所有有阅读权限的成员可见。</p>'))return;
  await mutation(async()=>{const doc=state.editor.doc;await request(`${base()}/documents/${doc.doc_id}/publish`,{method:'POST',body:{version_id:doc.latest_draft_version_id,expected_revision:doc.revision,idempotency_key:nonce()}});toast(t('doc.published'));await navigate(path(`doc/${doc.doc_id}`),true);});
}
async function lifecycle(action) {
  if(state.dirty){toast('请先保存或放弃当前修改。');return;}
  if(!await dialog(action==='archive'?'归档文档？':'软删除文档？','<p>文档将退出普通检索与阅读。此版本没有恢复入口。</p>',[{label:'取消',value:false,primary:true},{label:'确认操作',value:true}]))return;
  await mutation(async()=>{const doc=state.editor.doc;await request(`${base()}/documents/${doc.doc_id}${action==='archive'?'/archive':''}`,{method:action==='archive'?'POST':'DELETE',body:{expected_revision:doc.revision,idempotency_key:nonce()}});toast(action==='archive'?'文档已归档。':'文档已软删除。');await navigate(path('manage'),true);});
}
async function versions() {
  try{const seq=state.sequence;const data=await listAll(`${base()}/documents/${state.editor.doc.doc_id}/versions`);if(!fresh(seq))return;$('#version-history').innerHTML=`<ol>${data.items.map(v=>`<li>版本 ${Number(v.version_no)} · ${esc(date(v.created_at))} · ${esc(v.quality_status)}</li>`).join('')}</ol>`;}catch(error){toast(errorText(error));}
}
async function dashboardPage(sequence) {
  const governance=allowed('dashboard.read.governance');const params=filterParams(false);params.set('view',governance?'governance':'published');
  const data=await request(`${base()}/dashboard?${params}`);if(!fresh(sequence))return;
  const g=data.governance;const stats=[['已发布文档',data.published_count,'当前授权范围内的发布版本'],...(g?[['待治理草稿',g.blocked_draft_count,'至少一项阻断规则未通过'],['未检查草稿',g.unchecked_draft_count,'尚无有效完整质检结果'],['检查失败草稿',g.error_draft_count,'质检执行发生错误']]:[])];
  const max=Math.max(1,...data.by_category.map(i=>i.count));
  content(`${heading('数据看板','了解知识沉淀情况，找到下一步整理方向。',button('刷新数据','retry'))}${scope(data)}${notice('发布统计沿用当前分类、标签与集合筛选，不包含检索关键词。')}
    <div class="stat-grid">${stats.map(([label,value,desc])=>`<article class="stat-card"><span class="stat-label">${label}</span><strong class="stat-value">${Number(value)}</strong><span class="muted">${desc}</span></article>`).join('')}</div><div class="dashboard-grid"><section class="panel"><div class="panel-heading"><h2>知识分类分布</h2><span class="badge neutral">发布版本</span></div>${data.by_category.length?`<div class="bar-chart" role="img" aria-label="${esc(data.by_category.map(i=>`${i.name} ${i.count}篇`).join('，'))}">${data.by_category.map(i=>`<div class="bar-row"><span>${esc(i.name||'未分类')}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(0,Math.min(100,i.count/max*100))}%"></div></div><strong>${Number(i.count)}</strong></div>`).join('')}</div>`:empty(t('dashboard.empty'))}</section><section class="panel"><h2>统计口径</h2><p>每篇文档按当前发布版本计一次。分类名称取发布时的快照。</p>${g?`<p>草稿按最新草稿快照筛选，共 ${g.draft_count} 篇；通过 ${g.passed_draft_count} 篇。草稿与发布统计不相加。</p><p class="muted">未运行规则：${esc(g.rules_not_run?.join('、')||'服务端未列出')}</p>`:'<p>当前身份仅可查看已发布内容的统计。</p>'}</section></div>
    <section class="panel"><h2>扩展指标</h2><div class="metric-unavailable"><p><strong>活跃贡献者</strong><span class="badge neutral">未接入</span></p><p><strong>搜索趋势</strong><span class="badge neutral">未接入</span></p>${g?'<p><strong>过期文档 · 缺失元数据</strong><span class="badge neutral">未接入独立计数</span></p>':''}</div><p class="muted">当前接口没有提供以上独立指标。统计窗口、过期阈值及聚合字段需由数据与后端负责人补充。</p></section>`,sequence);
}
async function membersPage(sequence) {
  if(!allowed('membership.invite')){content(notice(t('member.noPermission'),'error'));return;}
  const members=await listAll(`${base()}/members`);if(!fresh(sequence))return;
  content(`${heading('成员与角色','让合适的人，在清晰的权限边界内协作。')}${notice(t('member.ownerGuard'))}<div id="member-error"></div><div class="panel table-wrap"><table class="data-table"><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>管理</th></tr></thead><tbody>${members.items.map(m=>{
    const can= m.role!=='Owner' && (state.workspace.role==='Owner'||(state.workspace.role==='Admin'&&['Editor','Viewer'].includes(m.role)&&m.user_id!==state.session.user.user_id));
    return `<tr><td><strong>${esc(m.display_name)}</strong><small>${esc(m.masked_email||'')}</small></td><td><span class="badge role">${esc(m.role)}</span></td><td>${esc(m.status)}</td><td>${can?`${button('调整角色','member-role','small',`data-mid="${esc(m.membership_id)}"`)}${button(m.status==='active'?'停用':'启用','member-toggle','small',`data-mid="${esc(m.membership_id)}"`)}${button('移除','member-remove','danger small',`data-mid="${esc(m.membership_id)}"`)}`:'<span class="muted">受保护</span>'}</td></tr>`;
  }).join('')}</tbody></table></div><section class="panel"><h2>邀请成员</h2><form id="invite-form" class="inline-form"><label>邮箱<input name="email" type="email" required placeholder="name@company.com"></label><label>初始角色<select name="role">${(state.workspace.role==='Owner'?['Viewer','Editor','Admin']:['Viewer','Editor']).map(r=>`<option>${r}</option>`).join('')}</select></label><button class="button primary">创建邀请</button></form><p class="filter-note">成功响应仅表示创建邀请；邮件投递状态由后端确认。</p></section><section class="panel"><h2>所有权转移</h2><p>须由当前 Owner 重新认证，目标成员接受后再提交。</p><p class="muted">身份源与重新认证流程尚未配置，此预览不提供转移入口。</p></section>`,sequence);
  state.members=members.items;
  $('#invite-form').onsubmit=async event=>{event.preventDefault();const form=new FormData(event.target);await mutation(async()=>{const data=await request(`${base()}/invitations`,{method:'POST',body:{email:form.get('email'),role:form.get('role'),idempotency_key:nonce()}});toast(`邀请已创建；投递状态：${data.delivery_status||'未提供'}。`);event.target.reset();},'#member-error');};
}
async function memberAction(action,id) {
  const member=state.members.find(m=>m.membership_id===id);if(!member)return;
  const body={expected_revision:member.membership_revision,idempotency_key:nonce()};
  if(action==='member-role'){
    const roles=state.workspace.role==='Owner'?['Admin','Editor','Viewer']:['Editor','Viewer'];
    const choice=await dialog('调整成员角色',`<p>成员：${esc(member.display_name)}</p>`,[...roles.map(role=>({label:role,value:role})),{label:'取消',value:false}]);if(!choice)return;body.role=choice;
  }else{
    if(!await dialog('确认成员变更',`<p>${esc(member.display_name)}：${action==='member-remove'?'移除后将无法访问此工作区。':'改变状态会影响此工作区的访问权限。'}</p>`))return;
    if(action==='member-toggle')body.status=member.status==='active'?'disabled':'active';
  }
  await mutation(async()=>{await request(`${base()}/members/${id}`,{method:action==='member-remove'?'DELETE':'PATCH',body});toast('成员已更新。');await renderRoute();},'#member-error');
}
async function taxonomyPage(sequence) {
  const manage=allowed('tag.create');const dict=await dictionaries(manage?'manage':'published');if(!fresh(sequence))return;
  state.dict=dict;
  content(`${heading('标签与集合','用标签描述知识，用集合整理主题。集合不改变文档权限。')}<div id="taxonomy-error"></div><div class="dashboard-grid">${[['tags','标签',dict.tags,'tag.create'],['collections','集合',dict.collections,'collection.create']].map(([kind,label,items,cap])=>`<section class="panel"><h2>${label}</h2>${items.length?`<ul class="dictionary-list">${items.map(item=>`<li><span>${esc(item.name)} ${item.state==='retired'?'<span class="badge warning">已停用</span>':''}</span>${allowed(cap)?`<span>${button('改名','dictionary-rename','small',`data-kind="${kind}" data-id="${esc(item.id)}"`)}${button(item.state==='retired'?'启用':'停用','dictionary-retire','small',`data-kind="${kind}" data-id="${esc(item.id)}"`)}${button('删除','dictionary-delete','danger small',`data-kind="${kind}" data-id="${esc(item.id)}"`)}</span>`:''}</li>`).join('')}</ul>`:'<p class="muted">暂无可见条目</p>'}${allowed(cap)?`<form class="dictionary-form inline-form" data-kind="${kind}"><label>${label}名称<input name="name" required maxlength="80"></label><button class="button primary">新建${label}</button></form>`:''}</section>`).join('')}</div><section class="panel"><h2>分类</h2><div class="tag-list">${dict.categories.map(i=>`<span class="tag">${esc(i.name)}</span>`).join('')||'暂无有效分类'}</div><p class="muted">分类仅提供候选读取；当前契约未开放维护权限。</p></section>`,sequence);
  document.querySelectorAll('.dictionary-form').forEach(form=>{form.onsubmit=async event=>{event.preventDefault();await mutation(async()=>{await request(`${base()}/${form.dataset.kind}`,{method:'POST',body:{name:new FormData(form).get('name').trim(),idempotency_key:nonce()}});toast('条目已创建。');await renderRoute();},'#taxonomy-error');};});
}
async function dictionaryAction(action,kind,id) {
  const item=state.dict[kind].find(i=>i.id===id);if(!item)return;
  const body={expected_revision:item.revision,idempotency_key:nonce()};
  if(action==='dictionary-rename'){
    if(!await dialog('修改名称',`<label>新名称<input id="dictionary-new-name" maxlength="80" value="${esc(item.name)}"></label><p>已发布文档保留原名称快照。</p>`))return;
    body.name=$('#dictionary-new-name').value.trim();if(!body.name){toast('名称不能为空。');return;}
  }else if(action==='dictionary-retire')body.state=item.state==='retired'?'active':'retired';
  else if(!await dialog('删除条目？','<p>只有未被任何文档版本引用的条目才能删除。</p>'))return;
  await mutation(async()=>{await request(`${base()}/${kind}/${id}`,{method:action==='dictionary-delete'?'DELETE':'PATCH',body});toast('条目已更新。');await renderRoute();},'#taxonomy-error');
}
async function settingsPage(sequence) {
  content(`${heading('工作区设置','管理当前空间的基本信息与权限边界。')}<section class="panel"><h2>基本信息</h2><div id="settings-error"></div><form id="settings-form" class="form-grid"><label>工作区名称<input name="name" maxlength="100" required value="${esc(state.workspace.name)}" ${allowed('workspace.settings.update')?'':'disabled'}></label><label>当前角色<input value="${esc(state.workspace.role)}" readonly></label><div class="form-actions">${allowed('workspace.settings.update')?'<button class="button primary">保存设置</button>':'<p class="muted">只有 Owner 可以修改工作区设置。</p>'}</div></form></section><section class="panel"><h2>访问与内容边界</h2><p>文档在工作区内可见，发布后供有权成员阅读。责任人字段不授予访问权限。</p><p>Viewer 阅读发布内容；Editor 维护文档和标签；Admin 管理成员与集合；Owner 维护工作区并负责所有权。</p></section>`,sequence);
  $('#settings-form').onsubmit=async event=>{event.preventDefault();await mutation(async()=>{await request(base(),{method:'PATCH',body:{name:new FormData(event.target).get('name').trim(),expected_revision:state.workspace.revision,idempotency_key:nonce()}});toast('工作区设置已保存。');await renderRoute();},'#settings-error');};
}
document.addEventListener('click',async event=>{
  const nav=event.target.closest('[data-nav]');if(nav){event.preventDefault();resetCursor();await navigate(nav.dataset.nav);return;}
  const el=event.target.closest('[data-action]');if(!el||el.disabled)return;
  const action=el.dataset.action;
  if(['documents','manage','new','workspaces'].includes(action)){resetCursor();await navigate(action==='workspaces'?'/workspaces':path(action));}
  else if(action==='retry'){resetCursor();await renderRoute();}
  else if(action==='edit')await navigate(path(`edit/${el.dataset.id}`));
  else if(action==='publish')await publish();
  else if(action==='archive'||action==='delete-document')await lifecycle(action==='archive'?'archive':'delete');
  else if(action==='versions')await versions();
  else if(action==='clear-filters'){state.query='';state.category='';state.tags='';state.collection='';resetCursor();await renderRoute();}
  else if(action==='next'){state.cursorHistory.push(state.cursor);state.cursor=el.dataset.cursor;await renderRoute();}
  else if(action==='previous'){state.cursor=state.cursorHistory.pop()||null;await renderRoute();}
  else if(action==='logout'){
    if(!await leaveAllowed())return;
    await mutation(async()=>{await request('/auth/logout',{method:'POST',body:{}});state.session=null;state.workspace=null;state.workspaces=[];state.query='';state.category='';state.tags='';state.collection='';state.authMessage='';pendingIntents.clear();resetCursor();await navigate('/login',true);});
  }else if(action==='toggle-nav'){state.navOpen=!state.navOpen;$('.app-shell').classList.toggle('nav-open',state.navOpen);el.setAttribute('aria-expanded',String(state.navOpen));}
  else if(action==='help')await dialog('使用指南','<ol><li>登录后选择已加入的工作区。</li><li>输入关键词，按分类、标签或集合筛选发布文档。</li><li>编辑者创建草稿，完善标题、分类、责任人和正文。</li><li>保存草稿后发布；编辑过程中旧发布版本继续可读。</li><li>在看板查看当前授权范围的统计与质检状态。</li><li>管理员管理成员角色；所有权转移需要 Owner 操作。</li></ol>',[{label:'知道了',value:true,primary:true}]);
  else if(action==='simulate'){const code=$('#simulate-error').value;if(code){api.demo.failNext(code);toast(`已设置下一次响应：${code}`);}}
  else if(action.startsWith('member-'))await memberAction(action,el.dataset.mid);
  else if(action.startsWith('dictionary-'))await dictionaryAction(action,el.dataset.kind,el.dataset.id);
});
document.addEventListener('change',async event=>{
  if(event.target.id==='workspace-switch'){
    const wid=event.target.value; if(!await leaveAllowed()){event.target.value=state.workspace.workspace_id;return;}
    resetCursor(); await navigate(`/w/${wid}/${['search','documents','dashboard','taxonomy','settings'].includes(state.currentPage)?state.currentPage:'documents'}`,true);
  }
});
window.addEventListener('hashchange',renderRoute);
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='k'){event.preventDefault();const search=$('input[name=query]');if(search)search.focus();else if(state.workspace)navigate(path('search'));}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.navOpen&&!$('#dialog').open){state.navOpen=false;$('.app-shell')?.classList.remove('nav-open');const toggle=$('.mobile-nav-toggle');toggle?.setAttribute('aria-expanded','false');toggle?.focus();}});
initAccessibility();
renderRoute();

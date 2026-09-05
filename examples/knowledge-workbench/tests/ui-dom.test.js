// Actual application DOM execution. This does not measure layout or native browser focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { ApiClient, ApiError } from '../src/api.js';

const require=createRequire(import.meta.url);
const { JSDOM }=require('jsdom');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let serial=0;
async function until(predicate,label='DOM update') {
  for(let i=0;i<150;i++){if(predicate())return;await delay(10);}
  throw new Error(`Timeout: ${label}; body=${document.body.textContent.slice(-1800)}`);
}
async function setup(role='Owner') {
  const dom=new JSDOM(readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:4173/',pretendToBeVisual:true});
  for(const name of ['window','document','location','history','FormData','AbortController','HTMLElement','Element'])globalThis[name]=dom.window[name];
  dom.window.HTMLElement.prototype.scrollIntoView=function(){};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  await import(`${new URL('../src/app.js',import.meta.url).href}?test=${++serial}`);
  await until(()=>document.querySelector('#login-form'),'login');
  document.querySelector('#demo-role').value=role;
  submit('#login-form');
  await until(()=>document.querySelector('.workspace-card'),'workspace');
  click('.workspace-card');
  await until(()=>document.querySelector('.document-card'),'documents');
  return dom;
}
function click(selector){const el=document.querySelector(selector);assert.ok(el,`Missing ${selector}`);el.click();}
function submit(selector){const el=document.querySelector(selector);assert.ok(el);el.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
function input(selector,value){const el=document.querySelector(selector);assert.ok(el,selector);el.value=value;el.dispatchEvent(new window.Event('input',{bubbles:true}));}
function change(selector,value){const el=document.querySelector(selector);assert.ok(el,selector);el.value=value;el.dispatchEvent(new window.Event('change',{bubbles:true}));}
function text(){return document.querySelector('#app').textContent;}
async function readyHeading(value){await until(()=>document.querySelector('h1')?.textContent===value,value);}
function nav(page){click(`[data-nav$="/${page}"]`);}

test('actual UI: search workspace retention, documents create/save/conflict/publish, dashboard, members, dictionaries',async()=>{
  const dom=await setup();
  try{
    assert.match(text(),/演示模式/);
    assert.equal(document.querySelectorAll('.document-card').length,6);
    click('[data-action="next"]');await until(()=>document.querySelector('.pagination')?.textContent.includes('第 2 页'));
    assert.equal(document.querySelectorAll('.document-card').length,2);
    input('input[name=query]','入门');submit('#search-form');await until(()=>document.querySelector('.pagination')?.textContent.includes('第 1 页'));
    const firstWorkspace=document.querySelector('#workspace-switch').value;
    const second=document.querySelectorAll('#workspace-switch option')[1].value;
    change('#workspace-switch',second);await until(()=>location.hash.includes(second)&&document.querySelector('.breadcrumbs')?.textContent.includes('客户成功中心')&&document.querySelector('#search-form'));
    assert.equal(document.querySelector('input[name=query]').value,'入门');
    assert.equal(document.querySelector('[data-nav$="/manage"]'),null);
    change('#workspace-switch',firstWorkspace);await until(()=>document.querySelector('[data-nav$="/manage"]'));
    click('[data-action="new"]');await until(()=>document.querySelector('#editor-form'));
    input('[name=title]','DOM验收知识文档'); input('[name=content]','<img src=x onerror=alert(1)>知识沉淀正文。');
    document.querySelector('[name=category_id]').selectedIndex=1;
    document.querySelector('[name=owner_id]').selectedIndex=1;
    submit('#editor-form');await until(()=>location.hash.includes('/edit/')&&document.querySelector('[data-action="publish"]'),'save draft');
    assert.equal(document.querySelector('[name=title]').value,'DOM验收知识文档');
    input('[name=content]','冲突后必须保留的修改');
    change('#simulate-error','REVISION_CONFLICT');click('[data-action="simulate"]');submit('#editor-form');
    await until(()=>document.querySelector('#editor-error')?.textContent.includes('REVISION_CONFLICT'));
    assert.equal(document.querySelector('[name=content]').value,'冲突后必须保留的修改');
    assert.equal(document.querySelector('#dialog').open,false);
    nav('documents');await until(()=>document.querySelector('#dialog').open);
    click('[data-dialog="0"]');await delay(20);assert.ok(document.querySelector('#editor-form'),'stay preserves editor');
    submit('#editor-form');await until(()=>document.querySelector('#dirty-status')?.textContent==='正在编辑最新版本');
    click('[data-action="publish"]');await until(()=>document.querySelector('#dialog').open);click('[data-dialog="0"]');
    await readyHeading('DOM验收知识文档');assert.match(document.querySelector('.document-body').textContent,/冲突后必须保留/);
    nav('dashboard');await readyHeading('数据看板');assert.match(text(),/未接入/);assert.ok(document.querySelector('.stat-value'));
    nav('members');await readyHeading('成员与角色');assert.match(text(),/受保护/);
    const invite=document.querySelector('#invite-form');invite.querySelector('[name=email]').value='demo@example.com';submit('#invite-form');await until(()=>document.querySelector('#toast').textContent.includes('邀请已创建'));
    nav('taxonomy');await readyHeading('标签与集合');const form=document.querySelector('.dictionary-form');form.querySelector('input').value='验收标签';form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>text().includes('验收标签'));
    nav('settings');await readyHeading('工作区设置');assert.ok(document.querySelector('#settings-form button'));
  }finally{dom.window.close();}
});

test('actual UI: Viewer routes, 503 is not zero, 401 clears sensitive screen and skip link stays in route',async()=>{
  const dom=await setup('Viewer');
  try{
    assert.equal(document.querySelector('[data-action=new]'),null);
    assert.equal(document.querySelector('[data-nav$="/members"]'),null);
    const hash=location.hash;click('.skip-link');assert.equal(location.hash,hash);
    nav('dashboard');await readyHeading('数据看板');assert.doesNotMatch(text(),/待治理草稿|缺失元数据|检查失败草稿/);
    assert.equal(document.querySelectorAll('.stat-card').length,1);
    change('#simulate-error','SEARCH_UNAVAILABLE');click('[data-action="simulate"]');click('[data-action="retry"]');
    await until(()=>document.querySelector('.error-state'));assert.equal(document.querySelector('.stat-value'),null);
    assert.match(text(),/SEARCH_UNAVAILABLE/);
    // Reload the authorized workspace before injecting an expired session.
    click('[data-action="retry"]');await readyHeading('数据看板');
    change('#simulate-error','SESSION_INVALID');click('[data-action="simulate"]');click('[data-action="retry"]');
    await until(()=>document.querySelector('#login-form'));
    assert.equal(document.querySelector('.sidebar'),null);assert.equal(document.querySelector('.stat-card'),null);
    assert.match(text(),/登录已失效/);
  }finally{dom.window.close();}
});

test('actual UI: slow editor prerequisites, pending write navigation guard and explicit retry idempotency',async()=>{
  const original=ApiClient.prototype.request;
  let releaseMembers,releaseWrite,memberPending=false,writePending=false,failWrite=true;
  const writeKeys=[];
  ApiClient.prototype.request=async function(path,options={}) {
    if(path.includes('/members?')) {
      memberPending=true;await new Promise(resolve=>releaseMembers=resolve);
    }
    if(path.endsWith('/documents')&&options.method==='POST') {
      writeKeys.push(options.body.idempotency_key);
      if(failWrite){failWrite=false;writePending=true;await new Promise(resolve=>releaseWrite=resolve);throw new ApiError(503,'CONTENT_UNAVAILABLE','Unknown commit state');}
    }
    return original.call(this,path,options);
  };
  let dom;
  try{
    dom=await setup();click('[data-action="new"]');await until(()=>memberPending);
    assert.equal(document.querySelector('#editor-form'),null,'editor is not exposed before members arrive');
    releaseMembers();await until(()=>document.querySelector('#editor-form'));
    input('[name=title]','幂等请求验收');input('[name=content]','保存失败后显式重试。');
    document.querySelector('[name=category_id]').selectedIndex=1;document.querySelector('[name=owner_id]').selectedIndex=1;
    submit('#editor-form');await until(()=>writePending);
    const route=location.hash;location.hash='/workspaces';await delay(30);
    assert.equal(location.hash,route,'native hash navigation cannot abort pending write');
    releaseWrite();await until(()=>document.querySelector('#editor-error')?.textContent.includes('CONTENT_UNAVAILABLE'));
    assert.equal(document.querySelector('[name=title]').value,'幂等请求验收');
    // Avoid another controlled directory pause after successful retry.
    ApiClient.prototype.request=async function(path,options={}){if(path.endsWith('/documents')&&options.method==='POST')writeKeys.push(options.body.idempotency_key);return original.call(this,path,options);};
    submit('#editor-form');await until(()=>location.hash.includes('/edit/')&&document.querySelector('#editor-form'));
    assert.equal(writeKeys.length,2);assert.equal(writeKeys[0],writeKeys[1]);
  }finally{ApiClient.prototype.request=original;dom?.window.close();}
});

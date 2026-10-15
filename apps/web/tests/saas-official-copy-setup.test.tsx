import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OfficialCopySetup, createOfficialCopyDocument, readOfficialCopyModels } from '../src/saas/examples/OfficialCopySetup';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity, Tenant } from '../src/saas/api';

// A case without media nodes, so every node of its copy is an agent. The copy dialog is part of the case flow, which
// reads in English in both interface languages; these tests run in the Chinese interface.
const workflow = PRODUCTION_WORKFLOWS['pixel-platformer'];
const tenant: Tenant = { id: 'copy-workspace', name: 'Copy workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const identity: Identity = {user:{id:'copy-user',name:'Copy user',email:'copy@example.invalid',platformRole:'user'},tenants:[tenant]};
const catalog = {
  available:true,configured:true,plannerAvailable:true,
  runtimes:[{id:'pi',name:'Pi',available:true,configured:true,tools:[]}, {id:'openai-agents',name:'OpenAI Agents',available:true,configured:true,tools:[]}],
  models:[{id:'shared-model',name:'Catalog model',runtime:'pi'}, {id:'shared-model',label:'Python catalog model',runtime:'openai-agents',reasoningEfforts:['high']}],
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const key = (runtime = 'pi') => JSON.stringify([runtime,'shared-model']);
function server(runtime: () => Response | Promise<Response> = () => json(catalog)) {
  const posts: {url:string;body:any}[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/runtime')) return runtime();
    if (url.endsWith('/canvases') && init.method === 'POST') {
      const body = JSON.parse(init.body as string); posts.push({url,body});
      return json({id:'new-copy',document:body.document},201);
    }
    if (url.includes('/canvases?')) return json({items:[],nextCursor:null});
    throw new Error(`Unexpected endpoint: ${url}`);
  });
  vi.stubGlobal('fetch',fetcher);return {posts,fetcher};
}
function setup(props: Partial<React.ComponentProps<typeof OfficialCopySetup>> = {}) {
  const onConfirm=vi.fn(async()=>{}),onClose=vi.fn();
  render(<OfficialCopySetup item={workflow} tenantId={tenant.id} busy={false} onConfirm={onConfirm} onClose={onClose} {...props} />);
  return {onConfirm,onClose};
}
const chooser = () => screen.getByRole('combobox', {name:'Execution model'});
// The model both runtimes offer is listed once, on the runtime AwwO runs it on (openai-agents), without a runtime name.
const choose = async () => {await screen.findByRole('option',{name:'Python catalog model'});fireEvent.change(chooser(),{target:{value:key('openai-agents')}});};
beforeEach(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('superclaw_locale','zh');history.replaceState({},'','/');});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
beforeAll(async()=>{await import('../src/saas/ProductionShowcase');},300_000);

it('defaults to a clean draft even when a runtime and model are available, without any paid endpoint',async()=>{
  const {fetcher}=server(),{onConfirm}=setup();
  await screen.findByRole('option',{name:'Python catalog model'});
  expect(chooser()).toHaveValue('');
  expect(screen.queryByRole('option',{name:'Catalog model'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Create draft'}));
  await waitFor(()=>expect(onConfirm).toHaveBeenCalledExactlyOnceWith(null));
  expect(fetcher.mock.calls.every(([url,init])=>url==='/api/v1/tenants/copy-workspace/runtime' && !init.method)).toBe(true);
});

it('binds the explicit runtime/model pair to every newly minted node without changing source templates or clean exports',()=>{
  const source=JSON.stringify(workflow), original=createOfficialDocument(workflow);
  const result=createOfficialCopyDocument(workflow,{runtime:'pi',model:'shared-model',label:'ignored'});
  expect(result.nodes).toHaveLength(workflow.nodes.length);expect(result.edges).toHaveLength(workflow.edges.length);
  expect(result.nodes.every(node=>node.kind==='session'&&node.runtime==='pi'&&node.model==='shared-model'&&node.effort===''&&node.binding===null&&node.issueId===null&&!node.lastOutput)).toBe(true);
  expect(new Set(result.nodes.map(node=>node.id)).size).toBe(workflow.nodes.length);
  expect(result.nodes.some(node=>original.nodes.some(prior=>prior.id===node.id))).toBe(false);
  expect(JSON.stringify(workflow)).toBe(source);
  for(const doc of [original,createOfficialDocument(workflow),createOfficialCopyDocument(workflow,null)]) expect(doc.nodes.every(node=>node.kind==='session'&&node.model===''&&node.runtime===''&&node.binding===null)).toBe(true);
});

it('keeps a case’s image and video nodes on their own media models when agents get the chosen model',()=>{
  const studio=PRODUCTION_WORKFLOWS['aurora-gt'];
  const result=createOfficialCopyDocument(studio,{runtime:'openai-agents',model:'shared-model',label:'ignored'});
  const media=result.nodes.filter(node=>node.kind==='session'&&['image','video','model3d'].includes(node.agentKind));
  expect(media.map(node=>node.kind==='session'&&[node.agentKind,node.model,node.runtime])).toEqual(studio.media!.map(spec=>[spec.kind,spec.model,'']));
  expect(result.nodes.filter(node=>!media.includes(node)).every(node=>node.kind==='session'&&node.runtime==='openai-agents'&&node.model==='shared-model')).toBe(true);
});

it('rechecks the exact choice before copying, and does not infer effort from advertised levels',async()=>{
  const {fetcher}=server(),{onConfirm}=setup();await choose();
  expect(document.querySelector('.official-copy-selection span')).toHaveTextContent('Python catalog model');
  fireEvent.click(screen.getByRole('button',{name:'Copy with model'}));
  await waitFor(()=>expect(onConfirm).toHaveBeenCalledExactlyOnceWith({runtime:'openai-agents',model:'shared-model',label:'Python catalog model'}));
  // No effort picker beside the model, though the model advertises a level: the model chooser is the only one.
  expect(fetcher).toHaveBeenCalledTimes(2);expect(screen.getAllByRole('combobox')).toEqual([chooser()]);
});

it('refuses a stale model removed during confirmation and never creates a fallback draft',async()=>{
  let reads=0;server(()=>json(++reads===1?catalog:{...catalog,models:[]}));const {onConfirm}=setup();await choose();
  fireEvent.click(screen.getByRole('button',{name:'Copy with model'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('The selected model is unavailable');expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Copy with model'})).toBeDisabled();
  fireEvent.change(chooser(),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Create draft'}));
  await waitFor(()=>expect(onConfirm).toHaveBeenCalledExactlyOnceWith(null));
});

it('refuses a revalidation network error without creating a canvas',async()=>{
  let reads=0;server(()=>++reads===1?json(catalog):json({error:{code:'forbidden'}},403));const {onConfirm}=setup();await choose();
  fireEvent.click(screen.getByRole('button',{name:'Copy with model'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission for this action');expect(onConfirm).not.toHaveBeenCalled();
});

it('does not invent an engine from a malformed or unscoped catalog, but still permits an explicit draft',async()=>{
  server(()=>json({available:true,configured:true,models:[{id:'unscoped'}]}));const {onConfirm}=setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the model catalog');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Create draft'}));await waitFor(()=>expect(onConfirm).toHaveBeenCalledExactlyOnceWith(null));
});

it('rejects duplicate models while excluding unavailable runtimes and preserves IDs verbatim',async()=>{
  server(()=>json({...catalog,runtimes:catalog.runtimes.map(runtime=>({...runtime,available:runtime.id==='pi'}))}));
  expect(await readOfficialCopyModels(tenant.id)).toEqual([{runtime:'pi',model:'shared-model',label:'Catalog model'}]);
  // With both runtimes ready the model is offered once, on openai-agents.
  server();expect(await readOfficialCopyModels(tenant.id)).toEqual([{runtime:'openai-agents',model:'shared-model',label:'Python catalog model'}]);
  server(()=>json({...catalog,models:[...catalog.models,catalog.models[0]]}));await expect(readOfficialCopyModels(tenant.id)).rejects.toThrow('Invalid runtime model catalog');
});

it('locks duplicate confirmation and cancellation until model validation and creation finish',async()=>{
  let reads=0,release!:(value:Response)=>void,finish!:()=>void;
  server(()=>++reads===1?json(catalog):new Promise(resolve=>{release=resolve;}));
  const onConfirm=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),{onClose}=setup({onConfirm});await choose();
  const form=chooser().closest('form')!;fireEvent.submit(form);fireEvent.submit(form);
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(onClose).not.toHaveBeenCalled();expect(reads).toBe(2);
  await act(async()=>release(json(catalog)));expect(onConfirm).toHaveBeenCalledTimes(1);
  fireEvent.submit(form);expect(onConfirm).toHaveBeenCalledTimes(1);
  await act(async()=>finish());expect(screen.getByRole('button',{name:'Copy with model'})).toBeEnabled();
});

it('does not create anything when unmounted during the fresh catalog read',async()=>{
  let reads=0,release!:(value:Response)=>void;server(()=>++reads===1?json(catalog):new Promise(resolve=>{release=resolve;}));
  const {onConfirm}=setup();await choose();fireEvent.click(screen.getByRole('button',{name:'Copy with model'}));cleanup();
  await act(async()=>release(json(catalog)));expect(onConfirm).not.toHaveBeenCalled();
});

it('reads in English in the Chinese interface too, and refreshes a failed catalog without choosing its first model',async()=>{
  let reads=0;server(()=>++reads===1?json({},503):json(catalog));
  render(<SaaSPreferencesProvider><OfficialCopySetup item={workflow} tenantId={tenant.id} busy={false} onConfirm={vi.fn(async()=>{})} onClose={vi.fn()} /></SaaSPreferencesProvider>);
  const dialog=screen.getByRole('dialog',{name:'Copy example to my canvases'});
  expect(dialog).toBeVisible();expect(dialog).toHaveAttribute('lang','en');expect(document.documentElement.lang).toBe('zh-CN');
  expect(within(dialog).getByText(workflow.title)).toBeVisible();
  await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Refresh model catalog'}));
  await screen.findByRole('option',{name:'Python catalog model'});expect(chooser()).toHaveValue('');
  expect(screen.getByText(/does not initialize nodes or run models/)).toBeVisible();
});

it('creates and opens exactly one model-configured case copy through WorkspaceHome without planning or execution',async()=>{
  const {posts,fetcher}=server(),onOpen=vi.fn();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen}/></SaaSPreferencesProvider>);
  // The first row shows three cases; the pixel platformer is one click away. The cases, their dialog and the copy
  // dialog read in English in this Chinese interface.
  fireEvent.click(await screen.findByRole('button',{name:/^See all \d+ cases$/}));
  fireEvent.click(screen.getByRole('button',{name:'Pixel platformer'}));
  fireEvent.click(await within(screen.getByRole('dialog',{name:'Pixel platformer'})).findByRole('button',{name:'Copy this canvas'},{timeout:20000}));
  const setupDialog=screen.getByRole('dialog',{name:'Copy example to my canvases'});expect(posts).toHaveLength(0);await choose();
  fireEvent.click(within(setupDialog).getByRole('button',{name:'Copy with model'}));
  await waitFor(()=>expect(onOpen).toHaveBeenCalledExactlyOnceWith('new-copy'));
  expect(posts).toHaveLength(1);expect(posts[0].url).toBe('/api/v1/tenants/copy-workspace/canvases');expect(posts[0].body.name).toBe(workflow.title);
  expect(posts[0].body.document.nodes.every((node:any)=>node.runtime==='openai-agents'&&node.model==='shared-model'&&node.binding===null)).toBe(true);
  expect(fetcher.mock.calls.filter(([,init])=>init.method==='POST')).toHaveLength(1);
  expect(fetcher.mock.calls.some(([url])=>/initialize|graph-runs|\/runs|\/plan/.test(url))).toBe(false);
});

// Stateful acceptance against this worktree's dedicated local development database.
// The generated Acceptance workspaces remain visible so results can be inspected.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadLocalEnv } from './awwo-saas-lib.mjs';
const { env } = await loadLocalEnv();
const base = env.AWWO_API_TARGET + '/api/v1';
const suffix = Date.now().toString(36);
const fixturePassword = randomBytes(24).toString('base64url');
function client() {
  let cookie = '';
  return async (route, method = 'GET', body, expected = 200, extra = {}) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type':'application/json', Origin: env.AWWO_PUBLIC_ORIGIN, ...(cookie ? {Cookie:cookie} : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(15000) });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = response.status === 204 ? null : await response.json();
    assert.equal(response.status, expected, `${method} ${route}: expected ${expected}, got ${response.status} (${data?.error?.code || ''})`);
    return data;
  };
}
const anon = client(), alice = client(), bob = client(), admin = client();
await anon('/auth/me', 'GET', undefined, 401);
const a = await alice('/auth/register','POST',{email:`acceptance-a-${suffix}@example.invalid`,password:fixturePassword,name:'Acceptance Alice',tenantName:`Acceptance A ${suffix}`},201);
const b = await bob('/auth/register','POST',{email:`acceptance-b-${suffix}@example.invalid`,password:fixturePassword,name:'Acceptance Bob',tenantName:`Acceptance B ${suffix}`},201);
assert.equal(a.user.platformRole,'user');
const ta=a.tenants[0].id, tb=b.tenants[0].id;
await alice('/admin/summary','GET',undefined,403);
const document={version:2,updatedAt:Date.now(),nodes:[],edges:[],waypoints:[],view:null};
const c=await alice(`/tenants/${ta}/canvases`,'POST',{name:'Acceptance durable canvas',document},201);
await bob(`/tenants/${ta}/canvases/${c.id}`,'GET',undefined,404);
await bob(`/tenants/${tb}/canvases/${c.id}`,'GET',undefined,404);
const c2=await alice(`/tenants/${ta}/canvases/${c.id}`,'PUT',{name:c.name,document,version:c.version});
assert.equal(c2.version,c.version+1);
await alice(`/tenants/${ta}/canvases/${c.id}`,'PUT',{name:c.name,document,version:c.version},409);
await alice(`/tenants/${ta}/members`,'POST',{email:b.user.email,role:'reader'},201);
await bob(`/tenants/${ta}/canvases/${c.id}`);
await bob(`/tenants/${ta}/canvases/${c.id}`,'PUT',{name:c.name,document,version:c2.version},403);
await alice(`/tenants/${ta}/members/${b.user.id}`,'DELETE',undefined,204);
await bob(`/tenants/${ta}/canvases/${c.id}`,'GET',undefined,404);
await alice(`/tenants/${ta}/canvases`,'POST',{name:'Bad origin',document},403,{Origin:'https://untrusted.invalid'});
await admin('/auth/login','POST',{email:env.AWWO_BOOTSTRAP_ADMIN_EMAIL,password:env.AWWO_BOOTSTRAP_ADMIN_PASSWORD});
const summary=await admin('/admin/summary');
assert.ok(summary.tenantCount>=2);
await admin(`/admin/tenants/${ta}`,'PATCH',{status:'suspended'});
await alice(`/tenants/${ta}/canvases`,'POST',{name:'Suspended write',document},403);
await admin(`/admin/tenants/${ta}`,'PATCH',{status:'active'});
const runtime=await alice('/runtime');
assert.equal(runtime.engine,'pi');
await alice('/auth/logout','POST',undefined,204);
await alice('/auth/me','GET',undefined,401);
console.log(JSON.stringify({result:'passed',scope:'live Go/PostgreSQL API: authentication, persistence, tenant isolation, roles, CAS, Origin, admin suspension, logout',fixtureTenants:[ta,tb],modelInferenceTested:false,runtimeConfigured:runtime.configured},null,2));

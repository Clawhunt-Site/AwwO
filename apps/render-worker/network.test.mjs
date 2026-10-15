import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { allowedRequest, CDN_ORIGINS, hostResolverRules, NETWORK_GUARD_SCRIPT } from './network.mjs';
import { CHROME_ARGS, chromeArgs } from './render.mjs';

test('in-page URLs are allowed', () => {
  for (const url of ['data:text/plain,hi', 'data:image/png;base64,iVBORw0KGgo=', 'blob:null/0a1b2c', 'blob:https://unpkg.com/x', 'about:blank', 'about:srcdoc']) {
    assert.equal(allowedRequest(url), true, url);
  }
});

test('every allowlisted CDN is allowed over https on its default port', () => {
  for (const origin of CDN_ORIGINS) {
    assert.equal(allowedRequest(`${origin}/`), true, origin);
    assert.equal(allowedRequest(`${origin}/npm/three@0.170.0/build/three.module.js?x=1#y`), true, origin);
    assert.equal(allowedRequest(`${origin}:443/a.js`), true, `${origin}:443`);
    assert.equal(allowedRequest(origin.toUpperCase()), true, 'host names are case-insensitive');
  }
});

test('everything else is refused', () => {
  for (const url of [
    'http://cdn.jsdelivr.net/npm/x', 'https://cdn.jsdelivr.net.evil.test/npm/x', 'https://user@unpkg.com/x', 'https://user:pw@unpkg.com/x',
    'https://unpkg.com:8443/x', 'https://127.0.0.1/', 'https://127.0.0.1:8111/internal/renders', 'http://127.0.0.1:1/x', 'https://localhost/',
    'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://example.com/', 'https://evil.unpkg.com/x', 'https://unpkg.com./x',
    'wss://unpkg.com/socket', 'ws://127.0.0.1:8099/', 'ftp://unpkg.com/x', 'file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)',
    'not a url', '', undefined, null,
  ]) assert.equal(allowedRequest(url), false, String(url));
});

test('the allowlist is exactly the web preview LIVE_CDNS', () => {
  const source = readFileSync(new URL('../web/src/canvas/studio/liveDocument.ts', import.meta.url), 'utf8');
  const block = /LIVE_CDNS\s*=\s*\[([\s\S]*?)\]/.exec(source);
  assert.ok(block, 'LIVE_CDNS array found in liveDocument.ts');
  const origins = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(origins.length > 0);
  const allowlist = JSON.parse(readFileSync(new URL('./cdn-allowlist.json', import.meta.url), 'utf8'));
  assert.deepEqual(allowlist, origins);
  for (const origin of allowlist) assert.equal(new URL(origin).origin, origin, `${origin} is a bare origin`);
});

test('host resolver rules leave only the CDN hosts resolvable', () => {
  assert.equal(hostResolverRules(['https://a.example', 'https://b.example', 'https://a.example']), 'MAP * ~NOTFOUND, EXCLUDE a.example, EXCLUDE b.example');
  const rules = hostResolverRules();
  assert.ok(rules.startsWith('MAP * ~NOTFOUND, '));
  for (const origin of CDN_ORIGINS) assert.ok(rules.includes(`EXCLUDE ${new URL(origin).hostname}`), origin);
  const [first, ...excluded] = rules.split(', ');
  assert.equal(first, 'MAP * ~NOTFOUND');
  assert.equal(excluded.length, CDN_ORIGINS.length);
  for (const rule of excluded) assert.match(rule, /^EXCLUDE [a-z0-9.-]+$/);
});

test('the browser launches with the fixed flags, the resolver wall and no proxy', () => {
  const args = chromeArgs();
  assert.deepEqual(args.slice(0, CHROME_ARGS.length), ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-first-run',
    '--disable-background-networking', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb']);
  assert.deepEqual(args.slice(CHROME_ARGS.length), [`--host-resolver-rules=${hostResolverRules()}`, '--no-proxy-server',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);
});

test('the network guard removes WebRTC from a page', () => {
  const window = { RTCPeerConnection() {}, webkitRTCPeerConnection() {}, RTCDataChannel() {}, fetch() {} };
  window.window = window;
  vm.runInContext(NETWORK_GUARD_SCRIPT, vm.createContext(window));
  assert.equal(window.RTCPeerConnection, undefined);
  assert.equal(window.webkitRTCPeerConnection, undefined);
  assert.equal(window.RTCDataChannel, undefined);
  assert.equal(typeof window.fetch, 'function');
});

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Native fusion of the vendored Paperclip board UI (server/ui) into apps/web's
// build: the company surface mounts the real board (CompanyBoard.tsx) instead of
// an iframe. The board's source uses the `@/` alias for its own src and a `lexical`
// alias (matching server/ui/vite.config.ts); its npm deps resolve from server/'s
// node_modules (Vite resolves bare imports from the importing file's location).
const boardSrc = fileURLToPath(new URL('../../server/ui/src', import.meta.url));
const boardLexical = fileURLToPath(new URL('../../server/ui/node_modules/lexical/Lexical.mjs', import.meta.url));
// The board's MDX editor ships its toolbar/chrome CSS as `@mdxeditor/editor/style.css`.
// That dep lives in server/ui/node_modules (pnpm), so a bare specifier imported from
// apps/web's own tree (CompanyBoard.tsx) can't resolve it. Resolve the real file from
// the board's install and alias the exact specifier to it, so CompanyBoard can import
// `@mdxeditor/editor/style.css` and the embedded editor gets its full styling (matching
// server/ui/src/main.tsx). Resolved eagerly so a missing dep fails loudly at config time.
const boardRequire = createRequire(fileURLToPath(new URL('../../server/ui/package.json', import.meta.url)));
const boardMdxEditorStyleCss = boardRequire.resolve('@mdxeditor/editor/style.css');
// The board's API client (server/ui/src/api/client.ts) reads VITE_PAPERCLIP_API_BASE
// (default "/api" for standalone server/ui). When embedded in apps/web we point all
// of the board's same-origin /api calls at the Paperclip control plane via the
// /paperclip-api proxy, instead of apps/web's own Python backend on /api. Injected
// via `define` below so it is guaranteed regardless of how dev/build is invoked.
const paperclipApiBase = process.env.VITE_PAPERCLIP_API_BASE || '/paperclip-api';

// The Python backend serves everything that is NOT the chat surface or the board.
const apiTarget = process.env.VITE_SUPERCLAW_API_BASE_URL || process.env.SUPERCLAW_API_BASE_URL || 'http://127.0.0.1:8788';
// ONE vendored Node control plane (server/server) serves BOTH the embedded board
// (reached via the /paperclip-api prefix) AND the chat coexistence surface
// (/api/chat + composer inventory + skill suggestions). Same server, one port
// (default 3100, the server's own default) — env-overridable. `VITE_NODE_API_TARGET`
// and `VITE_PAPERCLIP_API_TARGET` are accepted aliases for the same target.
const nodeTarget = process.env.VITE_NODE_API_TARGET || process.env.VITE_PAPERCLIP_API_TARGET || 'http://127.0.0.1:3100';
const webHost = process.env.VITE_SUPERCLAW_WEB_HOST || '127.0.0.1';
const webPort = Number(process.env.VITE_SUPERCLAW_WEB_PORT || 5180);

// Node-owned route prefixes come from the SINGLE SOURCE OF TRUTH manifest
// (packages/superclaw/src/superclaw/node_routes.json), shared verbatim with the
// Python front door so dev and production/desktop can never drift. Listed BEFORE
// the catch-all '/api' so the longer, more specific prefixes win and route to
// Node; everything else falls through to Python. To add/remove a Node route, edit
// the JSON — never hardcode prefixes here.
const nodeRoutesManifest = JSON.parse(
  readFileSync(new URL('../../packages/superclaw/src/superclaw/node_routes.json', import.meta.url), 'utf8'),
);

// Python catch-alls a Node prefix may PRECEDE (e.g. /v1/skills under /v1) but never
// equal — mirrors node_routes.py's _PY_CATCHALLS.
const PY_CATCHALLS = ['/api', '/a2a', '/v1', '/health', '/.well-known'];

// Fail-closed structural validation, mirroring node_routes.py. Vite's JSON.parse +
// Object.fromEntries would otherwise SILENTLY mis-route bad data (a prefix without a
// leading slash makes a wrong key; a rewrite missing `from` builds /(?:)/ and mangles
// paths; a string "true" for `ws` reads as truthy). Throw at config load so a broken
// manifest fails the dev/preview build loudly instead of redirecting traffic.
function validateNodeRoutesManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.nodeRoutes)) {
    throw new Error('node_routes.json: missing or non-array "nodeRoutes"');
  }
  if (manifest.nodeRoutes.length === 0) {
    throw new Error('node_routes.json: "nodeRoutes" must not be empty');
  }
  const seen = new Set();
  for (const route of manifest.nodeRoutes) {
    if (!route || typeof route !== 'object') throw new Error('node_routes.json: each route must be an object');
    const { prefix, rewrite, ws, sse } = route;
    if (typeof prefix !== 'string' || !prefix.startsWith('/') || prefix === '/') {
      throw new Error(`node_routes.json: route "prefix" must be a non-root path starting with "/" (got ${JSON.stringify(prefix)})`);
    }
    if (seen.has(prefix)) throw new Error(`node_routes.json: duplicate prefix ${prefix}`);
    seen.add(prefix);
    if (PY_CATCHALLS.includes(prefix)) {
      throw new Error(`node_routes.json: prefix ${prefix} collides with a Python catch-all`);
    }
    if (ws !== undefined && typeof ws !== 'boolean') throw new Error(`node_routes.json: route ${prefix} "ws" must be a boolean`);
    if (route.match !== undefined && route.match !== 'prefix' && route.match !== 'exact') {
      throw new Error(`node_routes.json: route ${prefix} "match" must be "prefix" or "exact"`);
    }
    if (rewrite !== undefined) {
      if (!rewrite || typeof rewrite.from !== 'string' || typeof rewrite.to !== 'string' || !rewrite.from) {
        throw new Error(`node_routes.json: route ${prefix} "rewrite" must be {from, to} non-empty strings`);
      }
    }
    if (sse !== undefined) {
      if (!sse || typeof sse.method !== 'string' || typeof sse.path !== 'string' || !sse.method || !sse.path.startsWith('/')) {
        throw new Error(`node_routes.json: route ${prefix} "sse" must be {method, path} with path starting "/"`);
      }
    }
  }
}

validateNodeRoutesManifest(nodeRoutesManifest);

// Convert one manifest entry to a Vite proxy value. A plain prefix uses the bare
// string-target shorthand (changeOrigin defaults off — identical to the prior
// hardcoded entries); a prefix carrying a rewrite or WebSocket upgrade needs the
// object form with changeOrigin + ws + rewrite (matches the prior /paperclip-api).
function toViteProxyEntry(route) {
  if (!route.ws && !route.rewrite) return nodeTarget;
  const entry = { target: nodeTarget, changeOrigin: true };
  if (route.ws) entry.ws = true;
  if (route.rewrite) {
    const re = new RegExp(route.rewrite.from);
    entry.rewrite = (p) => p.replace(re, route.rewrite.to);
  }
  return entry;
}

// Vite treats a proxy key starting with '^' as a RegExp. An `exact` route becomes
// `^<prefix>$` so it matches ONLY that path (sub-paths fall through to Python),
// mirroring node_front_door.py's exact matcher; a `prefix` route keeps the plain
// string key (path-prefix match).
function viteProxyKey(route) {
  return route.match === 'exact' ? `^${route.prefix}$` : route.prefix;
}

const nodeOwnedProxy = Object.fromEntries(
  nodeRoutesManifest.nodeRoutes.map((route) => [viteProxyKey(route), toViteProxyEntry(route)]),
);

const vendorChunkGroups = [
  {
    name: 'vendor-react',
    test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
    priority: 40,
  },
  {
    name: 'vendor-markdown',
    test: /node_modules[\\/](react-markdown|remark-gfm|remark-parse|remark-rehype|unified|micromark|mdast-util-|hast-util-|unist-util-|vfile|bail|trough|zwitch|decode-named-character-reference|devlop|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|trim-lines|ccount|extend|is-plain-obj|character-entities)/,
    priority: 30,
  },
  {
    name: 'vendor-icons',
    test: /node_modules[\\/]lucide-react[\\/]/,
    priority: 20,
  },
  {
    name: 'vendor',
    test: /node_modules[\\/]/,
    priority: 10,
  },
];

// Shared by the dev server and `vite preview` (production bundle) so both reach the
// backends the same way. The board's /paperclip-api and the chat surface's
// /api/chat both target the SAME Node control plane (server/server); everything
// else falls through to Python. Order matters: the Node-owned prefixes (from the
// manifest, including /paperclip-api and the longer /api/<chat> + /v1/skills) are
// spread BEFORE the '/api' and '/v1' catch-alls so they win.
//
// NOTE: this proxyConfig only covers `vite dev` + `vite preview`. Any PRODUCTION/
// desktop host of apps/web's static bundle must forward the same Node-owned
// prefixes to the Node control plane — that is exactly what the Python front door
// does, driven by the SAME node_routes.json manifest. Inherent coexist requirement.
// The chat-automation control plane (apps/gateway, the v4 "会话即定时任务" ticker host).
// Reached at /gateway-api, rewritten to /api on the gateway. The gateway requires a control
// token + loopback origin; the proxy injects the token server-side (read from
// ~/.superclaw/gateway-control-token, which the Node gateway owns/creates) so the browser never
// holds the secret. Mirrors what node_front_door.py does for the packaged front door.
// Single source for the gateway port = the proxy target. The launcher's spawn env is parsed
// FROM the resolved target, so the gateway always binds exactly where /gateway-api forwards —
// even if VITE_GATEWAY_API_TARGET is overridden, the two can never diverge. 8796 is a dedicated
// default that does NOT collide with the Python service (8788) or the upstream Node (3100).
const gatewayTarget =
  process.env.VITE_GATEWAY_API_TARGET || `http://127.0.0.1:${(process.env.VITE_GATEWAY_PORT || '8796').trim()}`;
const gatewayPort = new URL(gatewayTarget).port || '8796';
function readGatewayControlToken() {
  // Mirror the gateway's own token resolution order (index.ts resolveControlToken): an explicit
  // env token wins, else the persisted file — so an env-token gateway gets the matching header
  // rather than a stale/empty one (which would 401).
  const fromEnv = (process.env.SUPERCLAW_GATEWAY_CONTROL_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const home = (process.env.SUPERCLAW_HOME || '').trim() || join(homedir(), '.superclaw');
    return readFileSync(join(home, 'gateway-control-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const gatewayProxy = {
  target: gatewayTarget,
  changeOrigin: true,
  rewrite: (p) => p.replace(/^\/gateway-api/, '/api'),
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      const token = readGatewayControlToken();
      if (token) proxyReq.setHeader('x-superclaw-gateway-token', token);
    });
  },
};

const proxyConfig = {
  ...nodeOwnedProxy,
  '/gateway-api': gatewayProxy,
  '/api': apiTarget,
  '/a2a': apiTarget,
  '/v1': apiTarget,
  '/health': apiTarget,
  '/.well-known': apiTarget,
};

// Co-launch the Node gateway (chat-automation ticker host) alongside `vite dev` — Node-native,
// no Python. The gateway self-discovers the upstream (its run-dir marker), owns its control
// token, and reaps its own stale orphan; this plugin only spawns it (detached, so its tsx child
// is reaped with the group) and kills it on dev-server close. Fail-soft: a non-runnable gateway
// just disables chat automations in dev, never breaks the dev server. (Packaged desktop launches
// the gateway through its own Node runtime — not this dev-only plugin.)
function gatewayLauncherPlugin() {
  const gatewayDir = fileURLToPath(new URL('../gateway', import.meta.url));
  let child = null;
  const kill = () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // group already gone
      }
      child = null;
    }
  };
  return {
    name: 'superclaw-gateway-launcher',
    apply: 'serve', // dev only — never affects `vite build`
    configureServer(server) {
      if ((process.env.SUPERCLAW_GATEWAY_SIDECAR || '').trim().toLowerCase() === 'off') return;
      const tsxBin = join(gatewayDir, 'node_modules', '.bin', 'tsx');
      const entry = join(gatewayDir, 'src', 'index.ts');
      if (!existsSync(tsxBin) || !existsSync(entry)) {
        server.config.logger.warn(
          '[superclaw-gateway] not runnable (no tsx/entry under apps/gateway); chat automations disabled in dev',
        );
        return;
      }
      // Pin the gateway's listen port to the SAME value the proxy targets, so it binds exactly
      // where /gateway-api forwards (overriding the gateway's own default, which mirrors the
      // Python front-door port and would collide).
      const env = { ...process.env, SUPERCLAW_GATEWAY_PORT: gatewayPort };
      child = spawn(tsxBin, [entry], { cwd: gatewayDir, env, stdio: 'inherit', detached: true });
      // spawn() reports launch failure ASYNCHRONOUSLY via an 'error' event, not by throwing. A
      // ChildProcess with no 'error' listener re-emits it as an uncaught exception that kills the
      // whole dev server — which would defeat this plugin's fail-soft contract. This happens on
      // Windows even though existsSync(tsxBin) passed above: the extension-less pnpm `.bin/tsx`
      // shim exists but isn't a runnable Windows executable, so spawn throws ENOENT. Degrade to the
      // same "chat automations disabled in dev" warning as the existsSync guard instead of crashing.
      child.on('error', (err) => {
        server.config.logger.warn(
          `[superclaw-gateway] failed to spawn (${err.code ?? err.message}); chat automations disabled in dev`,
        );
        child = null;
      });
      child.on('exit', (code) => {
        if (code) server.config.logger.warn(`[superclaw-gateway] exited (code=${code})`);
        child = null;
      });
      server.httpServer?.once('close', kill);
      process.once('exit', kill);
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.once(sig, () => {
          kill();
          process.exit(0);
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), gatewayLauncherPlugin()],
  define: {
    // Bare-identifier define (most reliable replacement target — unlike
    // `import.meta.env.X`, it is substituted even inside casts/optional chains).
    // The board (server/ui) reads __PAPERCLIP_API_BASE__ via a typeof guard so it
    // falls back to "/api" when built standalone (where this define is absent).
    __PAPERCLIP_API_BASE__: JSON.stringify(paperclipApiBase),
  },
  resolve: {
    // The board's `@/*` imports resolve to its own source tree; `lexical` is pinned
    // to the board's copy (matching server/ui/vite.config.ts) so the MDX editor's
    // singleton check holds.
    alias: [
      { find: '@', replacement: boardSrc },
      { find: 'lexical', replacement: boardLexical },
      // Exact-specifier alias so apps/web can import the board's MDX editor CSS.
      { find: '@mdxeditor/editor/style.css', replacement: boardMdxEditorStyleCss },
    ],
    // Single instance of the shared runtime libs so the board (compiled from
    // server/ui/src) and apps/web don't load two Reacts / Routers / query clients.
    dedupe: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: vendorChunkGroups,
        },
      },
    },
  },
  css: {
    postcss: {
      plugins: [],
    },
  },
  server: {
    host: webHost,
    port: webPort,
    // Pre-transform the embedded board's module graph on dev-server start (in the
    // background) so the first Team-open doesn't pay Vite's on-demand compile.
    warmup: { clientFiles: ['./src/CompanyBoard.tsx'] },
    proxy: proxyConfig,
  },
  // `vite preview` serves the production bundle; it needs the same proxy.
  preview: {
    host: webHost,
    proxy: proxyConfig,
  },
});

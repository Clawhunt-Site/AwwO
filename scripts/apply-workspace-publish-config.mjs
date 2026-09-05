// Resolve a vendored pnpm workspace to its BUILT output for a production container.
//
// Why this exists: every @paperclipai/* workspace package exposes DEV entry points
//   "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }
// and keeps its PRODUCTION entry points in `publishConfig`
//   "publishConfig": { "exports": { ".": { "import": "./dist/index.js" } }, "main": "./dist/index.js" }
// pnpm only applies publishConfig on `publish`/`deploy`. Our image copies the RAW workspace, so
// `node dist/index.js` resolved @paperclipai/db to its TypeScript SOURCE; Node 22 strips types and
// then dies on the source's own `./client.js` specifier:
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/db/src/client.js'
//     imported from .../packages/db/src/index.ts
// Applying each package's OWN publishConfig in place (after the build, inside the image) makes every
// workspace dep resolve to its built JS — the same mapping pnpm would apply on publish.
//
// Build-time only: this rewrites package.json files INSIDE the container image; the vendored server/
// tree in the repo is never touched (the vendoring iron rule is not triggered).
//
// Fail-closed: exits non-zero if it patches nothing, so a silent no-op can never ship a broken image.

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error(`apply-workspace-publish-config: workspace root not found: ${root}`);
  process.exit(1);
}

// Keys whose production values live in publishConfig. `exports` is the one that actually decides
// module resolution; the others keep tooling consistent.
const KEYS = ['exports', 'main', 'module', 'types', 'typings', 'bin'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'src', 'test', 'tests']);

const patched = [];

function walk(dir, depth) {
  if (depth > 5) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, depth + 1);
    } else if (entry.name === 'package.json') {
      applyTo(full);
    }
  }
}

function applyTo(pkgPath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return; // not our problem — a malformed/exotic package.json is left alone
  }
  const pc = pkg.publishConfig;
  if (!pc || (!pc.exports && !pc.main)) return;
  let changed = false;
  for (const key of KEYS) {
    if (pc[key] !== undefined) {
      pkg[key] = pc[key];
      changed = true;
    }
  }
  if (!changed) return;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  patched.push(pkg.name ?? path.relative(root, pkgPath));
}

walk(root, 0);

for (const name of patched) console.log(`  publishConfig applied -> ${name}`);
console.log(`apply-workspace-publish-config: patched ${patched.length} workspace package(s) under ${root}`);

if (patched.length === 0) {
  console.error(
    'apply-workspace-publish-config: patched NOTHING — the workspace layout changed or publishConfig ' +
      'is gone. Refusing to build an image whose control plane would resolve to TypeScript source.',
  );
  process.exit(1);
}

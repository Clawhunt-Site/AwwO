// `npm run licences:saas`: a full hosted build (vite.saas.config.mjs, nothing written to dist-saas) whose
// license plugin writes src/saas/bundleLicences.txt from what the bundle ships (scripts/bundle-licences.mjs).
// Read the file's diff before you commit it: every license in it ships with the site.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { COMMITTED, WRITE } from './bundle-licences.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The release's bundle: Vite keeps a NODE_ENV the shell set, and a development one bundles other files.
process.env.NODE_ENV = 'production';
globalThis[WRITE] = true;
await build({ root, configFile: join(root, 'vite.saas.config.mjs'), configLoader: 'runner', mode: 'production', logLevel: 'warn', build: { write: false } });
console.log(`Wrote ${COMMITTED}; read its diff before you commit it.`);

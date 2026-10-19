#!/usr/bin/env node
// A build step of the workspace image (deploy/saas/workspace/Dockerfile), run once after npm ci: keeps of the three.js
// package only what awwo-check-page answers, the files AwwO's running preview supplies (three-preview-files.json, which
// scripts/preview-modules.mjs writes with the preview's own list), and the package's LICENSE and package.json. The rest
// (sources, other builds, libraries the preview does not supply) goes, so the image holds the same three.js files as
// the web app ships: build/three.module.js, build/three.core.js and examples/jsm/utils/GeometryUtils.js without the
// code three.js took from Shadertoy, Stack Overflow and OpenProcessing, cut out as the web app's builds do it
// (three-cuts.mjs, the copy of apps/web/scripts/three-cuts.mjs that scripts/preview-modules.mjs writes here). Fails, and
// so fails the build, when a listed file is missing or differs from the list's sha256, when the installed version is
// not the list's, when a cut does not find what it cuts, or when a listed file credits a source of code under CC BY-SA
// (Stack Exchange, OpenProcessing) but for the references three-cuts.mjs knows.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUT_FILES, shareAlikeLink, shippedText } from './three-cuts.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const list = JSON.parse(readFileSync(path.join(TOOLS, 'three-preview-files.json'), 'utf8'));
const root = path.join(TOOLS, 'node_modules', list.package);
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (version !== list.version) throw new Error(`${list.package} ${version} is installed; the preview's list is for ${list.version}`);
// A listed file the builds cut code out of is cut the same way first; its sha256 in the list is the cut file's.
const cut = CUT_FILES.filter(entry => entry.pkg === list.package && Object.hasOwn(list.files, entry.file));
for (const entry of cut) writeFileSync(path.join(root, entry.file), shippedText(path.join(root, entry.file)));
for (const [file, sha256] of Object.entries(list.files)) {
  const stats = lstatSync(path.join(root, file), { throwIfNoEntry: false });
  if (!stats?.isFile()) throw new Error(`${list.package} ${version} has no file ${file}`);
  if (createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') !== sha256) throw new Error(`${file} is not the file the preview supplies`);
  const link = shareAlikeLink(readFileSync(path.join(root, file), 'utf8'));
  if (link) throw new Error(`${file} credits ${link}, where code is under CC BY-SA: the image keeps none such`);
}
const keep = new Set(['LICENSE', 'package.json', ...Object.keys(list.files)]);
let removed = 0;
const prune = relative => {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      prune(name);
      if (!readdirSync(path.join(root, name)).length) rmdirSync(path.join(root, name));
    } else if (!keep.has(name)) {
      rmSync(path.join(root, name));
      removed += 1;
    }
  }
};
prune('');
console.log(`${list.package} ${version}: kept ${keep.size} files (the ${Object.keys(list.files).length} the preview supplies, LICENSE, package.json), removed ${removed}; `
  + `made the cuts of three-cuts.mjs in ${cut.map(entry => entry.file).join(', ') || 'no file'}`);

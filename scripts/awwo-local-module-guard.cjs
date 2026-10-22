// Loaded first in each Node.js service of AwwO 本地版, and in the Node.js programs they start (withModuleGuard in
// awwo-local-lib.mjs; the workers' moduleGuardOptions): Node.js loads no module whose real path is outside AwwO's own
// folders, the code, the build and the data folder, which are this account's alone. Node.js looks for a package in
// every folder above the one asking, up to the drive's root; a package's optional dependency that is absent (the
// coding agent's clipboard, ws's bufferutil) is looked for there too, and any account on the computer can make
// C:\node_modules. Without this, code put there by another account would run inside a service that holds this
// account's keys. Nothing AwwO runs loads code from anywhere else, so the rule needs no exception: however a module was
// reached (a package's folder above AwwO's, a junction there leading elsewhere, a package.json whose main points out, a
// package's imports map, a self-reference), only where its file really is counts.
//
// AWWO_LOCAL_MODULE_ROOTS names the folders as a JSON array, so a folder may hold any character a path takes (";"
// among them); one it cannot read stops the process. Node.js without module.registerHooks (before 22.15) leaves it
// undone: a program a service starts may run on another Node.js.
'use strict';
const { realpathSync } = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { registerHooks } = require('node:module');

// Folders and files compared by their real paths in long names: Node.js may name a file by a short name
// (C:\Users\ADMINI~1, as %TEMP% often is), and a junction's own path is not where its files are.
const real = file => { try { return realpathSync.native(file); } catch { return path.resolve(file); } };
const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
const inside = (file, folder) => fold(file) === fold(folder) || fold(file).startsWith(fold(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`));

function readRoots(value) {
  if (!value) return [];
  let roots;
  try { roots = JSON.parse(value); } catch { roots = null; }
  // Set by the runtime: anything else is its mistake, and the service had better not start than start unguarded.
  if (!Array.isArray(roots) || !roots.length || !roots.every(root => typeof root === 'string' && path.isAbsolute(root))) {
    throw new Error('AWWO_LOCAL_MODULE_ROOTS must be a JSON array of absolute folders');
  }
  return roots.map(real);
}
const roots = readRoots(process.env.AWWO_LOCAL_MODULE_ROOTS);

if (roots.length && typeof registerHooks === 'function') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (typeof result?.url === 'string' && result.url.startsWith('file:')) {
        const file = real(fileURLToPath(result.url));
        if (!roots.some(root => inside(file, root))) {
          const error = new Error(`Cannot find module '${specifier}': AwwO loads no module from outside its own folders (${file})`);
          error.code = 'MODULE_NOT_FOUND';
          throw error;
        }
      }
      return result;
    },
  });
}

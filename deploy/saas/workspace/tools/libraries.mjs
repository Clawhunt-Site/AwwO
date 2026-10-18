// awwo-check-page's library files: the files AwwO's running preview supplies to a page that loads them from a CDN, as a
// three.js page does through an import map (three-preview-files.json, which scripts/preview-modules.mjs writes with the
// preview's own list; the image keeps only those files of the package), and which request URL names which of them, read
// as the preview's pinnedModuleFile reads one (apps/web/src/canvas/previewModules.ts): at the addresses below, with the
// path as written (not decoded), a .min.js naming the same file.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// jsDelivr's three host names under /npm/, and unpkg's root; https on the default port only.
export const CDN_PREFIXES = new Map([['cdn.jsdelivr.net', '/npm/'], ['fastly.jsdelivr.net', '/npm/'], ['gcore.jsdelivr.net', '/npm/'], ['unpkg.com', '/']]);
const CDN_PATH = /^(@?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+)\/(.+)$/;

/** The listed libraries of a tools directory by name ({ name, version, files, root }): none when the list is missing or
 * unreadable, or the installed package is not the list's version, so the check then answers nothing. */
export function loadLibraries(tools) {
  try {
    const list = JSON.parse(readFileSync(path.join(tools, 'three-preview-files.json'), 'utf8'));
    const root = path.join(tools, 'node_modules', list.package);
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (version !== list.version) return new Map();
    return new Map([[list.package, { name: list.package, version, files: new Set(Object.keys(list.files)), root }]]);
  } catch { return new Map(); }
}

/** What a request URL (a URL object) names: null when it is no listed library at its version and a known address;
 * otherwise { library, file }, with file '' when the URL names a file of that release the preview does not supply. */
export function libraryFile(url, libraries) {
  const prefix = url.protocol === 'https:' && url.port === '' ? CDN_PREFIXES.get(url.hostname) : undefined;
  const match = prefix && url.pathname.startsWith(prefix) ? CDN_PATH.exec(url.pathname.slice(prefix.length)) : null;
  const library = match ? libraries.get(match[1]) : undefined;
  if (!library || library.version !== match[2]) return null;
  const name = match[3], unminified = name.replace(/\.min\.js$/, '.js');
  return { library, file: library.files.has(name) ? name : library.files.has(unminified) ? unminified : '' };
}

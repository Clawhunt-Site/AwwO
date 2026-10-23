// What the Mac app's payload is checked for in its programs and libraries (Mach-O files), read from their headers on
// any system: which machines each holds code for, the libraries it loads and its run paths, and whether it carries a
// code signature. scripts/awwo-local-package-macos.mjs uses it to refuse a payload whose programs would not load on a
// Mac: a library named that is not there, a machine missing, a link that leads out of its folder.
import { closeSync, openSync, readSync, readdirSync, lstatSync, readlinkSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
/** The machines (CPU types) the payload's code may be for. */
export const CPU_TYPES = Object.freeze({ 0x01000007: 'x86_64', 0x0100000c: 'arm64' });
// The load commands read: a library loaded (plain, re-exported, upward, lazily; a weak one may be missing, and its
// program runs without it), its own name, a run path and the code signature.
const LOAD_DYLIB = new Set([0xc, 0x8000001f, 0x80000023, 0x20]);
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_ID_DYLIB = 0xd;
const LC_RPATH = 0x8000001c;
const LC_CODE_SIGNATURE = 0x1d;

function cString(buffer, at) {
  const end = buffer.indexOf(0, at);
  return buffer.toString('utf8', at, end < 0 ? buffer.length : end);
}

/** One machine's code of a Mach-O file: its CPU, file type, own install name, the libraries it loads, its run paths and
 *  whether it carries a code signature; null for bytes that are not a 64-bit Mach-O. */
export function thinMachO(buffer) {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== MH_MAGIC_64) return null;
  const cpu = CPU_TYPES[buffer.readUInt32LE(4)] || `cpu-${buffer.readUInt32LE(4).toString(16)}`;
  const facts = { cpu, filetype: buffer.readUInt32LE(12), id: null, libraries: [], weak: [], rpaths: [], signed: false };
  let at = 32;
  for (let index = 0, count = buffer.readUInt32LE(16); index < count; index += 1) {
    if (at + 8 > buffer.length) throw new Error('a load command runs past the end of the file');
    const command = buffer.readUInt32LE(at);
    const size = buffer.readUInt32LE(at + 4);
    if (size < 8 || at + size > buffer.length) throw new Error('a load command does not fit the file');
    if (LOAD_DYLIB.has(command)) facts.libraries.push(cString(buffer, at + buffer.readUInt32LE(at + 8)));
    else if (command === LC_LOAD_WEAK_DYLIB) facts.weak.push(cString(buffer, at + buffer.readUInt32LE(at + 8)));
    else if (command === LC_ID_DYLIB) facts.id = cString(buffer, at + buffer.readUInt32LE(at + 8));
    else if (command === LC_RPATH) facts.rpaths.push(cString(buffer, at + buffer.readUInt32LE(at + 8)));
    else if (command === LC_CODE_SIGNATURE) facts.signed = buffer.readUInt32LE(at + 12) > 0;
    at += size;
  }
  return facts;
}

/** A universal file's number of machines, or 0: a Java class file starts with the same bytes, then its version (45 or
 *  more), where a universal file has a handful of machines. */
function fatCount(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== FAT_MAGIC) return 0;
  const count = buffer.readUInt32BE(4);
  return count >= 1 && count <= 16 && 8 + count * 20 <= buffer.length ? count : 0;
}

/** A Mach-O file's machines (a universal one has several), each as thinMachO reads it; null for a file that is none. */
export function machO(buffer) {
  const count = fatCount(buffer);
  if (count) {
    const slices = [];
    for (let index = 0; index < count; index += 1) {
      const entry = 8 + index * 20;
      const offset = buffer.readUInt32BE(entry + 8);
      const size = buffer.readUInt32BE(entry + 12);
      if (offset + size > buffer.length) throw new Error('a machine\'s code runs past the end of the file');
      const slice = thinMachO(buffer.subarray(offset, offset + size));
      if (slice) slices.push(slice);
    }
    return slices.length ? slices : null;
  }
  const thin = thinMachO(buffer);
  return thin ? [thin] : null;
}

/** The first bytes of a file, to tell a Mach-O from anything else without reading it whole. */
function startsAsMachO(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(8);
    if (readSync(fd, head, 0, 8, 0) < 8) return false;
    return head.readUInt32LE(0) === MH_MAGIC_64 || (head.readUInt32BE(0) === FAT_MAGIC && head.readUInt32BE(4) >= 1 && head.readUInt32BE(4) <= 16);
  } finally {
    closeSync(fd);
  }
}

/** Where a library a Mach-O names is, from its folder (@loader_path), its program's (@executable_path) or its run paths
 *  (@rpath, each as its own @loader_path); a system library (/usr/lib, /System) is the system's own, and any other
 *  absolute path is outside the payload. */
export function libraryCandidates(name, { loader, executable = loader, rpaths = [] }) {
  if (name.startsWith('/usr/lib/') || name.startsWith('/System/')) return 'system';
  const at = (prefix, base) => path.join(base, ...name.slice(prefix.length).split('/'));
  if (name.startsWith('@loader_path/')) return [at('@loader_path/', loader)];
  if (name.startsWith('@executable_path/')) return [at('@executable_path/', executable)];
  if (name.startsWith('@rpath/')) {
    return rpaths.map(rpath => {
      const base = rpath.startsWith('@loader_path') ? path.join(loader, ...rpath.slice('@loader_path'.length).split('/').filter(Boolean))
        : rpath.startsWith('@executable_path') ? path.join(executable, ...rpath.slice('@executable_path'.length).split('/').filter(Boolean)) : null;
      return base && path.join(base, ...name.slice('@rpath/'.length).split('/'));
    }).filter(Boolean);
  }
  return [];
}

/** One file as a Mach-O ({ file, slices }), the error that keeps it from being read as one ({ file, error }), or null for
 *  a file that is not one. */
export function machOOf(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.size < 32 || !startsAsMachO(file)) return null;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(info.size);
    readSync(fd, buffer, 0, info.size, 0);
    const slices = machO(buffer);
    return slices ? { file, slices } : null;
  } catch (error) {
    return { file, error: error.message };
  } finally {
    closeSync(fd);
  }
}

/** Every Mach-O file below a folder, as machOOf reads it; links are not followed. */
export function machOFiles(root) {
  const found = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (lstatSync(file).isDirectory()) { walk(file); continue; }
      const item = machOOf(file);
      if (item) found.push(item);
    }
  };
  walk(root);
  return found;
}

/** The links below a folder ({ file, target }). */
export function linksBelow(root) {
  const links = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const info = lstatSync(file);
      if (info.isSymbolicLink()) links.push({ file, target: readlinkSync(file) });
      else if (info.isDirectory()) walk(file);
    }
  };
  walk(root);
  return links;
}

/**
 * What of a payload's Mach-O files would not load on a Mac of `machine` (arm64): a library one names that is not in the
 * payload (through @loader_path, @executable_path or @rpath) nor the system's; a file that cannot be read as one; a
 * link that leads out of its own folder or to nothing. A file without code for the machine is never loaded there (a
 * package's build for Intel Macs beside the Apple silicon one), as the Windows payload's check skips another machine's
 * code: that the payload's own programs have code for it is checked by name (withoutCode). `executableOf(file)` is the
 * folder of the program that loads a library (@executable_path). Each problem is a line naming the file.
 */
export function machOProblems(root, { machine = 'arm64', executableOf = file => path.dirname(file) } = {}) {
  const problems = [];
  const relative = file => path.relative(root, file).replaceAll('\\', '/');
  for (const { file, target } of linksBelow(root)) {
    if (path.isAbsolute(target) || target.includes('/') || target.includes('\\')) problems.push(`${relative(file)} is a link out of its folder (to ${target})`);
    else if (!existsSync(path.join(path.dirname(file), target)) || !statSync(path.join(path.dirname(file), target)).isFile()) problems.push(`${relative(file)} is a link to nothing (${target})`);
  }
  for (const { file, slices, error } of machOFiles(root)) {
    if (error) { problems.push(`${relative(file)} cannot be read as a Mach-O file (${error})`); continue; }
    const slice = slices.find(item => item.cpu === machine);
    if (!slice) continue;
    for (const library of slice.libraries) {
      const candidates = libraryCandidates(library, { loader: path.dirname(file), executable: executableOf(file), rpaths: slice.rpaths });
      if (candidates === 'system') continue;
      const inside = candidates.filter(candidate => !path.relative(root, candidate).startsWith('..'));
      if (!inside.some(candidate => existsSync(candidate))) problems.push(`${relative(file)} loads ${library}, which is not in the payload`);
    }
  }
  return problems.sort();
}

/** Which of some files have no code for `machine`: the payload's own programs must (its Node.js, API, PostgreSQL). */
export function withoutCode(files, machine = 'arm64') {
  return files.filter(file => !(existsSync(file) && machOOf(file)?.slices?.some(slice => slice.cpu === machine)));
}

/** The payload's Mach-O files with a machine's code that carries no code signature (a package's build for Intel Macs
 *  often has none): the Mac packager signs them (ad hoc), so every program the app carries is signed. */
export function unsignedMachO(root) {
  return machOFiles(root).filter(item => item.slices?.some(slice => !slice.signed)).map(item => path.relative(root, item.file).replaceAll('\\', '/'));
}

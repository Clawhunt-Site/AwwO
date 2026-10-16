/**
 * Vite's asset names, except for a file without an extension, such as pdf.js's LICENSE: Rolldown names that one
 * "LICENSE-<hash>." with a trailing dot, which a build on Windows writes without it (the link to it then answers 404),
 * and no server sends it as text. A license or notice file is named .txt instead. Both build configs use it: the hosted
 * one (vite.saas.config.mjs) and the native one (vite.config.mjs), whose output the desktop installer, built on
 * Windows, ships.
 */
export function assetFileNames({ names }) {
  const name = names?.[0] ?? '';
  if (/\.[^./]+$/.test(name)) return 'assets/[name]-[hash][extname]';
  return /^(?:LICEN[CS]E|COPYING|NOTICE)/i.test(name) ? 'assets/[name]-[hash].txt' : 'assets/[name]-[hash]';
}

// The local edition's web server: what the hosted site's nginx does (deploy/saas/nginx.conf), on loopback. It serves
// the built app (apps/web/dist-saas) and proxies the public API, /api/v1/, to the Go API; /api/internal/ (the workers'
// callbacks) is never served here.
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { stagedShowcaseMiddleware } from '../apps/web/scripts/staged-showcase.mjs';
import { LOCAL_HOST, SESSION_COOKIE, SHELL_COOKIE, localOrigin, shellToken } from './awwo-local-lib.mjs';

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.zip': 'application/zip',
});
// As nginx sends them on every response (deploy/saas/nginx.conf).
const SECURITY_HEADERS = Object.freeze({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// A missing file under these is a 404, never the app's page (nginx: /showcase/, /kits/; and every hashed asset, so a
// tab from an earlier build sees its chunk fail and offers the reload, src/saas/staleBuild.ts).
const NO_FALLBACK = ['/showcase/', '/kits/', '/assets/'];

function send(res, status, body = '', headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** The request's decoded path, or null for one with a NUL or a dot segment, encoded or not (%2e%2e, or ../ behind an
 *  encoded slash or backslash), which could leave the site or the API's own prefix. The raw path is read segment by
 *  segment: a URL parser would resolve the dot segments first, while the proxy passes the raw path on. */
export function requestPath(url) {
  const raw = String(url ?? '').split(/[?#]/)[0];
  if (!raw.startsWith('/')) return null;
  const parts = [];
  for (const segment of raw.split('/').slice(1)) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.split(/[\\/]/).some(part => part === '.' || part === '..')) return null;
    parts.push(decoded);
  }
  return `/${parts.join('/')}`;
}

/** A path that may name a site file: no backslash, colon or encoded slash either, which on Windows would name another
 *  folder, an NTFS stream or a drive. API paths may hold them (a skill's reference is builtin:<name>), so this is for
 *  files only. */
export function sitePath(url) {
  const pathname = requestPath(url);
  return pathname === null || /[\\:]/.test(pathname) || /%2f/i.test(String(url ?? '').split(/[?#]/)[0]) ? null : pathname;
}

/** One byte range of a file of `size` bytes, as nginx answers it: [start, end], 'invalid' (416), or null (the whole
 *  file: no Range, or a unit other than bytes, which nginx ignores). */
export function byteRange(header, size) {
  if (!header) return null;
  const value = header.trim();
  if (!/^bytes=/i.test(value)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start, end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  return start >= size || start > end ? 'invalid' : [start, end];
}

async function serveFile(req, res, file, info) {
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const immutable = /\/assets\//.test(file.replaceAll('\\', '/'));
  const headers = {
    ...SECURITY_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  const since = Date.parse(req.headers['if-modified-since'] || '');
  if (!req.headers.range && Number.isFinite(since) && Math.floor(info.mtimeMs / 1000) <= Math.floor(since / 1000)) {
    res.writeHead(304, headers);
    return res.end();
  }
  const range = byteRange(req.headers.range, info.size);
  if (range === 'invalid') return send(res, 416, '', { 'Content-Range': `bytes */${info.size}` });
  const [start, end] = range || [0, info.size - 1];
  res.writeHead(range ? 206 : 200, {
    ...headers, 'Content-Length': String(info.size === 0 ? 0 : end - start + 1),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (req.method === 'HEAD' || info.size === 0) return res.end();
  pipeline(createReadStream(file, { start, end }), res, () => {});
}

async function fileAt(root, pathname) {
  const file = path.join(root, ...pathname.split('/').filter(Boolean));
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const info = await stat(file);
    return info.isFile() ? { file, info } : null;
  } catch {
    return null;
  }
}

/** The values a Cookie header gives a cookie name, in order. */
export function cookieValues(header, name) {
  return String(header || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
}
/** A Cookie header without a cookie name. */
export const withoutCookie = (header, name) => String(header || '').split(';').map(part => part.trim()).filter(part => part && !part.startsWith(`${name}=`)).join('; ');

/** What a Set-Cookie line does to the API's session cookie: null for another cookie, '' when it ends it (no value, a
 *  Max-Age of 0 or less, an Expires gone by: Go writes Max-Age=0 for MaxAge -1), else the session's token. */
export function sessionCookieValue(line) {
  const [pair, ...attributes] = String(line).split(';');
  const at = pair.indexOf('=');
  if (at < 0 || pair.slice(0, at).trim() !== SESSION_COOKIE) return null;
  const ended = attributes.some(attribute => {
    const at = attribute.indexOf('=');
    const name = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? '' : attribute.slice(at + 1).trim();
    return (name === 'max-age' && !(Number(value) > 0)) || (name === 'expires' && !(Date.parse(value) > Date.now()));
  });
  return ended ? '' : pair.slice(at + 1).trim();
}

/** A sign-in kept in this process alone (the window's, where the runtime gives none of its data folder's). */
const memorySession = () => {
  let value = '';
  return { get: () => value, set: next => { value = typeof next === 'string' ? next : ''; } };
};

/**
 * The server. It answers the instance's own name (`host`, AWWO_LOCAL_HOSTNAME, and its port) only; awwo.localhost
 * (the name a person types) and the loopback addresses of the same port are sent there (GET and HEAD) or refused, and
 * so is any other name (a DNS-rebinding page may reach the port under one). The API accepts only the instance's
 * origin. `stagedFallback`: where a staged video not on this computer plays from instead (the hosted site's public
 * copy), or '' for a 404.
 *
 * One exception, for the Mac app's window (`windowToken`, its launch's token, SHELL_TOKEN): macOS resolves *.localhost
 * names only from macOS 26 on, so the window opens http://127.0.0.1:<port>, and a request to it that carries the
 * window's cookie (SHELL_COOKIE, set in the window's own WebKit store, which no browser has) is answered as the
 * instance's own. Its cookie is taken off before the API sees the request, and the window's Origin is given as the
 * instance's, the API's own check (app.go) applying unchanged; an address the API answers with is given back as the
 * window's. The window's sign-in is kept here, not by the window (`windowSession`, the runtime's store of it in the data
 * folder, else this process's): the session cookie the API sets in answer to the window is taken off its answer and
 * kept, and given to the API with each of the window's requests in the place of any the window sends. The window then
 * holds a cookie of its launch alone, which is nothing once its runtime has ended and its port is anyone's. A browser
 * at that address, without the cookie, is sent to the instance's name as before, the site's own files aside (served
 * there without it: the same public files, some fetched by the app without cookies).
 */
export function createLocalWebServer({ root, stagedDir, apiPort, port, host = LOCAL_HOST, stagedFallback = '', windowToken = '', windowSession = memorySession() }) {
  const own = `${host}:${port}`;
  const aliases = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${LOCAL_HOST}:${port}`]);
  aliases.delete(own);
  const origin = localOrigin(port, host);
  const staged = stagedDir ? stagedShowcaseMiddleware(stagedDir) : null;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const token = shellToken(windowToken);
  const windowHost = `127.0.0.1:${port}`;
  const windowOrigin = `http://${windowHost}`;
  const tokenBytes = Buffer.from(token);
  const carriesToken = value => Buffer.byteLength(value) === tokenBytes.length && timingSafeEqual(Buffer.from(value), tokenBytes);
  /** Whether a request is the Mac app's window's: at its address, with its launch's cookie. */
  const fromWindow = req => token !== '' && String(req.headers.host || '').toLowerCase() === windowHost
    && cookieValues(req.headers.cookie, SHELL_COOKIE).some(carriesToken);

  function proxy(req, res, inWindow = false) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(key)) headers[key] = value;
    if (inWindow) {
      headers.host = own;
      const session = windowSession.get();
      const cookies = [withoutCookie(withoutCookie(headers.cookie, SHELL_COOKIE), SESSION_COOKIE), session && `${SESSION_COOKIE}=${session}`].filter(Boolean);
      if (cookies.length) headers.cookie = cookies.join('; '); else delete headers.cookie;
      if (headers.origin === windowOrigin) headers.origin = origin;
    }
    const upstream = http.request({ host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers, agent }, answer => {
      const out = { ...SECURITY_HEADERS };
      for (const [key, value] of Object.entries(answer.headers)) if (!HOP_BY_HOP.has(key) && value !== undefined) out[key] = value;
      if (inWindow && typeof out.location === 'string' && (out.location === origin || out.location.startsWith(`${origin}/`))) out.location = `${windowOrigin}${out.location.slice(origin.length)}`;
      if (inWindow && out['set-cookie']) {
        // The session the API sets (or ends) is the window's, kept here; the window gets no session cookie.
        const kept = [].concat(out['set-cookie']).filter(line => {
          const session = sessionCookieValue(line);
          if (session === null) return true;
          windowSession.set(session);
          return false;
        });
        if (kept.length) out['set-cookie'] = kept; else delete out['set-cookie'];
      }
      res.writeHead(answer.statusCode || 502, out);
      // A stream the API cut (it stopped, or a run's events ended badly) ends the browser's side too.
      pipeline(answer, res, () => {});
    });
    upstream.on('error', () => {
      if (!res.headersSent) send(res, 502, JSON.stringify({ error: { code: 'api_unavailable', message: 'The AwwO API is not answering' } }), { 'Content-Type': 'application/json; charset=utf-8' });
      else res.destroy();
    });
    // A closed tab ends the stream it was reading (a run's events) instead of leaving it open at the API.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    pipeline(req, upstream, () => {});
  }

  let refusing = false;
  async function handle(req, res) {
    // Once the runtime's stop has begun (stopServing) the port stays held, answering this alone, until the runtime
    // ends: a page still open sends its requests (its cookies) here, not to what might take a freed port meanwhile.
    if (refusing) return send(res, 503, 'AwwO 本地版 is stopping', { Connection: 'close' });
    const host = String(req.headers.host || '').toLowerCase();
    const inWindow = fromWindow(req);
    const toInstance = () => send(res, 302, '', { Location: `${origin}${req.url || '/'}` });
    // At the window's address without its cookie, the site's own files are served all the same (the app's assets, a
    // production run's media, a staged video): some of the app's fetches of them carry no cookie (credentials: 'omit'),
    // and they are the public files the instance's name serves to anyone. The app's page and the API are not.
    const windowFile = !inWindow && token !== '' && host === windowHost && (req.method === 'GET' || req.method === 'HEAD');
    if (host !== own && !inWindow && !windowFile) {
      if (aliases.has(host) && (req.method === 'GET' || req.method === 'HEAD')) return toInstance();
      return send(res, aliases.has(host) ? 421 : 403, `AwwO 本地版 answers at ${origin}`);
    }
    const pathname = requestPath(req.url || '/');
    if (pathname === null) return send(res, 400, 'Bad request');
    if (windowFile && pathname.startsWith('/api/')) return toInstance();
    if (pathname.startsWith('/api/v1/')) return proxy(req, res, inWindow);
    if (pathname.startsWith('/api/')) return send(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    if (sitePath(req.url || '/') === null) return send(res, 400, 'Bad request');
    const stagedMatch = /^\/showcase\/staged\/([a-z0-9-]+)\/([0-9a-f]{16}\.mp4)$/.exec(pathname);
    if (stagedMatch) {
      if (staged && existsSync(path.join(stagedDir, stagedMatch[1], stagedMatch[2]))) {
        for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
        // Named after its own SHA-256: a file of that name never changes.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return staged(req, res, () => send(res, 404, 'Not found'));
      }
      if (stagedFallback) return send(res, 302, '', { Location: `${stagedFallback}${pathname}` });
      return send(res, 404, 'Not found');
    }
    const found = pathname === '/' ? null : await fileAt(root, pathname);
    // A page (saas.html by its name) is the app's page, and needs the window's cookie at its address as below.
    if (found && windowFile && /\.html?$/i.test(found.file)) return toInstance();
    if (found) return serveFile(req, res, found.file, found.info);
    if (NO_FALLBACK.some(prefix => pathname.startsWith(prefix)) || pathname === '/third-party-licenses.txt') return send(res, 404, 'Not found');
    // The app's page itself needs the window's cookie at its address.
    if (windowFile) return toInstance();
    const app = await fileAt(root, '/saas.html');
    if (!app) return send(res, 503, 'AwwO is not built yet: run npm run setup:local');
    return serveFile(req, res, app.file, app.info);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, 'Internal error'); else res.destroy(); });
  });
  // Uploads of up to 64 MB and long event streams pass through; the API sets its own limits and deadlines.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.on('close', () => agent.destroy());
  /** The runtime's stop has begun: every request is answered 503 from now on and none reaches the API, the open
   *  connections (a run's event stream) end, and the port is held until close(). */
  server.stopServing = () => {
    refusing = true;
    server.closeAllConnections();
  };
  return server;
}

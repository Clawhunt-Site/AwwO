import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The dev server's stand-in for the hosted site's staged showcase files. A film case's film is staged once on the host,
 * outside every release, and is never in showcase/; this serves /showcase/staged/<case>/<file>
 * from <dir>/<case>/<file>, byte ranges included, so the case dialog's player can be tried locally. Only a case name and
 * a staged file's name (16 hex digits of its sha256, .mp4) are matched, so no request leaves <dir>; any other request
 * goes on to the next middleware.
 */
export function stagedShowcaseMiddleware(dir) {
  return (req, res, next) => {
    const match = /^\/showcase\/staged\/([a-z0-9-]+)\/([0-9a-f]{16}\.mp4)$/.exec((req.url || '').split('?')[0]);
    if (!match) return next();
    const file = join(dir, match[1], match[2]);
    let size;
    try { const stat = statSync(file); if (!stat.isFile()) throw new Error('not a file'); size = stat.size; } catch { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Accept-Ranges', 'bytes');
    let start = 0, end = size - 1;
    if (req.headers.range) {
      // One byte range: from-to, from- (to the end) or -n (the last n bytes); anything else, or past the end, is 416.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range && range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1; }
      else if (range && range[2]) start = Math.max(0, size - Number(range[2]));
      if (!range || (!range[1] && !range[2]) || start >= size || start > end) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).on('error', () => { res.destroy(); }).pipe(res);
  };
}

/** The dev server's plugin for it, on when AWWO_STAGED_SHOWCASE names the folder; nothing is built from it. */
export function stagedShowcase(dir = process.env.AWWO_STAGED_SHOWCASE) {
  return { name: 'awwo-saas-staged-showcase', apply: 'serve', configureServer(server) { if (dir) server.middlewares.use(stagedShowcaseMiddleware(dir)); } };
}

// @vitest-environment node
import { createServer, request, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { stagedShowcase, stagedShowcaseMiddleware } from '../scripts/staged-showcase.mjs';

// The dev server's stand-in for a staged film (scripts/staged-showcase.mjs), on a real HTTP server over a folder laid
// out as the host's store is: <case>/<16 hex digits>.mp4.
const NAME = '0123456789abcdef.mp4', BYTES = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
let dir = '', server: Server, port = 0;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'awwo-staged-'));
  mkdirSync(path.join(dir, 'film-case'));
  writeFileSync(path.join(dir, 'film-case', NAME), BYTES);
  mkdirSync(path.join(dir, 'film-case', 'fedcba9876543210.mp4'));
  const serve = stagedShowcaseMiddleware(dir);
  server = createServer((req, res) => serve(req, res, () => { res.statusCode = 299; res.end('next'); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

function get(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, path: url, method, headers }, response => {
      const parts: Buffer[] = [];
      response.on('data', part => parts.push(part)).on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(parts) }));
    });
    sent.on('error', reject).end();
  });
}
const film = `/showcase/staged/film-case/${NAME}`;

it('serves a staged film whole, or the one byte range asked for: from-to, from to the end, or the last n bytes', async () => {
  const whole = await get(film);
  expect([whole.status, whole.headers['content-type'], whole.headers['accept-ranges'], whole.headers['content-length']]).toEqual([200, 'video/mp4', 'bytes', '100']);
  expect(whole.body.equals(BYTES)).toBe(true);
  for (const [range, start, end] of [['bytes=0-9', 0, 9], ['bytes=95-', 95, 99], ['bytes=-4', 96, 99], ['bytes=90-500', 90, 99], ['bytes=-500', 0, 99]] as const) {
    const part = await get(film, { range });
    expect([part.status, part.headers['content-range'], part.headers['content-length']], range).toEqual([206, `bytes ${start}-${end}/100`, String(end - start + 1)]);
    expect(part.body.equals(BYTES.subarray(start, end + 1)), range).toBe(true);
  }
  // A query string (a cache-buster) is no other file.
  expect((await get(`${film}?v=2`)).status).toBe(200);
});

it('answers 416 for a range it cannot serve, and HEAD with the headers only', async () => {
  for (const range of ['bytes=100-', 'bytes=150-200', 'bytes=9-3', 'bytes=-', 'bytes=0-9,20-29', 'items=0-9']) {
    const refused = await get(film, { range });
    expect([refused.status, refused.headers['content-range'], refused.body.length], range).toEqual([416, 'bytes */100', 0]);
  }
  const head = await get(film, {}, 'HEAD');
  expect([head.status, head.headers['content-length'], head.body.length]).toEqual([200, '100', 0]);
  const headRange = await get(film, { range: 'bytes=10-19' }, 'HEAD');
  expect([headRange.status, headRange.headers['content-range'], headRange.body.length]).toEqual([206, 'bytes 10-19/100', 0]);
});

it('serves nothing but a staged film file inside its folder: other paths go on, and a missing file or a folder is 404', async () => {
  expect((await get('/showcase/staged/film-case/0123456789abcdee.mp4')).status).toBe(404);
  expect((await get('/showcase/staged/film-case/fedcba9876543210.mp4')).status).toBe(404);
  for (const url of [`/showcase/staged/film-case/../film-case/${NAME}`, `/showcase/staged/Film-Case/${NAME}`, '/showcase/staged/film-case/0123456789abcdef.webm',
    '/showcase/staged/film-case/0123456789ABCDEF.mp4', `/showcase/staged/film-case/x/${NAME}`, `/showcase/staged/${NAME}`, '/showcase/long-chord-real.mp4']) {
    const passed = await get(url);
    expect([passed.status, passed.body.toString()], url).toEqual([299, 'next']);
  }
});

it('is a dev-server plugin only, and only when a folder is named', () => {
  const used: unknown[] = [];
  const plugin = stagedShowcase(dir);
  expect([plugin.name, plugin.apply]).toEqual(['awwo-saas-staged-showcase', 'serve']);
  plugin.configureServer({ middlewares: { use: (handler: unknown) => used.push(handler) } });
  expect(used).toHaveLength(1);
  stagedShowcase('').configureServer({ middlewares: { use: (handler: unknown) => used.push(handler) } });
  expect(used).toHaveLength(1);
});

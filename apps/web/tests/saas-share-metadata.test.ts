import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// What a search result, a shared link's preview and a phone's home screen show come from saas.html alone: link scrapers
// and search crawlers read the HTML as served and run none of the app. Until 2026-11-05 it held a title and an icon only,
// so a shared AwwO link had no description and no picture.
const web = (path: string) => resolve(process.cwd(), path);
const html = readFileSync(web('saas.html'), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));
const meta = (attribute: 'name' | 'property', key: string) => [...head.matchAll(new RegExp(`<meta ${attribute}="${key.replace(/[.:]/g, '\\$&')}"(?: media="[^"]*")? content="([^"]*)"\\/>`, 'g'))].map(match => match[1]);

/** Width and height from a JPEG's start-of-frame segment. */
function jpegSize(bytes: Buffer): [number, number] {
  expect(bytes.readUInt16BE(0)).toBe(0xffd8);
  for (let at = 2; at < bytes.length;) {
    const marker = bytes.readUInt16BE(at);
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
    at += 2 + length;
  }
  throw new Error('no start-of-frame segment');
}
/** Width and height from a PNG's IHDR chunk, and whether it has an alpha channel. */
function pngSize(bytes: Buffer): [number, number, boolean] {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20), [4, 6].includes(bytes[25])];
}

it('describes AwwO to search engines and link previews in both languages, in the words of its sign-in page', () => {
  // One head is read for every reader: each text says it in Chinese, then in English (AWWO-LAW-022's parity).
  const [description] = meta('name', 'description');
  expect(description).toMatch(/^AwwO 让多个 Agent 在同一张画布上协作：写下目标，确认分工，按依赖运行，每个节点交付自己的成果。AwwO brings your agents together on one canvas: /);
  // The preview's title is the sign-in page's own in both languages (SaaSApp Login), so a link reads as the page it opens.
  const app = readFileSync(web('src/saas/SaaSApp.tsx'), 'utf8');
  expect(app).toContain("useDocumentTitle(recovering ? null : t('AwwO · 让 Agent 在同一张画布上协作', 'AwwO · Bring your agents together on one canvas'));");
  expect(meta('property', 'og:title')).toEqual(['AwwO · 让 Agent 在同一张画布上协作 · Bring your agents together on one canvas']);
  expect(meta('name', 'twitter:title')).toEqual(meta('property', 'og:title'));
  expect(meta('property', 'og:description')[0]).toMatch(/^写下目标，确认分工，按依赖运行：.+。Write down the goal, agree on the team, run in dependency order: /);
  for (const text of [description, ...meta('property', 'og:description'), ...meta('property', 'og:image:alt')]) {
    expect(text, text).toMatch(/[一-鿿]/);
    expect(text, text).toMatch(/[A-Za-z]{4,} [a-z]+ [a-z]+/);
  }
  expect(meta('property', 'og:site_name')).toEqual(['AwwO']);
  expect(meta('property', 'og:type')).toEqual(['website']);
  expect(meta('name', 'twitter:card')).toEqual(['summary_large_image']);
});

it('names a 1200 × 630 preview image by an absolute address at the hosted site, where the build serves it', () => {
  // Scrapers need an absolute URL; the hosted site's origin is the one the API defaults to (edition.go).
  const origin = /const defaultCloudOrigin = "([^"]+)"/.exec(readFileSync(web('../../backend/internal/app/edition.go'), 'utf8'))![1];
  const [image] = meta('property', 'og:image');
  expect(image).toBe(`${origin}/og-awwo.jpg`);
  expect(meta('name', 'twitter:image')).toEqual([image]);
  // public/ is copied to the site's root, and nginx serves a file there before falling back to the app.
  const [width, height] = jpegSize(readFileSync(web('public/og-awwo.jpg')));
  expect([width, height]).toEqual([1200, 630]);
  expect(meta('property', 'og:image:width')).toEqual([String(width)]);
  expect(meta('property', 'og:image:height')).toEqual([String(height)]);
  expect(meta('property', 'og:image:type')).toEqual(['image/jpeg']);
  expect(meta('property', 'og:image:alt')[0]).toMatch(/^AwwO：让 Agent 在同一张画布上协作。.+AwwO: bring your agents together on one canvas\./);
  expect(readFileSync(web('../../deploy/saas/nginx.conf'), 'utf8')).toContain('location / { try_files $uri /saas.html; }');
});

it('gives a phone’s home screen an opaque 180 × 180 icon and the name AwwO', () => {
  expect(head).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>');
  // An icon with transparency gets a black ground on the home screen.
  expect(pngSize(readFileSync(web('public/apple-touch-icon.png')))).toEqual([180, 180, false]);
  expect(meta('name', 'apple-mobile-web-app-title')).toEqual(['AwwO']);
  expect(meta('name', 'application-name')).toEqual(['AwwO']);
});

it('colours a phone browser’s bar as the page’s ground, light and dark (the boot surface’s fallbacks)', () => {
  expect(meta('name', 'theme-color')).toEqual(['#eef0ef', '#07161f']);
  expect(head).toContain('<meta name="theme-color" media="(prefers-color-scheme: light)" content="#eef0ef"/>');
  expect(head).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#07161f"/>');
  expect(head).toContain('html{background:var(--bg-base,#eef0ef)}html[data-theme=dark]{background:var(--bg-base,#07161f)}');
});

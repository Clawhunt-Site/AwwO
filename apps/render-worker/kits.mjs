// Kits AwwO supplies to the pages it renders. A page names a kit by one fixed URL on AwwO's own site, which a render's
// browser can never reach (it resolves only the CDNs, network.mjs); the worker answers exactly that URL with its own
// pinned copy instead, so the kit never comes over the network and is always reviewed bytes (a film's brand fonts
// still come from jsDelivr, a CDN on the allowlist, as other pages' fonts do). Each copy is the web
// bundle's file byte for byte (apps/web/src/canvas/filmKit/film-kit.js, built from third_party/cinecode), checked
// against its size and sha256 when this module loads: a worker with a damaged copy fails to start rather than render
// with it. kits.test.mjs keeps the copy equal to the web's file.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const KITS = Object.freeze([
  Object.freeze({
    id: 'film-kit-1',
    url: 'https://awwo.clawhunt.store/kits/film/1/film.js',
    file: 'film-kit-1.js',
    bytes: 102326,
    sha256: '8e6af5d8ee28ad3a9b1d928e395376608b4224e9774dc4cd112155326620b777',
  }),
]);

const BODIES = new Map(KITS.map((kit) => {
  const body = readFileSync(new URL(`./kits/${kit.file}`, import.meta.url));
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (body.length !== kit.bytes || sha256 !== kit.sha256) {
    throw new Error(`render worker: kits/${kit.file} is ${body.length} bytes with sha256 ${sha256}, not the pinned ${kit.bytes} / ${kit.sha256}`);
  }
  return [kit.url, body];
}));

/** The pinned bytes of the kit this exact URL names (a query or fragment names nothing), else null. */
export function suppliedKit(url) {
  return BODIES.get(String(url)) ?? null;
}

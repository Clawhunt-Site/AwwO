import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fontLicences, inlinedFontLicences } from './scripts/font-licences.mjs';
import { PREVIEW_FONTS } from './src/canvas/previewFontList.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
/** Each preview font face's license file: its family's, by the list that names the families. */
const PREVIEW_FONT_LICENCES = new Map(PREVIEW_FONTS.flatMap(font => font.faces.map(face => [face.file, `${font.family.toLowerCase().replace(/ /g, '-')}.LICENSE.txt`])));
/** Where the hosted site serves the figure kit: the path of FIGURE_KIT_URL (tests/saas-figure-kit.test.ts checks both). */
const FIGURE_KIT_PATH = '/kits/anatomy/1/anatomy.js';
const FIGURE_KIT_FILE = join(root, 'src', 'canvas', 'figureKit', 'anatomy-kit.js');
export default defineConfig({
  root, plugins: [react(), { name: 'awwo-saas-entry', configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url?.startsWith('/?') || req.url === '/admin') req.url = `/saas.html${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
      next();
    });
  } },
  // The homepage's case footage (showcase/) ships with the hosted site only, not through public/,
  // which the desktop build bundles too. The dev server already serves them from the root.
  { name: 'awwo-saas-showcase', apply: 'build', writeBundle(options) { cpSync(join(root, 'showcase'), join(options.dir, 'showcase'), { recursive: true }); } },
  // The figure kit a figure page names by URL (src/canvas/figureKit/figureKit.ts FIGURE_KIT_URL). Running previews inline
  // these bytes; the hosted site serves the same file at that path so a downloaded page still draws.
  { name: 'awwo-saas-figure-kit',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== FIGURE_KIT_PATH) return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(readFileSync(FIGURE_KIT_FILE));
      });
    },
    writeBundle(options) {
      const target = join(options.dir, ...FIGURE_KIT_PATH.split('/').filter(Boolean));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(FIGURE_KIT_FILE, target);
    } },
  // Mona Sans is under the SIL Open Font License, which asks that every copy carry its license: the build writes
  // fonts/LICENSE-mona-sans.txt beside the font files it emits (scripts/font-licences.mjs).
  fontLicences(join(root, 'src', 'saas', 'design', 'fonts')),
  // So are the preview fonts (src/canvas/previewFonts.ts), each family with its own license, which they inline as
  // data: URLs: every script chunk holding one of them starts with that font's license (scripts/font-licences.mjs).
  inlinedFontLicences(join(root, 'src', 'canvas', 'fonts'), PREVIEW_FONT_LICENCES)],
  define: { 'import.meta.env.VITE_AWWO_SAAS': JSON.stringify('1') },
  server: { host: process.env.VITE_AWWO_WEB_HOST || '127.0.0.1', port: Number(process.env.VITE_AWWO_WEB_PORT || 5189), strictPort: true,
    proxy: { '/api/v1': { target: process.env.AWWO_API_TARGET || 'http://127.0.0.1:8087' } } },
  build: { outDir: 'dist-saas', rollupOptions: { input: fileURLToPath(new URL('./saas.html', import.meta.url)) } },
});

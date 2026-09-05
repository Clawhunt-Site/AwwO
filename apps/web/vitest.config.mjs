import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirror the embedding wiring from vite.config.mjs so tests can import the real
// Paperclip board modules (server/ui via the `@` alias) and see the same
// embedding API base the app build injects. Kept in sync with vite.config.mjs.
const boardSrc = fileURLToPath(new URL('../../server/ui/src', import.meta.url));
// CompanyBoard.tsx imports `@mdxeditor/editor/style.css`; that dep lives in
// server/ui/node_modules (pnpm) and can't be resolved from apps/web's tree, so the
// app build aliases the exact specifier to the resolved file. Mirror it here, or any
// test that imports CompanyBoard fails to resolve the CSS. Kept in sync with vite.config.mjs.
const boardRequire = createRequire(fileURLToPath(new URL('../../server/ui/package.json', import.meta.url)));
const boardMdxEditorStyleCss = boardRequire.resolve('@mdxeditor/editor/style.css');

export default defineConfig({
  define: {
    __PAPERCLIP_API_BASE__: JSON.stringify(process.env.VITE_PAPERCLIP_API_BASE || '/paperclip-api'),
  },
  resolve: {
    alias: [
      { find: '@', replacement: boardSrc },
      { find: '@mdxeditor/editor/style.css', replacement: boardMdxEditorStyleCss },
    ],
    // Mirror vite.config.mjs. The sibling canvas packages that each carried their OWN
    // node_modules/react are gone, but the embedded company board is still a separate
    // install, so a second React copy would still break hooks ("Cannot read properties
    // of null (reading 'useState')"). Same dedupe the app build already uses.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: './tests/setup.ts',
    // Headroom for slow, CPU-contended CI runners (the default 5000ms can be
    // tight when the whole suite runs in parallel) — paired with the larger
    // asyncUtilTimeout in setup.ts so a waitFor never outlives its test.
    testTimeout: 20000,
  },
});

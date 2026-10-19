import { defineConfig } from 'vitest/config';
import { withoutCutCode } from './scripts/three-cuts.mjs';

// A test that imports one of three.js's files as ?raw text, as a running preview does, gets it as the builds ship it,
// without the code it took from Shadertoy, Stack Exchange sites and OpenProcessing (scripts/three-cuts.mjs); a code
// import of three goes to Node as it is.
export default defineConfig({ plugins: [withoutCutCode()], resolve: { dedupe: ['react', 'react-dom'] },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], setupFiles: './tests/setup.ts', testTimeout: 20000 } });

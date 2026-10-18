import { defineConfig } from 'vitest/config';
import { withoutShadertoyShaders } from './scripts/three-shadertoy.mjs';

// A test that imports one of three.js's files as ?raw text, as a running preview does, gets it as the builds ship it,
// without the shaders from Shadertoy (scripts/three-shadertoy.mjs); a code import of three goes to Node as it is.
export default defineConfig({ plugins: [withoutShadertoyShaders()], resolve: { dedupe: ['react', 'react-dom'] },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], setupFiles: './tests/setup.ts', testTimeout: 20000 } });

import { defineConfig } from 'vitest/config';
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], setupFiles: './tests/setup.ts', testTimeout: 20000 } });

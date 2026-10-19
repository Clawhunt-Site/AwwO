// @vitest-environment node
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { THREE_ENTRY, expectShipped, type OutputFile } from './three-cuts-checks';

const WEB = path.resolve(__dirname, '..');

// The native build config itself (vite.config.mjs, whose output the desktop app and the root Docker image ship), on an
// entry that takes in three.js as tests/three-cuts-checks.ts expects, with the preview fonts and React, which its font
// license plugin and a chunk group of its own want. The input goes in rolldownOptions, as the config names its own.
describe('the code three.js took from Shadertoy, Stack Exchange sites and OpenProcessing, in the native build', () => {
  it("is left out of the app's own three.js and of the copies a running preview loads", async () => {
    const entry = 'virtual:awwo-native-three-cuts-test';
    const code = `import { previewFontSource } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'))};`
      + "import { createElement } from 'react';"
      + 'globalThis.awwoPreviewFontSource = [previewFontSource, createElement];\n'
      + THREE_ENTRY;
    const result = await build({
      configFile: path.join(WEB, 'vite.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production',
      plugins: [{ name: 'awwo-native-three-cuts-test-entry',
        resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined),
        load: (id: string) => (id === `\0${entry}` ? code : undefined) }],
      build: { write: false, rolldownOptions: { input: entry } },
    });
    await expectShipped((Array.isArray(result) ? result : [result]).flatMap(output => (output as { output: OutputFile[] }).output), 'native');
  }, 300_000);

  it('is left out for its workers too', async () => {
    const { default: config } = await import('../vite.config.mjs');
    const names = (plugins: unknown) => [plugins].flat(Infinity as 1).map(plugin => (plugin as { name?: string } | null)?.name);
    expect(names(config.plugins)).toContain('awwo-three-cuts');
    expect(names(config.worker.plugins())).toEqual(['awwo-three-cuts']);
  });
});

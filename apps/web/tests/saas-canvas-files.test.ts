import { describe, expect, it } from 'vitest';
import { pickCanvasFile } from '../src/canvas/studio/canvasAssets';
import type { StudioEntry } from '../src/canvas/studio/studioModel';

const media = (nodeId: string, name: string): StudioEntry => ({
  id: `${nodeId}:media:a${nodeId}0000000`, nodeId, nodeTitle: nodeId, folder: [], name, label: name, kind: 'image', state: 'done',
  source: { type: 'media', artifactId: `a${nodeId}0000000`, contentType: 'image/png', size: 10 },
} as StudioEntry);

describe('canvas files a delivered page names', () => {
  const entries = [media('hero', 'image-1.png'), media('banner', 'image-1.png'), media('banner', 'image-2.png')];

  it('prefers the file of the node a canvas run named as the folder', () => {
    expect(pickCanvasFile(entries, 'banner/image-1.png')?.nodeId).toBe('banner');
    expect(pickCanvasFile(entries, './hero/image-1.png?v=2')?.nodeId).toBe('hero');
  });

  it('still finds a file by its name alone, as before', () => {
    expect(pickCanvasFile(entries, 'image-1.png')?.nodeId).toBe('hero');
    expect(pickCanvasFile(entries, 'assets/IMAGE-2.PNG')?.nodeId).toBe('banner');
    expect(pickCanvasFile(entries, 'unknown/image-1.png')?.nodeId).toBe('hero');
    expect(pickCanvasFile(entries, 'missing.png')).toBeUndefined();
  });

  it('never answers a page with itself', () => {
    expect(pickCanvasFile(entries, 'hero/image-1.png', entries[0].id)?.nodeId).toBe('banner');
  });
});

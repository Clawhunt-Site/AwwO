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

  // The Results studio (DeliverableStudio) names a stored file by the name it learns on reading it. A page made from
  // three image nodes names `<node id>/image-1.jpg` for each of its chapters; it must get each node's own picture.
  it('gives each chapter of a page its own node picture when names come from nameOf', () => {
    const stored = (nodeId: string): StudioEntry => ({
      id: `${nodeId}:file`, nodeId, nodeTitle: nodeId, folder: [], name: 'file', label: 'Picture', kind: 'file', state: 'done',
      source: { type: 'stored', reference: `ref-${nodeId}` },
    } as StudioEntry);
    const chapters = [stored('cv-rooftop'), stored('cv-market'), stored('cv-dawn')];
    const realName = () => 'image-1.jpg';
    expect(pickCanvasFile(chapters, 'cv-market/image-1.jpg', undefined, realName)?.nodeId).toBe('cv-market');
    expect(pickCanvasFile(chapters, 'cv-dawn/image-1.jpg', undefined, realName)?.nodeId).toBe('cv-dawn');
    expect(pickCanvasFile(chapters, 'cv-rooftop/image-1.jpg', undefined, realName)?.nodeId).toBe('cv-rooftop');
    expect(pickCanvasFile(chapters, 'image-1.jpg', undefined, realName)?.nodeId).toBe('cv-rooftop');
    expect(pickCanvasFile(chapters, 'cv-market/image-1.jpg')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { mediaModelsOf, mediaVendorLabel, parseMediaCatalogue } from '../src/canvas/mediaCatalog';

const model = (id: string, kind: 'image' | 'video', vendor = 'xtasy') => ({ id, name: id, vendor, kind, mode: `text-to-${kind}`, provider: 'xtasy',
  prompt: { minLength: 1, maxLength: 32000 },
  params: [{ name: 'aspectRatio', type: 'enum', values: ['16:9', '1:1'], default: '16:9', label: ['画面比例', 'Aspect ratio'] }] });

describe('X-tasy media models', () => {
  it('reads X-tasy image and video models from the catalogue and labels their vendor', () => {
    const catalogue = parseMediaCatalogue({ configured: true, available: true, limits: { runsPerDay: 30, timeoutSeconds: 1200 },
      models: [model('xt.seedream-5-pro', 'image', 'bytedance'), model('xt.xtasy-v3', 'video'), model('xt.Bad', 'image'), model('xx.other', 'video')] });
    expect(mediaModelsOf(catalogue, 'image').map(m => m.id)).toEqual(['xt.seedream-5-pro']);
    expect(mediaModelsOf(catalogue, 'video').map(m => m.id)).toEqual(['xt.xtasy-v3']);
    expect(mediaVendorLabel('xtasy', 'zh')).toBe('X-tasy');
  });
});

import { describe, expect, it } from 'vitest';
import { mediaGroupLabel, mediaModelLabel, mediaModelsOf, parseMediaCatalogue } from '../src/canvas/mediaCatalog';

const model = (id: string, kind: 'image' | 'video', label?: unknown) => ({ id, name: id, ...(label === undefined ? {} : { label }), vendor: 'media', kind,
  mode: `text-to-${kind}`, prompt: { minLength: 1, maxLength: 32000 },
  params: [{ name: 'aspectRatio', type: 'enum', values: ['16:9', '1:1'], default: '16:9', label: ['画面比例', 'Aspect ratio'] }] });

describe('X-tasy media models', () => {
  it('reads X-tasy image and video models from the catalogue and shows them as media by their generic names', () => {
    const catalogue = parseMediaCatalogue({ configured: true, available: true, limits: { runsPerDay: 30, timeoutSeconds: 1200 },
      models: [model('xt.seedream-5-pro', 'image', ['图片 · 高清', 'Image · HD']), model('xt.xtasy-v3', 'video'), model('xt.Bad', 'image'), model('xx.other', 'video')] });
    const [image] = mediaModelsOf(catalogue, 'image');
    const [video] = mediaModelsOf(catalogue, 'video');
    expect(mediaModelsOf(catalogue, 'image').map(m => m.id)).toEqual(['xt.seedream-5-pro']);
    expect(mediaModelsOf(catalogue, 'video').map(m => m.id)).toEqual(['xt.xtasy-v3']);
    expect(mediaModelLabel(image, 'zh')).toBe('图片 · 高清');
    expect(mediaModelLabel(image, 'en')).toBe('Image · HD');
    // An entry without a label (an older server) is shown by its name.
    expect(mediaModelLabel(video, 'en')).toBe('xt.xtasy-v3');
    expect(mediaGroupLabel('zh')).toBe('媒体');
    expect(mediaGroupLabel('en')).toBe('Media');
  });

  it('falls back to the name when a label is malformed, never shows it', () => {
    for (const label of [['only one'], ['', 'Empty'], ['图片', 'x'.repeat(41)], 'Image · HD', [1, 2]]) {
      const [image] = mediaModelsOf(parseMediaCatalogue({ configured: true, available: true, models: [model('xt.seedream-5-pro', 'image', label)] }), 'image');
      expect(image.label).toEqual(['xt.seedream-5-pro', 'xt.seedream-5-pro']);
    }
  });
});

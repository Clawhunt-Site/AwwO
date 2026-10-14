// A media model is never named by its id anywhere a run is reported: its id names the service and model family behind
// it (owner decisions 2026-10-11). These pin the shared rule the execution timeline, the run receipt and a node's
// model chip use.
import { describe, expect, it } from 'vitest';
import { parseMediaCatalogue } from '../src/canvas/mediaCatalog';
import { mediaModelName, nodeModelName, runsOnMediaModel, unlistedModelLabel } from '../src/canvas/modelNames';
import type { ModelPaletteSelection } from '../src/canvas/modelPalette';

const media = parseMediaCatalogue({ configured: true, available: true, models: [
  { id: 'xt.seedream-5-pro', name: 'seedream 5 pro', label: ['图片 · 高清', 'Image · HD'], vendor: 'xtasy', kind: 'image', prompt: { minLength: 1, maxLength: 2000 }, params: [] },
  { id: 'xt.xtasy-v3', name: 'xtasy v3', label: ['视频 · 标准', 'Video · Standard'], vendor: 'xtasy', kind: 'video', prompt: { minLength: 1, maxLength: 2000 }, params: [] },
] });
const chat: ModelPaletteSelection[] = [{ key: 'opus', runtime: 'pi', model: 'bedrock.claude-opus-5-5', label: 'Claude Opus 5.5', providerGroup: 'claude', available: true }];

describe('the name a node’s model is reported by', () => {
  it('names a media model by the catalogue’s generic name in the reader’s language', () => {
    expect(nodeModelName({ agentKind: 'image', runtime: 'openai-agents', model: 'xt.seedream-5-pro' }, { media }, 'zh')).toBe('图片 · 高清');
    expect(nodeModelName({ agentKind: 'video', runtime: '', model: 'xt.xtasy-v3' }, { media }, 'en')).toBe('Video · Standard');
  });

  it('falls back to the kind, never the id, when the catalogue cannot name a media model', () => {
    // Not offered here, retired, unread, or listed under another kind.
    expect(nodeModelName({ agentKind: 'video', model: 'xt.other-video' }, { media }, 'zh')).toBe('视频');
    expect(nodeModelName({ agentKind: 'image', model: 'rh.seedream-v5-pro' }, {}, 'en')).toBe('Image');
    expect(nodeModelName({ agentKind: 'model3d', model: 'tripo.p1' }, { media: null }, 'en')).toBe('3D model');
    expect(nodeModelName({ agentKind: 'video', model: 'xt.seedream-5-pro' }, { media }, 'zh')).toBe('视频');
    // A media id on a node that is not a media node is still a media model's id.
    expect(nodeModelName({ agentKind: 'llm', runtime: 'pi', model: 'xt.xtasy-v3' }, {}, 'zh')).toBe('媒体模型');
    expect(nodeModelName({ agentKind: 'llm', runtime: 'pi', model: 'xt.xtasy-v3' }, { media }, 'en')).toBe('Video · Standard');
    expect(mediaModelName(null, '', media, 'en')).toBe('Media model');
  });

  it('keeps naming chat models as before: the catalogue label, a missing team connection, else the selector', () => {
    expect(nodeModelName({ agentKind: 'llm', runtime: 'pi', model: 'bedrock.claude-opus-5-5' }, { models: chat }, 'en')).toBe('Claude Opus 5.5');
    expect(nodeModelName({ agentKind: 'llm', runtime: 'claude_local', model: 'bedrock.claude-opus-5-5' }, { models: chat }, 'en')).toBe('bedrock.claude-opus-5-5');
    expect(nodeModelName({ agentKind: 'coding', runtime: 'pi', model: 'byok_scope_x_12345678' }, {}, 'zh')).toBe('当前目录未包含该模型 · 12345678');
    expect(nodeModelName({ agentKind: 'llm', runtime: 'pi', model: 'qwen3.8-27b-p6' }, {}, 'zh')).toBe('qwen3.8-27b-p6');
    expect(nodeModelName({ agentKind: 'llm', runtime: 'pi', model: '' }, { models: chat }, 'zh')).toBe('');
    expect(nodeModelName({ agentKind: 'image', model: undefined }, { media }, 'zh')).toBe('');
  });

  it('tells a media node apart by its kind or its model’s id', () => {
    expect(runsOnMediaModel({ agentKind: 'video', model: '' })).toBe(true);
    expect(runsOnMediaModel({ agentKind: 'llm', model: 'tripo.p1' })).toBe(true);
    expect(runsOnMediaModel({ agentKind: 'llm', model: 'xtasy-v3' })).toBe(false);
    expect(runsOnMediaModel({ agentKind: 'coding', model: 'bedrock.claude-opus-5-5' })).toBe(false);
  });

  it('labels an unlisted model in a node’s chip by its kind for media, by its selector otherwise', () => {
    expect(unlistedModelLabel({ agentKind: 'image', model: 'xt.seedream-5-pro' }, 'en')).toBe('Image');
    expect(unlistedModelLabel({ agentKind: 'video', model: 'xt.xtasy-v3' }, 'zh')).toBe('视频');
    expect(unlistedModelLabel({ agentKind: 'llm', runtime: 'pi', model: 'qwen3.8-27b-p6' }, 'zh')).toBe('qwen3.8-27b-p6');
    expect(unlistedModelLabel({ agentKind: 'image', model: '' }, 'zh')).toBeUndefined();
  });
});

// An audio node (2026-10-17): a voice-over read from its text, or a score its text describes. The catalogue offers its
// models like any other media model, its result is typed audio and plays in place, and a page wired from it is told the
// file's path and how to play it.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createSessionNode, sanitizeDocument, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import { mediaKindOf, mediaModelsOf, parseMediaCatalogue, replacementMediaModel } from '../src/canvas/mediaCatalog';
import { replaceRetiredMediaModels } from '../src/canvas/retiredMediaModels';
import { MEDIA_AUDIO_PAGE_RULE, mediaDeliveryText, mediaMissingText, parseMediaOutput } from '../src/canvas/mediaOutput';
import { MediaResult } from '../src/canvas/MediaResult';
import { canConnect, isSoftMediaFeed, portsFor } from '../src/canvas/ports';
import { runGraph } from '../src/canvas/runGraph';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };

const rawCatalogue = {
  configured: true, available: true, limits: { runsPerDay: 30, timeoutSeconds: 1200 },
  models: [
    { id: 'rh.minimax-speech-2-8-hd', name: '配音 · 旁白', label: ['配音 · 旁白', 'Voice-over'], vendor: 'media', kind: 'audio', mode: 'text-to-speech',
      prompt: { minLength: 1, maxLength: 1000 }, references: 0,
      params: [
        { name: 'voice', type: 'enum', values: ['Calm_Woman', 'Young_Knight'], default: 'Calm_Woman', label: ['音色', 'Voice'],
          valueLabels: [['沉静女声', 'Calm woman'], ['少年骑士', 'Young knight']] },
        { name: 'speed', type: 'number', min: 0.5, max: 2, default: 1, label: ['语速', 'Speed'] },
        { name: 'englishNormalization', type: 'boolean', default: false, label: ['英文数字规范朗读', 'English normalization'] },
      ] },
    { id: 'rh.minimax-music-2-6-instrumental', name: '配乐 · 纯音乐', label: ['配乐 · 纯音乐', 'Score · Instrumental'], vendor: 'media', kind: 'audio',
      mode: 'text-to-music', prompt: { minLength: 1, maxLength: 2000 },
      params: [{ name: 'sampleRate', type: 'enum', values: ['16000', '44100'], default: '44100', label: ['采样率', 'Sample rate'] }] },
    { id: 'rh.seedream-v5-pro', name: '图片 · 高清无损', vendor: 'media', kind: 'image', mode: 'text-to-image', prompt: { minLength: 5, maxLength: 5000 }, params: [] },
  ],
};

const record = (contentType = 'audio/mpeg', kind = 'audio') => JSON.stringify({ type: 'awwo.media', version: 1, kind, model: 'rh.minimax-speech-2-8-hd',
  items: [{ artifactId: 'aBCDEFGHIJ0123456789_-', name: 'audio-1.mp3', contentType, size: 4106 }] });

function voice(id: string): SessionNode {
  return { ...createSessionNode('audio', { x: 0, y: 0 }), id, title: '云雀', model: 'rh.minimax-speech-2-8-hd',
    binding: { companyId: 'c1', agentId: `ag-${id}`, agentName: id } };
}
function page(id: string): SessionNode {
  return { ...createSessionNode('coding', { x: 700, y: 0 }), id, title: '页面', runtime: 'claude_local',
    binding: { companyId: 'c1', agentId: `ag-${id}`, agentName: id } };
}
const wire = (from: string, to: string, toPort: string, dataType: CanvasEdge['dataType'] = 'audio'): CanvasEdge =>
  ({ id: `${from}:result->${to}:${toPort}`, fromNode: from, fromPort: 'result', toNode: to, toPort, dataType });

afterEach(() => { cleanup(); clearSaaSCanvas(); });

describe('audio models in the catalogue', () => {
  it('accepts audio models with their closed choices', () => {
    const catalogue = parseMediaCatalogue(rawCatalogue);
    expect(catalogue.models.map(model => model.id)).toEqual(['rh.minimax-speech-2-8-hd', 'rh.minimax-music-2-6-instrumental', 'rh.seedream-v5-pro']);
    const audio = mediaModelsOf(catalogue, 'audio');
    expect(audio.map(model => model.label)).toEqual([['配音 · 旁白', 'Voice-over'], ['配乐 · 纯音乐', 'Score · Instrumental']]);
    expect(audio[0]).toMatchObject({ kind: 'audio', references: 0, prompt: { minLength: 1, maxLength: 1000 } });
    expect(audio[0].params.map(param => param.name)).toEqual(['voice', 'speed', 'englishNormalization']);
    expect(audio[0].params[0].valueLabels).toEqual([['沉静女声', 'Calm woman'], ['少年骑士', 'Young knight']]);
    expect(mediaModelsOf(catalogue, 'image').map(model => model.id)).toEqual(['rh.seedream-v5-pro']);
    expect(mediaKindOf('audio')).toBe('audio');
  });

  it('keeps an audio node on its model where the workspace is offered only the other audio model', () => {
    const onlyMusic = parseMediaCatalogue({ ...rawCatalogue, models: rawCatalogue.models.filter(model => model.id !== 'rh.minimax-speech-2-8-hd') });
    expect(replacementMediaModel(onlyMusic, 'audio', 'rh.minimax-speech-2-8-hd')).toBeNull();
    expect(replaceRetiredMediaModels(sanitizeDocument({ nodes: [voice('vo')], edges: [] }), onlyMusic)).toBeNull();
    // RunningHub's image models are still moved to an offered one, as before.
    const otherImage = parseMediaCatalogue({ ...rawCatalogue, models: [...rawCatalogue.models.filter(model => model.kind !== 'image'),
      { id: 'xt.seedream-5-pro', name: '图片', vendor: 'media', kind: 'image', mode: 'text-to-image', prompt: { minLength: 1, maxLength: 5000 }, params: [] }] });
    expect(replacementMediaModel(otherImage, 'image', 'rh.seedream-v5-pro')).toBe('xt.seedream-5-pro');
  });
});

describe('audio nodes on the canvas', () => {
  it('keeps an audio node and types its result audio, with no reference input', () => {
    const document = sanitizeDocument({ version: 2, nodes: [{ ...voice('vo'), mediaParams: { voice: 'Young_Knight' } }, page('page')],
      edges: [wire('vo', 'page', 'context')], waypoints: [], view: null });
    const node = document.nodes[0] as SessionNode;
    expect(node.agentKind).toBe('audio');
    expect(node.mediaParams).toEqual({ voice: 'Young_Knight' });
    expect(portsFor(node).map(port => `${port.side}:${port.id}:${port.dataType}`)).toEqual(['input:context:text', 'output:result:audio']);
    // The wire into the page's context survives, keeping its source's type.
    expect(document.edges).toEqual([expect.objectContaining({ fromNode: 'vo', toNode: 'page', dataType: 'audio' })]);
  });

  it('feeds a page like a video does, softly, and a video node’s voices, but no picture input', () => {
    const vo = voice('vo');
    const target = page('page');
    const hero = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'hero' };
    const shot = { ...createSessionNode('video', { x: 700, y: 0 }), id: 'shot' };
    expect(canConnect([vo, target], [], { nodeId: 'vo', portId: 'result' }, { nodeId: 'page', portId: 'context' })).toBe(true);
    expect(isSoftMediaFeed(vo, target, { fromPort: 'result', toPort: 'context' })).toBe(true);
    // A voice wired into a video is that video's own input, as a wired picture is, never a soft feed.
    expect(canConnect([vo, shot], [], { nodeId: 'vo', portId: 'result' }, { nodeId: 'shot', portId: 'audio' })).toBe(true);
    expect(isSoftMediaFeed(vo, shot, { fromPort: 'result', toPort: 'audio' })).toBe(false);
    expect(canConnect([vo, shot], [], { nodeId: 'vo', portId: 'result' }, { nodeId: 'shot', portId: 'reference' })).toBe(false);
    expect(canConnect([vo, hero], [], { nodeId: 'vo', portId: 'result' }, { nodeId: 'hero', portId: 'reference' })).toBe(false);
    expect(canConnect([vo, hero], [], { nodeId: 'hero', portId: 'result' }, { nodeId: 'vo', portId: 'reference' })).toBe(false);
  });
});

describe('audio results', () => {
  it('reads only audio files in an audio record', () => {
    expect(parseMediaOutput(record())?.kind).toBe('audio');
    expect(parseMediaOutput(record('audio/wav'))?.items[0].contentType).toBe('audio/wav');
    expect(parseMediaOutput(record('image/png'))).toBeNull();
    expect(parseMediaOutput(record('audio/ogg'))).toBeNull();
    // An image record never carries audio.
    expect(parseMediaOutput(record('audio/mpeg', 'image'))).toBeNull();
  });

  it('plays a generated sound with the browser player, with its download', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    render(<MediaResult output={parseMediaOutput(record())!} />);
    expect(screen.getByText('已生成 1 段音频')).toBeInTheDocument();
    const player = screen.getByLabelText('播放 audio-1.mp3');
    expect(player.tagName).toBe('AUDIO');
    expect(player).toHaveAttribute('controls');
    expect(player).toHaveAttribute('src', '/api/v1/tenants/tenant-a/artifacts/aBCDEFGHIJ0123456789_-/media');
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('href', '/api/v1/tenants/tenant-a/artifacts/aBCDEFGHIJ0123456789_-');
  });

  it('tells a page the file and how to play it, and nothing of the kind for a picture', () => {
    const text = mediaDeliveryText(voice('vo_lark_1'), record());
    expect(text).toContain('「云雀」生成的音频文件');
    expect(text).toContain('- vo_lark_1/audio-1.mp3（audio/mpeg，4106 字节）');
    expect(text).toContain(MEDIA_AUDIO_PAGE_RULE);
    expect(MEDIA_AUDIO_PAGE_RULE).toContain('<audio>');
    expect(MEDIA_AUDIO_PAGE_RULE).toContain('new Audio(');
    const picture = JSON.stringify({ type: 'awwo.media', version: 1, kind: 'image', model: 'rh.seedream-v5-pro',
      items: [{ artifactId: 'aAAAAAAAAAAA', name: 'image-1.png', contentType: 'image/png', size: 10 }] });
    expect(mediaDeliveryText({ id: 'hero', title: 'Hero' }, picture)).not.toContain(MEDIA_AUDIO_PAGE_RULE);
    expect(mediaMissingText(voice('vo'))).toContain('这次没有生成出音频文件');
  });

  it('hands a page wired from an audio node the audio rule when the canvas runs', async () => {
    const messages: Record<string, string> = {};
    await runGraph({
      nodes: [voice('vo'), page('page')],
      edges: [wire('vo', 'page', 'context')],
      execAgent: async (node, message) => {
        messages[node.id] = message;
        return node.id === 'vo' ? { ok: true, output: record() } : { ok: true, output: 'PAGE' };
      },
      onStatus: () => {},
    });
    expect(messages.page).toContain('- vo/audio-1.mp3（audio/mpeg，4106 字节）');
    expect(messages.page).toContain(MEDIA_AUDIO_PAGE_RULE);
    expect(messages.page).not.toContain('aBCDEFGHIJ0123456789_-');
  });
});

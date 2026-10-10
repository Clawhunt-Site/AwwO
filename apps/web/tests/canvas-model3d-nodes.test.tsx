import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSessionNode, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { portsFor } from '../src/canvas/ports';
import { mediaKindOf, mediaModelsOf, mediaVendorLabel, parseMediaCatalogue } from '../src/canvas/mediaCatalog';
import { parseMediaOutput } from '../src/canvas/mediaOutput';
import { MediaResult } from '../src/canvas/MediaResult';
import { withAgentKind } from '../src/canvas/MediaNodeSettings';
import { AddNodeMenu } from '../src/canvas/AddNodeMenu';
import { deliveredItems } from '../src/canvas/canvasResultModel';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearSaaSCanvas(); });
const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };

const raw = {
  provider: 'runninghub', configured: true, available: true, limits: { runsPerDay: 30, timeoutSeconds: 1200 },
  models: [
    { id: 'tripo.v3-1', name: 'Tripo v3.1 · 高精度模型', vendor: 'tripo', kind: 'model3d', mode: 'text-to-model3d', provider: 'tripo',
      prompt: { minLength: 1, maxLength: 1024 }, params: [
        { name: 'texture', type: 'boolean', default: true, label: ['生成贴图', 'Texture'] },
        { name: 'textureQuality', type: 'enum', values: ['standard', 'detailed'], default: 'standard', label: ['贴图质量', 'Texture quality'] },
      ] },
    { id: 'rh.seedream-v5-pro', name: 'Seedream', vendor: 'bytedance', kind: 'image', mode: 'text-to-image', prompt: { minLength: 1, maxLength: 2000 }, params: [] },
  ],
};
const glb = { artifactId: 'aModel0123456789', name: 'model-1.glb', contentType: 'model/gltf-binary', size: 4096 };
const picture = { artifactId: 'aPreview012345678', name: 'preview-2.webp', contentType: 'image/webp', size: 2048 };
const output = JSON.stringify({ type: 'awwo.media', version: 1, kind: 'model3d', model: 'tripo.v3-1', items: [glb, picture] });

describe('3D model nodes', () => {
  it('reads Tripo models from the catalogue as their own kind', () => {
    const catalogue = parseMediaCatalogue(raw);
    expect(mediaModelsOf(catalogue, 'model3d').map(model => model.id)).toEqual(['tripo.v3-1']);
    expect(mediaModelsOf(catalogue, 'image').map(model => model.id)).toEqual(['rh.seedream-v5-pro']);
    expect(mediaVendorLabel('tripo', 'zh')).toBe('Tripo 3D');
    expect(parseMediaCatalogue({ ...raw, models: [{ ...raw.models[0], id: 'evil.model' }] }).models).toEqual([]);
  });

  it('keeps a 3D node in a saved canvas, its result typed as a file', () => {
    const node = { ...createSessionNode('model3d', { x: 0, y: 0 }), model: 'tripo.v3-1' };
    const doc = sanitizeDocument({ version: 1, nodes: [node], edges: [] });
    expect((doc!.nodes[0] as SessionNode).agentKind).toBe('model3d');
    expect(mediaKindOf('model3d')).toBe('model3d');
    expect(portsFor(node).find(port => port.id === 'result')).toMatchObject({ side: 'output', dataType: 'file' });
    const switched = withAgentKind({ ...createSessionNode('llm', { x: 0, y: 0 }) }, 'model3d', parseMediaCatalogue(raw));
    expect(switched).toMatchObject({ agentKind: 'model3d', model: 'tripo.v3-1' });
  });

  it('reads a 3D media record with its model and preview, and nothing else', () => {
    expect(parseMediaOutput(output)).toMatchObject({ kind: 'model3d', items: [glb, picture] });
    const video = JSON.stringify({ type: 'awwo.media', version: 1, kind: 'model3d', model: 'tripo.v3-1', items: [{ ...glb, contentType: 'video/mp4' }] });
    expect(parseMediaOutput(video)).toBeNull();
  });

  it('shows the rendered picture, turns the model in the viewer on request, and offers the GLB', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const fetch = vi.fn(async () => new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<MediaResult output={parseMediaOutput(output)!} />);
    expect(screen.getByText('已生成 1 个 3D 模型')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'model-1.glb 的渲染预览' })).toHaveAttribute('src', expect.stringContaining('/artifacts/aPreview012345678/media'));
    expect(screen.getByRole('link', { name: /下载 model-1\.glb（GLB）/ })).toHaveAttribute('href', expect.stringContaining('/artifacts/aModel0123456789'));
    fireEvent.click(screen.getByRole('button', { name: '旋转查看 3D 模型' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/artifacts/aModel0123456789'), expect.anything()));
  });

  it('lists a generated model among everything the canvas made', () => {
    const node = { ...createSessionNode('model3d', { x: 0, y: 0 }), id: 'hero', title: '曙光·脉冲 3D', model: 'tripo.v3-1',
      lastOutput: { text: output, at: 1, source: 'run' as const } };
    expect(deliveredItems({ nodes: [node], edges: [] }).map(item => [item.kind, item.name])).toEqual([['model', 'model-1.glb'], ['image', 'preview-2.webp']]);
  });

  it('offers 3D model generation in the add menu when the host can run it', () => {
    const pick = vi.fn();
    render(<AddNodeMenu at={{ x: 0, y: 0 }} onPick={pick} onClose={vi.fn()} mediaKinds={['image', 'model3d']} />);
    fireEvent.click(screen.getByRole('menuitem', { name: '3D 模型生成' }));
    expect(pick).toHaveBeenCalledWith('model3d');
  });
});

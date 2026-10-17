import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSessionNode, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { portsFor } from '../src/canvas/ports';
import { invalidMediaParams, mediaGroupLabel, mediaKindOf, mediaModelsOf, mediaValueLabel, parseMediaCatalogue, withMediaChoice } from '../src/canvas/mediaCatalog';
import { mediaDeliveryText, parseMediaOutput } from '../src/canvas/mediaOutput';
import { MediaResult, mediaOutputCount } from '../src/canvas/MediaResult';
import { MediaNodeSettings, withAgentKind } from '../src/canvas/MediaNodeSettings';
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
    expect(mediaGroupLabel('zh')).toBe('媒体');
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

// The rig and animation settings as the API publishes them for both 3D models (tripo_motion.go).
const rig = { name: 'rig', type: 'enum', values: ['none', 'biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic'], default: 'none',
  label: ['骨骼', 'Skeleton'], valueLabels: [['无', 'None'], ['双足', 'Biped'], ['四足', 'Quadruped'], ['六足', 'Hexapod'], ['八足', 'Octopod'], ['鸟类', 'Bird'],
    ['蛇形', 'Serpent'], ['水生', 'Aquatic']] };
const motion = { name: 'motion', type: 'enum', values: ['none', 'locomotion', 'combat', 'full'], default: 'none', label: ['动作', 'Animations'],
  valueLabels: [['不加', 'None'], ['移动', 'Locomotion'], ['战斗', 'Combat'], ['全套', 'Full set']],
  requires: { param: 'rig', values: ['biped', 'quadruped', 'hexapod', 'octopod', 'serpentine', 'aquatic'] } };
const inPlace = { name: 'inPlace', type: 'boolean', default: true, label: ['原地动作', 'Animate in place'], requires: { param: 'motion', values: ['locomotion', 'combat', 'full'] } };
const motionRaw = (params: unknown[], extra: Record<string, unknown> = {}) => ({ ...raw, models: [{ ...raw.models[0], params: [...raw.models[0].params, ...params], ...extra }] });
const animatedOutput = JSON.stringify({ type: 'awwo.media', version: 1, kind: 'model3d', model: 'tripo.p1', items: [
  { ...glb, size: 5501312, animations: ['hurt', 'idle', 'run', 'slash', 'walk'] },
  { artifactId: 'aClips0123456789', name: 'model-2.glb', contentType: 'model/gltf-binary', size: 812345, animations: ['climb', 'dive', 'fall', 'jump', 'turn'], clipsOnly: true },
  { artifactId: 'aShoot012345678', name: 'model-3.glb', contentType: 'model/gltf-binary', size: 98765, animations: ['shoot'], clipsOnly: true },
  { ...picture, name: 'preview-4.webp' }] });

describe('rigged and animated 3D models', () => {
  it('reads the skeleton and animation settings with their value names and dependencies, and drops a model whose rules cannot be read', () => {
    const model = parseMediaCatalogue(motionRaw([rig, motion, inPlace])).models[0];
    expect(model.params.map(param => param.name)).toEqual(['texture', 'textureQuality', 'rig', 'motion', 'inPlace']);
    expect(model.params[3]).toMatchObject({ requires: { param: 'rig', values: rig.values.filter(value => value !== 'none' && value !== 'avian') } });
    expect(mediaValueLabel(model.params[2], 'avian', 'zh')).toBe('鸟类');
    expect(mediaValueLabel(model.params[2], 'avian', 'en')).toBe('Bird');
    expect(mediaValueLabel(model.params[1], 'detailed', 'zh')).toBe('detailed');
    for (const broken of [
      [rig, { ...motion, valueLabels: motion.valueLabels.slice(1) }],
      [{ ...motion, requires: { param: 'rig', values: ['biped'] } }, rig],
      [rig, { ...motion, requires: { param: 'rig', values: ['dragon'] } }],
      [rig, { ...motion, requires: { param: 'texture', values: ['true'] } }],
      [rig, { ...motion, requires: { param: 'rig', values: [] } }],
      [{ ...inPlace, valueLabels: [['是', 'Yes']] }],
      [{ name: 'note', type: 'text', maxLength: 10, label: ['备注', 'Note'], requires: { param: 'textureQuality', values: ['detailed'] } }],
    ]) expect(parseMediaCatalogue(motionRaw(broken)).models).toEqual([]);
    // A model may start from up to ten pictures (the API's own ceiling), never more.
    expect(parseMediaCatalogue(motionRaw([], { references: 9 })).models[0].references).toBe(9);
    expect(parseMediaCatalogue(motionRaw([], { references: 11 })).models[0].references).toBe(0);
  });

  it('refuses animations without a skeleton that has them, as admission does, and drops them when the skeleton goes', () => {
    const model = parseMediaCatalogue(motionRaw([rig, motion, inPlace])).models[0];
    expect(invalidMediaParams(model, { motion: 'combat' })).toEqual(['motion']);
    expect(invalidMediaParams(model, { rig: 'avian', motion: 'combat' })).toEqual(['motion']);
    expect(invalidMediaParams(model, { rig: 'biped', inPlace: false })).toEqual(['inPlace']);
    expect(invalidMediaParams(model, { rig: 'biped', motion: 'full', inPlace: false })).toEqual([]);
    const [rigParam] = model.params.filter(param => param.name === 'rig');
    expect(withMediaChoice(model, { rig: 'biped', motion: 'full', inPlace: false }, rigParam, 'none')).toEqual({});
    expect(withMediaChoice(model, { rig: 'biped', motion: 'full', inPlace: false }, rigParam, 'avian')).toEqual({ rig: 'avian' });
    expect(withMediaChoice(model, { rig: 'biped', motion: 'full' }, rigParam, 'quadruped')).toEqual({ rig: 'quadruped', motion: 'full' });
  });

  it('disables the animations until a skeleton that has them is chosen, says why, and clears them with it', () => {
    const catalogue = parseMediaCatalogue(motionRaw([rig, motion, inPlace]));
    const onChange = vi.fn();
    const node = (mediaParams?: Record<string, string | boolean>): SessionNode => ({ ...createSessionNode('model3d', { x: 0, y: 0 }), model: 'tripo.v3-1', ...(mediaParams ? { mediaParams } : {}) });
    const view = render(<MediaNodeSettings node={node()} state={{ status: 'ready', catalogue }} disabled={false} onChange={onChange} />);
    const rigSelect = screen.getByLabelText('骨骼') as HTMLSelectElement;
    expect([...rigSelect.options].map(option => option.textContent)).toEqual(['无（默认）', '双足', '四足', '六足', '八足', '鸟类', '蛇形', '水生']);
    expect(screen.getByLabelText('动作')).toBeDisabled();
    expect(screen.getByLabelText('动作')).toHaveAccessibleDescription('「骨骼」选为双足、四足、六足、八足、蛇形、水生时才能设置。');
    expect(screen.getByLabelText('原地动作')).toBeDisabled();
    fireEvent.change(rigSelect, { target: { value: 'biped' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mediaParams: { rig: 'biped' } }));
    view.rerender(<MediaNodeSettings node={node({ rig: 'biped' })} state={{ status: 'ready', catalogue }} disabled={false} onChange={onChange} />);
    expect(screen.getByLabelText('动作')).toBeEnabled();
    expect(screen.getByLabelText('原地动作')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('动作'), { target: { value: 'combat' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mediaParams: { rig: 'biped', motion: 'combat' } }));
    view.rerender(<MediaNodeSettings node={node({ rig: 'biped', motion: 'combat' })} state={{ status: 'ready', catalogue }} disabled={false} onChange={onChange} />);
    expect(screen.getByLabelText('原地动作')).toBeEnabled();
    expect(screen.getByLabelText('原地动作')).toBeChecked();
    expect(screen.queryByText(/时才能设置/)).toBeNull();
    fireEvent.change(screen.getByLabelText('骨骼'), { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mediaParams: {} }));
  });

  it('reads the clips a GLB carries, and nothing that is not a GLB\'s plain clip names', () => {
    const output = parseMediaOutput(animatedOutput)!;
    expect(output.items.map(item => [item.name, item.animations ?? null, item.clipsOnly ?? false])).toEqual([
      ['model-1.glb', ['hurt', 'idle', 'run', 'slash', 'walk'], false], ['model-2.glb', ['climb', 'dive', 'fall', 'jump', 'turn'], true],
      ['model-3.glb', ['shoot'], true], ['preview-4.webp', null, false]]);
    expect(mediaOutputCount(output)).toBe(1);
    const items = JSON.parse(animatedOutput).items;
    for (const changed of [{ ...items[0], animations: ['two words'] }, { ...items[0], animations: [] }, { ...items[0], animations: '<b>' },
      { ...items[0], clipsOnly: false }, { ...items[3], animations: ['idle'] }, { ...items[3], clipsOnly: true }]) {
      expect(parseMediaOutput(JSON.stringify({ ...JSON.parse(animatedOutput), items: [changed] }))).toBeNull();
    }
  });

  it('shows one model with its clips and offers the clip files for its skeleton', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    render(<MediaResult output={parseMediaOutput(animatedOutput)!} />);
    expect(screen.getByText('已生成 1 个 3D 模型')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '旋转查看 3D 模型' })).toHaveLength(1);
    expect(screen.getByText('动画：hurt idle run slash walk')).toBeInTheDocument();
    expect(screen.getByText('model-2.glb：只有动画，骨骼与这个模型相同（climb dive fall jump turn）')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /下载 model-2\.glb（动画）/ })).toHaveAttribute('href', expect.stringContaining('/artifacts/aClips0123456789'));
    expect(screen.getByRole('link', { name: /下载 model-3\.glb（动画）/ })).toHaveAttribute('href', expect.stringContaining('/artifacts/aShoot012345678'));
  });

  it('hands a page the same file list the API writes, clips included', () => {
    expect(mediaDeliveryText({ id: 'hero', title: 'Hero' }, animatedOutput)).toBe([
      '「Hero」生成的3D 模型文件（存放在这张画布的成果里，这里只列文件，不含内容）：',
      '- hero/model-1.glb（model/gltf-binary，5501312 字节；动画：hurt idle run slash walk）',
      '- hero/model-2.glb（model/gltf-binary，812345 字节；只有动画，没有模型，骨骼与 hero/model-1.glb 相同；动画：climb dive fall jump turn）',
      '- hero/model-3.glb（model/gltf-binary，98765 字节；只有动画，没有模型，骨骼与 hero/model-1.glb 相同；动画：shoot）',
      '- hero/preview-4.webp（image/webp，2048 字节）',
      '网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。',
      '带动画的 GLB 用 THREE.AnimationMixer 按上面的动画名播放它的动画（gltf.animations）。只有动画的文件和 hero/model-1.glb 是同一副骨骼：加载它只取动画，按骨骼名用到 hero/model-1.glb 的场景上。',
    ].join('\n'));
    // A static model's lines stay as they were.
    expect(mediaDeliveryText({ id: 'hero', title: 'Hero' }, output).split('\n')).toEqual([
      '「Hero」生成的3D 模型文件（存放在这张画布的成果里，这里只列文件，不含内容）：',
      '- hero/model-1.glb（model/gltf-binary，4096 字节）', '- hero/preview-2.webp（image/webp，2048 字节）',
      '网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。']);
  });
});

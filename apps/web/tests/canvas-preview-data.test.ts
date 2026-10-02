import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { PREVIEW_LIMITS, previewKind, previewText, readPreviewBlob, safeSourcePath, SOURCE_FILE_LIMIT, unzipPreview, validateModel } from '../src/canvas/previewData';
import { previewSample } from '../src/canvas/previewSamples';
import { readArtifactPreview } from '../src/canvas/ArtifactPreview';

const signal = () => new AbortController().signal;
const gltf = (data: unknown) => ({ name: 'scene.gltf', bytes: strToU8(JSON.stringify(data)) });
describe('bounded preview data', () => {
  it.each([['site.HTML', 'html'], ['asset.GLB', 'model'], ['asset.gltf', 'model'], ['asset.obj', 'model'], ['report.pdf', 'pdf'], ['workspace.zip', 'ide'], ['src/main.tsx', 'ide'], ['image.png', null], ['payload.html.exe', null]])('classifies %s', (name, kind) => expect(previewKind(name!)).toBe(kind));
  it.each(['../secret.ts', '/root.ts', 'C:/root.ts', 'src/../root.ts', 'src\\root.ts', 'src//root.ts', '.env', 'file\0.ts'])('refuses unsafe ZIP path %s', path => expect(safeSourcePath(path)).toBe(false));
  it('loads real ZIP source files, retains paths and never returns binary assets', async () => {
    const entries = await unzipPreview(zipSync({ 'src/main.ts': strToU8('export const n = 1;'), 'README.md': strToU8('# Project'), 'photo.png': new Uint8Array([1, 2, 3]) }), signal());
    expect(entries).toEqual([{ path: 'README.md', source: '# Project' }, { path: 'src/main.ts', source: 'export const n = 1;' }]);
  });
  it('rejects path traversal and declared oversized inflation', async () => {
    await expect(unzipPreview(zipSync({ '../a.ts': strToU8('x') }), signal())).rejects.toThrow('路径');
    await expect(unzipPreview(zipSync({ 'large.ts': new Uint8Array(SOURCE_FILE_LIMIT + 1).fill(65) }), signal())).rejects.toThrow('2 MiB');
  });
  it('enforces actual inflated size even if local ZIP size is dishonest', async () => {
    const bytes = zipSync({ 'large.ts': new Uint8Array(SOURCE_FILE_LIMIT + 1).fill(65) });
    new DataView(bytes.buffer).setUint32(22, 1, true);
    await expect(unzipPreview(bytes, signal())).rejects.toThrow('超过');
  });
  it('rejects too many ZIP entries, malformed input, truncated ZIP and cancelled input', async () => {
    const entries = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}.ts`, strToU8('x')]));
    await expect(unzipPreview(zipSync(entries), signal())).rejects.toThrow('数量');
    await expect(unzipPreview(strToU8('not a ZIP'), signal())).rejects.toThrow('ZIP');
    const archive = zipSync({ 'f.ts': strToU8('some text that must finish') });
    await expect(unzipPreview(archive.subarray(0, 40), signal())).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(unzipPreview(archive, controller.signal)).rejects.toThrow('Aborted');
  });
  it('refuses invalid source UTF-8, control bytes and oversized source files', () => {
    expect(() => previewText(new Uint8Array([0xff]))).toThrow();
    expect(() => previewText(strToU8('text\0binary'))).toThrow('UTF-8');
    expect(() => previewText(new Uint8Array(SOURCE_FILE_LIMIT + 1))).toThrow('2 MiB');
  });
  it('reads local files and supports cancelled and overbudget reads', async () => {
    expect(new TextDecoder().decode(await readPreviewBlob(new Blob(['abc']), signal(), 5))).toBe('abc');
    await expect(readPreviewBlob(new Blob(['abcdef']), signal(), 5)).rejects.toThrow('上限');
    const controller = new AbortController(); controller.abort();
    await expect(readPreviewBlob(new Blob(['abc']), controller.signal, 5)).rejects.toThrow('Aborted');
  });
  it('accepts source-only OBJ demo, rejects material links and malformed geometry', () => {
    expect(validateModel(previewSample('model')).format).toBe('obj');
    expect(() => validateModel({ name: 'a.obj', bytes: strToU8('v 0 0 0\nf 1 1 1\nmtllib https://external.test/m.mtl') })).toThrow('外部材质');
    expect(() => validateModel({ name: 'a.obj', bytes: strToU8('garbage') })).toThrow('有效顶点');
  });
  it.each(['https://external.test/a.bin', '/api/private', 'blob:untrusted', 'file:///etc/passwd', 'data:text/html;base64,PHNjcmlwdD4='])('rejects model resource %s before loader execution', uri => {
    expect(() => validateModel(gltf({ asset: { version: '2.0' }, buffers: [{ uri, byteLength: 2 }] }))).toThrow();
  });
  it('rejects accessor bombs, graph cycles and malformed GLB headers', () => {
    expect(() => validateModel(gltf({ asset: { version: '2.0' }, accessors: [{ count: 999999999 }] }))).toThrow('accessor');
    expect(() => validateModel(gltf({ asset: { version: '2.0' }, nodes: [{ children: [1] }, { children: [0] }] }))).toThrow('循环');
    expect(() => validateModel({ name: 'x.glb', bytes: strToU8('not a glb') })).toThrow('GLB');
  });
  it('bounds actual repeated and instanced geometry rather than unique accessor counts alone', () => {
    const mesh = { primitives: [{ attributes: { POSITION: 0 } }] };
    expect(() => validateModel(gltf({ asset: { version: '2.0' }, accessors: [{ count: 1_000_000 }], meshes: [mesh], nodes: Array.from({ length: 4 }, () => ({ mesh: 0 })) }))).toThrow('实例展开');
    expect(() => validateModel(gltf({ asset: { version: '2.0' }, accessors: [{ count: 1_000_000 }, { count: 4 }], meshes: [mesh], nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } }] }))).toThrow('实例展开');
    expect(() => validateModel(gltf({ asset: { version: '2.0' }, nodes: [{}], scenes: [{ nodes: [0, 0] }] }))).toThrow('根节点');
  });
  it('bounds OBJ polygon triangulation before geometry allocation', () => {
    const polygon = `f ${Array.from({ length: 512 }, () => '1').join(' ')}\n`;
    expect(() => validateModel({ name: 'expanded.obj', bytes: strToU8(`v 0 0 0\n${polygon.repeat(2000)}`) })).toThrow('三角化');
  });
  it('validates embedded glTF buffers and a real GLB binary envelope', () => {
    expect(validateModel(gltf({ asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream;base64,AAAAAA==', byteLength: 4 }] })).format).toBe('gltf');
    const json = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] });
    const padded = strToU8(json.padEnd(Math.ceil(json.length / 4) * 4));
    const bytes = new Uint8Array(12 + 8 + padded.length + 8 + 4); const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true); view.setUint32(12, padded.length, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(padded, 20); view.setUint32(20 + padded.length, 4, true); view.setUint32(24 + padded.length, 0x004e4942, true);
    expect(validateModel({ name: 'x.glb', bytes }).source).toBeInstanceOf(ArrayBuffer);
  });
  it.each(['pdf', 'model', 'ide'] as const)('reads stored %s bytes under their format budget', async kind => {
    const sample = previewSample(kind);
    const content = await readArtifactPreview(new Response(sample.bytes.slice().buffer, { headers: { 'Content-Disposition': `attachment; filename="${sample.name}"` } }), signal());
    expect(content).toMatchObject({ type: kind, name: sample.name });
    if (content !== 'unsupported' && 'file' in content) expect(Array.from(content.file.bytes)).toEqual(Array.from(sample.bytes));
    await expect(readArtifactPreview(new Response('', { headers: { 'Content-Disposition': `attachment; filename="${sample.name}"`, 'Content-Length': String(PREVIEW_LIMITS[kind] + 1) } }), signal())).rejects.toThrow('preview_too_large');
  });
});

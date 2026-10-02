import { Unzip, UnzipInflate } from 'fflate';
import { artifactImageType } from './artifactImage';

export type PreviewKind = 'html' | 'model' | 'pdf' | 'ide';
export interface PreviewFile { name: string; bytes: Uint8Array }
export interface SourceFile { path: string; source: string }
const MiB = 1024 * 1024;
export const PREVIEW_LIMITS = { html: 2 * MiB, model: 20 * MiB, pdf: 20 * MiB, ide: 8 * MiB } as const;
export const SOURCE_FILE_LIMIT = 2 * MiB;
export const SOURCE_TOTAL_LIMIT = 16 * MiB;
export const SOURCE_COUNT_LIMIT = 200;
const SOURCE_EXT = /\.(?:md|markdown|txt|text|[cm]?tsx?|[cm]?jsx?|jsonc?|css|scss|less|py|go|rs|java|c|h|cpp|hpp|swift|sh|sql|ya?ml|toml|xml|svg|csv|tsv|html?)$/i;

export function previewKind(name: string): PreviewKind | null {
  const path = name.split(/[?#]/)[0];
  if (/\.html?$/i.test(path)) return 'html';
  if (/\.(?:glb|gltf|obj)$/i.test(path)) return 'model';
  if (/\.pdf$/i.test(path)) return 'pdf';
  return /\.zip$/i.test(path) || SOURCE_EXT.test(path) || /(?:^|\/)(?:Dockerfile|Makefile|LICENSE|README)$/i.test(path) ? 'ide' : null;
}

export function previewText(bytes: Uint8Array): string {
  if (bytes.byteLength > SOURCE_FILE_LIMIT) throw new Error('单个源码文件超过 2 MiB 上限');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) throw new Error('文件不是有效的 UTF-8 源码');
  return source;
}

export function safeSourcePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !/^[/.]|[\\:\u0000-\u001f\u007f]/.test(path)
    && !path.split('/').some(part => part === '..' || part === '.' || part === '');
}

/** Streaming inflate enforces actual emitted bytes, not untrusted ZIP directory sizes. */
export async function unzipPreview(bytes: Uint8Array, signal: AbortSignal): Promise<SourceFile[]> {
  if (bytes.length > PREVIEW_LIMITS.ide) throw new Error('ZIP 超过 8 MiB 上限');
  if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw new Error('不是有效 ZIP 文件');
  let entries = 0; let total = 0; let pending = 0; let failure: Error | null = null;
  const files: SourceFile[] = []; const seen = new Set<string>();
  const active: Array<{ terminate: () => void }> = [];
  const stop = (error: Error) => { failure = error; for (const file of active) file.terminate(); };
  const unzip = new Unzip(file => {
    if (failure) return;
    const path = file.name.replace(/\/$/, '');
    if (++entries > SOURCE_COUNT_LIMIT || !safeSourcePath(path) || seen.has(path)) { stop(new Error('ZIP 文件数量、重复路径或路径范围不符合预览要求')); return; }
    seen.add(path);
    if (file.name.endsWith('/')) return;
    if (file.originalSize != null && file.originalSize > SOURCE_FILE_LIMIT) { stop(new Error('ZIP 中单个文件超过 2 MiB')); return; }
    const isSource = previewKind(path) === 'ide' && !/\.zip$/i.test(path) || previewKind(path) === 'html';
    // Unsupported/binary entries are never inflated.
    if (!isSource) return;
    let size = 0; const chunks: Uint8Array[] = []; pending++;
    active.push(file);
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) { stop(error); return; }
      size += chunk.length; total += chunk.length;
      if (size > SOURCE_FILE_LIMIT || total > SOURCE_TOTAL_LIMIT) { stop(new Error('ZIP 解压内容超过预览上限')); return; }
      chunks.push(chunk);
      if (final) {
        pending--;
        const data = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { data.set(part, offset); offset += part.length; }
        try { files.push({ path, source: previewText(data) }); }
        catch { /* A binary file disguised as source is omitted, never interpreted. */ }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const abort = () => stop(new DOMException('Aborted', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  const started = Date.now();
  try {
    // Small compressed chunks bound transient decoder output too (DEFLATE can
    // expand a 64 KiB input chunk by hundreds of times before ondata runs).
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      if (signal.aborted) abort();
      if (failure) throw failure;
      if (Date.now() - started > 8000) throw new Error('ZIP 解压超时');
      unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
      if (offset % 65536 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (failure) throw failure;
    if (pending) throw new Error('ZIP 数据不完整');
    if (!files.length) throw new Error('ZIP 中没有可预览的 UTF-8 源码');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  } finally { signal.removeEventListener('abort', abort); for (const file of active) file.terminate(); }
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value != null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
function embeddedData(uri: string): Uint8Array {
  const match = /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(uri);
  if (!match || match[1].length > 28 * MiB) throw new Error('3D 预览只接受内嵌 buffer 和 PNG/JPEG/WebP 贴图，不加载外链');
  const value = atob(match[1]);
  return Uint8Array.from(value, char => char.charCodeAt(0));
}

/** Validate the JSON before Three can resolve any URL or allocate accessor arrays. */
export function validateModel(file: PreviewFile): { format: 'obj' | 'gltf'; source: string | ArrayBuffer } {
  if (!file.bytes.length || file.bytes.length > PREVIEW_LIMITS.model) throw new Error('3D 文件为空或超过 20 MiB');
  if (/\.obj$/i.test(file.name)) {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    if (/\u0000/.test(source) || !/^v\s+[-\d.]/m.test(source) || !/^f\s+\d/m.test(source)) throw new Error('OBJ 需要有效顶点与面');
    if (/^\s*mtllib\s/m.test(source)) throw new Error('OBJ 外部材质不可加载，请导出为包含资源的 GLB');
    const lines = source.split('\n');
    if (lines.length > 300_000 || lines.some(line => line.length > 4096)) throw new Error('OBJ 顶点或面数量超过预览上限');
    let expandedVertices = 0;
    for (const line of lines) {
      if (!/^\s*[flp]\s/.test(line)) continue;
      const fields = line.trim().split(/\s+/);
      expandedVertices += fields[0] === 'f' ? Math.max(0, fields.length - 3) * 3 : (fields.length - 1) * 2;
      if (expandedVertices > 3_000_000) throw new Error('OBJ 三角化后的几何体超过预览上限');
    }
    return { format: 'obj', source };
  }
  let json: unknown; let binary: Uint8Array | undefined;
  const isGlb = /\.glb$/i.test(file.name);
  if (isGlb) {
    if (file.bytes.length < 20) throw new Error('GLB 文件头不完整');
    const view = new DataView(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== file.bytes.length) throw new Error('GLB 文件头无效');
    let offset = 12;
    while (offset + 8 <= file.bytes.length) {
      const length = view.getUint32(offset, true); const type = view.getUint32(offset + 4, true); offset += 8;
      if (offset + length > file.bytes.length || length % 4) throw new Error('GLB 分块无效');
      if (type === 0x4e4f534a && json === undefined) json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes.subarray(offset, offset + length)));
      else if (type === 0x004e4942 && binary === undefined) binary = file.bytes.subarray(offset, offset + length);
      offset += length;
    }
    if (offset !== file.bytes.length) throw new Error('GLB 分块不完整');
  } else json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
  const root = record(json);
  if (record(root.asset).version !== '2.0') throw new Error('只支持 glTF 2.0');
  // Walk iteratively so deeply nested or huge JSON cannot overflow the validator stack.
  const stack: unknown[] = [root]; let count = 0;
  while (stack.length) {
    const item = stack.pop();
    if (++count > 100_000) throw new Error('glTF 结构超过预览上限');
    if (Array.isArray(item)) { for (const value of item) stack.push(value); }
    else if (item && typeof item === 'object') for (const [key, value] of Object.entries(item)) {
      if (key === 'uri') { if (typeof value !== 'string') throw new Error('glTF URI 无效'); embeddedData(value); }
      else stack.push(value);
    }
  }
  const list = (key: string, max: number): JsonRecord[] => {
    const value = root[key] ?? [];
    if (!Array.isArray(value) || value.length > max) throw new Error(`glTF ${key} 超过预览上限`);
    return value.map(record);
  };
  const nodes = list('nodes', 512);
  const parents = new Set<number>();
  nodes.forEach((node, index) => {
    if (node.children === undefined) return;
    if (!Array.isArray(node.children) || node.children.length > 512) throw new Error('glTF 子节点无效');
    for (const child of node.children) {
      if (!Number.isSafeInteger(child) || child < 0 || child >= nodes.length || child === index || parents.has(child)) throw new Error('glTF 节点需要无循环的树结构');
      parents.add(child);
    }
  });
  const visiting = new Set<number>(); const visited = new Set<number>();
  const visit = (index: number, depth: number) => {
    if (visiting.has(index) || depth > 64) throw new Error('glTF 节点循环或层数超过上限');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const child of (nodes[index].children ?? []) as number[]) visit(child, depth + 1);
    visiting.delete(index); visited.add(index);
  };
  nodes.forEach((_, index) => visit(index, 0));
  const meshes = list('meshes', 256);
  let primitives = 0;
  for (const mesh of meshes) {
    if (!Array.isArray(mesh.primitives) || (primitives += mesh.primitives.length) > 512) throw new Error('glTF 图元超过预览上限');
  }
  list('materials', 256); list('textures', 32);
  const accessors = list('accessors', 2048);
  let vertices = 0;
  for (const accessor of accessors) {
    if (!Number.isSafeInteger(accessor.count) || Number(accessor.count) < 0 || Number(accessor.count) > 1_000_000) throw new Error('glTF accessor 数量无效');
    vertices += Number(accessor.count);
  }
  if (vertices > 3_000_000) throw new Error('glTF 顶点总量超过预览上限');
  const accessorCount = (index: unknown) => {
    if (!Number.isSafeInteger(index) || Number(index) < 0 || !accessors[Number(index)]) throw new Error('glTF accessor 引用无效');
    return Number(accessors[Number(index)].count);
  };
  const meshCosts = meshes.map(mesh => (mesh.primitives as unknown[]).reduce<number>((sum, value) => {
    const primitive = record(value);
    return sum + accessorCount(primitive.indices ?? record(primitive.attributes).POSITION);
  }, 0));
  let expandedVertices = 0; let expandedPrimitives = 0;
  for (const node of nodes) {
    if (node.mesh === undefined) continue;
    if (!Number.isSafeInteger(node.mesh) || Number(node.mesh) < 0 || !meshes[Number(node.mesh)]) throw new Error('glTF mesh 引用无效');
    let instances = 1;
    const instancing = record(record(node.extensions).EXT_mesh_gpu_instancing);
    if (Object.keys(instancing).length) {
      const counts = Object.values(record(instancing.attributes)).map(accessorCount);
      if (!counts.length || counts.some(count => count !== counts[0])) throw new Error('glTF 实例数量无效');
      instances = counts[0];
    }
    expandedVertices += meshCosts[Number(node.mesh)] * instances;
    expandedPrimitives += (meshes[Number(node.mesh)].primitives as unknown[]).length;
    if (expandedVertices > 3_000_000 || expandedPrimitives > 2048) throw new Error('glTF 实例展开后的几何体超过预览上限');
  }
  for (const scene of list('scenes', 16)) {
    const roots = scene.nodes ?? [];
    if (!Array.isArray(roots) || roots.length > 512 || new Set(roots).size !== roots.length
      || roots.some(index => !Number.isSafeInteger(index) || Number(index) < 0 || !nodes[Number(index)] || parents.has(Number(index)))) throw new Error('glTF 场景根节点无效');
  }
  let bufferTotal = 0;
  const buffers = list('buffers', 32).map((buffer, index) => {
    const size = Number(buffer.byteLength);
    if (!Number.isSafeInteger(size) || size < 0 || (bufferTotal += size) > 32 * MiB) throw new Error('glTF buffer 超过预览上限');
    const data = typeof buffer.uri === 'string' ? embeddedData(buffer.uri) : index === 0 ? binary : undefined;
    if (!data || data.length < size) throw new Error('glTF 缺少内嵌 buffer');
    return data;
  });
  const views = list('bufferViews', 2048);
  for (const image of list('images', 32)) {
    const view = views[Number(image.bufferView)];
    const buffer = view ? buffers[Number(view.buffer)] : undefined;
    const data = typeof image.uri === 'string' ? embeddedData(image.uri) : buffer?.subarray(Number(view.byteOffset ?? 0), Number(view.byteOffset ?? 0) + Number(view.byteLength));
    if (!data || !['png', 'jpg', 'webp'].some(ext => artifactImageType(`texture.${ext}`, data))) throw new Error('glTF 贴图格式或尺寸不受支持');
  }
  return { format: 'gltf', source: isGlb ? file.bytes.slice().buffer as ArrayBuffer : JSON.stringify(json) };
}

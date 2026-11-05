// Shared by the publish scripts: identifier redaction, an agent's GLB and pictures as published, and the TypeScript
// module writer.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// A Windows drive path such as C:/tmp/…, optionally behind a leading slash; never the scheme of a URL.
const DRIVE = String.raw`(?<![A-Za-z0-9])\/?[A-Za-z]:\/(?!\/)`;
const ARTIFACT_PATH = new RegExp(String.raw`${DRIVE}[^\s)\]]*?\/(artifacts\/[^\s)\]]+)`, 'g');
const LOCAL_PATH = new RegExp(String.raw`${DRIVE}(?:[^\s)\]]*\/)?([^\s/)\]]+)`, 'g');

/** Keep a local file reference's artifacts/<file> tail (or its file name), drop the machine path, and hide identifiers. */
export function redact(value) {
  return value.replace(ARTIFACT_PATH, '$1').replace(LOCAL_PATH, '$1').replace(UUID, '…');
}

/** AwwO's own identifiers: a tenant's, run's, session's or stored file's ('a' and 32 URL-safe base64 characters), and a
 * workspace's (64 hex digits). */
const AWWO_ID = /(?<![A-Za-z0-9_-])a[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])|(?<![0-9A-Fa-f])[0-9a-f]{64}(?![0-9A-Fa-f])/;

/** Whether text names the run behind a file: a path in its workspace or AwwO's install, a stored file's reference,
 * Blender's mark of its scene file, an identifier of AwwO's (a tenant's, run's or workspace's, AWWO_ID; a canvas
 * node's, cv-…; the record's own `ids`) or any UUID (as redact() hides in text). In bytes (a binary chunk, a picture)
 * only those marks and the record's own `ids`: a pattern as loose as AWWO_ID would turn up in a mesh's own numbers (64
 * bytes of 0x66 are 64 hex digits), and pictures are encoded afresh (agentGlb), so they carry none. Not every path:
 * free text in a published model is kept out, not searched (agentGlb; review rounds 10 to 12). */
export function identifying(text, ids = [], binary = false) {
  if (binary) return /\/(?:workspace|inputs)\/|\/opt\/awwo|awwo-file:|Blender:File:/.test(text) || ids.some(id => text.includes(id));
  return /\/(?:workspace|inputs)\/|\/opt\/awwo|awwo-file:|\bcv-[0-9a-z]{6,}-[0-9a-z]+-[0-9a-z]+|Blender:File:|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)
    || AWWO_ID.test(text) || ids.some(id => text.includes(id));
}

// A published model's name, kept as it is (a page may look a clip or a bone up by it: Armature|idle, mixamorig:Hips,
// one of Blender's 255-byte names), unless it holds a path's separator or a control character (review rounds 13, 14).
const PLAIN_NAME = /^[^\/\\\p{Cc}]{1,1024}$/u;
// The keys a published model may hold (review rounds 13 to 16, where a key held a path, then gave a forged pointer a
// parent): glTF 2.0's properties and the known extensions'; in an attributes dictionary (a primitive's, a morph
// target's, instancing's) a semantic (POSITION, TEXCOORD_0, a custom _WIND.WEIGHT); in an extensions object a known
// extension's name.
const SCHEMA_KEYS = new Set(`asset accessors animations buffers bufferViews cameras images materials meshes nodes samplers scene scenes
  skins textures extensionsUsed extensionsRequired extensions generator version minVersion bufferView byteOffset componentType normalized
  count type max min sparse name indices values channels sampler target node path input interpolation output byteLength byteStride
  orthographic perspective xmag ymag zfar znear aspectRatio yfov mimeType pbrMetallicRoughness normalTexture occlusionTexture
  emissiveTexture emissiveFactor alphaMode alphaCutoff doubleSided baseColorFactor baseColorTexture metallicFactor roughnessFactor
  metallicRoughnessTexture index texCoord scale strength primitives weights attributes material mode targets camera children skin matrix
  mesh rotation translation magFilter minFilter wrapS wrapT source inverseBindMatrices skeleton joints lights light color intensity spot
  innerConeAngle outerConeAngle range emissiveStrength ior specularFactor specularTexture specularColorFactor specularColorTexture
  transmissionFactor transmissionTexture thicknessFactor thicknessTexture attenuationDistance attenuationColor clearcoatFactor
  clearcoatTexture clearcoatRoughnessFactor clearcoatRoughnessTexture clearcoatNormalTexture sheenColorFactor sheenColorTexture
  sheenRoughnessFactor sheenRoughnessTexture iridescenceFactor iridescenceTexture iridescenceIor iridescenceThicknessMinimum
  iridescenceThicknessMaximum iridescenceThicknessTexture anisotropyStrength anisotropyRotation anisotropyTexture dispersion
  diffuseTransmissionFactor diffuseTransmissionTexture diffuseTransmissionColorFactor diffuseTransmissionColorTexture diffuseFactor
  diffuseTexture glossinessFactor specularGlossinessTexture variants mappings offset buffer pointer`.split(/\s+/));
// A still model's vertex attributes: glTF's own for a mesh one draws (review round 27: three.js lowercases a custom
// `_NAME`, so `_MARK` and `_mark` were one attribute and the other's bytes were kept unread; and it reads a matrix-typed
// attribute's components without its column padding, which zeroing changed). No custom, joint or weight attribute.
const ATTRIBUTE_KEY = /^(?:POSITION|NORMAL|TANGENT|TEXCOORD_(?:0|[1-9]\d{0,2})|COLOR_(?:0|[1-9]\d{0,2}))$/;
// The document's own keys: glTF 2.0's root properties.
const ROOT_KEYS = new Set(['asset', 'accessors', 'animations', 'buffers', 'bufferViews', 'cameras', 'images', 'materials', 'meshes', 'nodes',
  'samplers', 'scene', 'scenes', 'skins', 'textures', 'extensionsUsed', 'extensionsRequired', 'extensions']);
// Every string a published model may hold besides its names, by its place (the keys down to it, `[]` for an array's
// items) and what it may be there: glTF's and the known extensions' enums, the versions and the generator, and the
// extension lists (review rounds 14 and 15: a known extension's unknown field, and a pointer key elsewhere, held a
// path). Anything else stops the publish.
const STRING_PLACES = new Map([
  ['asset.version', /^\d+\.\d+$/], ['asset.minVersion', /^\d+\.\d+$/], ['asset.generator', /^AwwO$/],
  ['extensionsUsed[]', /^[A-Za-z0-9_]+$/], ['extensionsRequired[]', /^[A-Za-z0-9_]+$/],
  ['accessors[].type', /^(?:SCALAR|VEC[234])$/],
  ['cameras[].type', /^(?:perspective|orthographic)$/],
  ['extensions.KHR_lights_punctual.lights[].type', /^(?:directional|point|spot)$/],
  ['images[].mimeType', /^image\/(?:png|jpeg|ktx2|webp|avif)$/],
  ['materials[].alphaMode', /^(?:OPAQUE|MASK|BLEND)$/],
]);
// The extensions a published model may use, Khronos's and the common EXT ones, whose strings are names (renamed as
// any name) or structure (enums); KHR_xmp_json_ld's metadata is taken out instead. Compressed geometry is not among
// them: a Draco stream can carry metadata (review round 19), and a meshopt stream unused table entries (round 21),
// bytes agentGlb cannot clean without decoding them; and neither the homepage's model viewer nor a case page's
// three.js sets a Draco or meshopt decoder, so neither would load such a model anyway. Nor is KHR_animation_pointer: a
// published model is still (agentGlb). Nor is EXT_mesh_gpu_instancing: three.js leaves a points or lines mesh's
// instances unread (review round 25), and a still case's pieces need none. Nor are the material extensions some of
// whose textures three.js r186 does not load (review round 26, where a picture nothing loads kept a path):
// specular-glossiness and diffuse transmission (it has no loader for them), variants (no variant but the default is
// shown), unlit (only the base colour's texture is read); nor textures that are not PNG or JPEG, which AwwO does not
// encode afresh.
const KNOWN_EXTENSIONS = new Set(['KHR_lights_punctual', 'KHR_materials_anisotropy', 'KHR_materials_clearcoat',
  'KHR_materials_dispersion', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence',
  'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_mesh_quantization',
  'KHR_texture_transform', 'KHR_xmp_json_ld']);
// Where a material of those extensions names a texture (its textureInfo), each loaded by three.js r186.
const MATERIAL_TEXTURES = ['normalTexture', 'occlusionTexture', 'emissiveTexture', 'pbrMetallicRoughness.baseColorTexture',
  'pbrMetallicRoughness.metallicRoughnessTexture', 'extensions.KHR_materials_anisotropy.anisotropyTexture',
  'extensions.KHR_materials_clearcoat.clearcoatTexture', 'extensions.KHR_materials_clearcoat.clearcoatRoughnessTexture',
  'extensions.KHR_materials_clearcoat.clearcoatNormalTexture', 'extensions.KHR_materials_iridescence.iridescenceTexture',
  'extensions.KHR_materials_iridescence.iridescenceThicknessTexture', 'extensions.KHR_materials_sheen.sheenColorTexture',
  'extensions.KHR_materials_sheen.sheenRoughnessTexture', 'extensions.KHR_materials_specular.specularTexture',
  'extensions.KHR_materials_specular.specularColorTexture', 'extensions.KHR_materials_transmission.transmissionTexture',
  'extensions.KHR_materials_volume.thicknessTexture'].map(path => path.split('.'));

// An accessor's component sizes by componentType, and components by type.
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

const item = (list, index) => (Array.isArray(list) && Number.isInteger(index) && list[index] && typeof list[index] === 'object' ? list[index] : undefined);
const each = value => (Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object') : []);

// The keys that name an item of a list, wherever they are (glTF 2.0's references, the known extensions' textureInfo
// `index` included), each with the list it names, and the lists of items (a scene's nodes, a node's children).
const REFERENCE_KEYS = new Map([['scene', 'scenes'], ['mesh', 'meshes'], ['camera', 'cameras'], ['material', 'materials'],
  ['indices', 'accessors'], ['source', 'images'], ['sampler', 'samplers'], ['index', 'textures'], ['bufferView', 'bufferViews'],
  ['buffer', 'buffers'], ['light', 'lights']]);
const REFERENCE_LISTS = new Set(['nodes', 'children']);

/** The first reference in `doc` that does not name an item of its list (a whole number from 0, below the list's
 * length; review rounds 28 and 29), by its place, or undefined: each of REFERENCE_KEYS, each item of REFERENCE_LISTS
 * below the root (a scene's nodes, a node's children; the root's `nodes` is the list of nodes itself), and each value
 * of an `attributes` dictionary (an accessor). A punctual light names one of the root's KHR_lights_punctual lights. */
function indexProblem(doc) {
  const sizes = { lights: listed(doc.extensions?.KHR_lights_punctual?.lights).length };
  const size = list => (list in sizes ? sizes[list] : listed(doc[list]).length);
  const names = (value, list) => Number.isInteger(value) && value >= 0 && value < size(list);
  let found;
  const walk = (value, place, parent) => {
    if (found !== undefined) return;
    if (Array.isArray(value)) { value.forEach((item, at) => walk(item, `${place}[${at}]`, parent)); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const at = place ? `${place}.${key}` : key;
      if (parent === 'attributes') { if (!names(item, 'accessors')) found = at; }
      else if (REFERENCE_KEYS.has(key) && (value !== doc || key === 'scene')) { if (!names(item, REFERENCE_KEYS.get(key))) found = at; }
      else if (REFERENCE_LISTS.has(key) && value !== doc) { if (!Array.isArray(item) || !item.every(index => names(index, 'nodes'))) found = at; }
      if (found !== undefined) return;
      if (item && typeof item === 'object') walk(item, at, key);
    }
  };
  walk(doc, '', '');
  return found;
}
const listed = value => (Array.isArray(value) ? value : []);

/** What a still model shows (agentGlb checks it has one scene, the default): that scene's nodes with all their children
 * (as three.js loads a scene), and the primitives of their meshes. */
function shownPrimitives(doc) {
  const reached = new Set();
  const visit = index => {
    const node = item(doc.nodes, index);
    if (!node || reached.has(index)) return;
    reached.add(index);
    (Array.isArray(node.children) ? node.children : []).forEach(visit);
  };
  const scene = item(doc.scenes, 0);
  (Array.isArray(scene?.nodes) ? scene.nodes : []).forEach(visit);
  return [...reached].flatMap(index => each(item(doc.meshes, doc.nodes[index].mesh)?.primitives));
}

/** The accessors a viewer of a still model reads (review rounds 22 to 25: one nothing used, an animation's sampler, an
 * ignored channel's, an unloaded joint child's and a points mesh's ignored instances kept a path): the attributes and
 * indices of the primitives its scene shows. agentGlb publishes still, uninstanced models of one scene, with no sparse
 * accessor, so no animation, skin, morph target, instance, other scene or sparse data reads anything more. */
function usedAccessors(doc) {
  const used = new Set();
  const add = value => { if (Number.isInteger(value)) used.add(value); };
  for (const primitive of shownPrimitives(doc)) {
    if (primitive.attributes && typeof primitive.attributes === 'object' && !Array.isArray(primitive.attributes)) Object.values(primitive.attributes).forEach(add);
    add(primitive.indices);
  }
  return used;
}

/** The pictures a viewer of a still model loads: those of the textures (MATERIAL_TEXTURES) of the materials its shown
 * primitives use. */
function shownPictures(doc) {
  const pictures = new Set();
  for (const primitive of shownPrimitives(doc)) {
    const material = item(doc.materials, primitive.material);
    for (const path of material ? MATERIAL_TEXTURES : []) {
      const info = path.reduce((value, key) => (value && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined), material);
      const source = item(doc.textures, info && typeof info === 'object' ? info.index : undefined)?.source;
      if (Number.isInteger(source)) pictures.add(source);
    }
  }
  return pictures;
}

/**
 * A GLB's binary chunk with every byte its document does not read set to zero (review round 20: a view nothing reads,
 * a gap between views or the chunk's tail held a path, which the scan of bytes for the run's marks does not see). What
 * a loader reads of it: the elements of each accessor the content uses (usedAccessors), `byteStride` apart (agentGlb
 * has refused matrix-typed accessors, whose column padding three.js reads as components, review round 27, and sparse
 * ones); each picture's view (agentGlb has refused any picture the scene does not show). A read past its view or the
 * chunk stops the publish.
 */
function zeroUnread(doc, data, reference) {
  const read = new Uint8Array(data.length);
  const refuse = what => { throw new Error(`${reference}: ${what}`); };
  const whole = value => Number.isInteger(value) && value >= 0;
  const view = index => {
    const value = Array.isArray(doc.bufferViews) && Number.isInteger(index) ? doc.bufferViews[index] : undefined;
    if (!value || typeof value !== 'object' || (value.buffer ?? 0) !== 0 || !whole(value.byteOffset ?? 0) || !whole(value.byteLength))
      refuse('a read of a view it does not have in its binary chunk');
    return value;
  };
  // `count` elements of `size` bytes (of `component`-byte components), `stride` apart, from `offset` in view `index`.
  // Placed as three.js r186 reads them (review round 31: a float accessor one byte off its alignment, and an interleaved
  // one whose view ends before the loader's slice of count × stride bytes, passed and failed to load): each start on a
  // whole component, a stride a whole number of components, and an interleaved accessor's whole slice in its view.
  const elements = (index, offset, count, size, stride = size, component = 1) => {
    const value = view(index);
    if (!whole(offset) || !whole(count) || !(size > 0) || !whole(stride) || stride < size) refuse('a read it cannot place');
    if (offset % component || ((value.byteOffset ?? 0) + offset) % component || stride % component) refuse('a read that is not aligned to its components');
    if (!count) refuse('a read of no elements, which glTF never has');
    if (offset + stride * (count - 1) + size > value.byteLength) refuse('a read past its view');
    if (stride !== size && Math.floor(offset / stride) * stride + stride * count > value.byteLength) refuse('an interleaved read past its view');
    const at = (value.byteOffset ?? 0) + offset;
    if (at + stride * (count - 1) + size > data.length) refuse('a read past its binary chunk');
    if (stride === size) read.fill(1, at, at + size * count);
    else for (let item = 0; item < count; item++) read.fill(1, at + item * stride, at + item * stride + size);
  };
  const used = usedAccessors(doc);
  for (const [number, accessor] of (Array.isArray(doc.accessors) ? doc.accessors : []).entries()) {
    if (!accessor || typeof accessor !== 'object' || !used.has(number)) continue;
    const component = COMPONENT_BYTES[accessor.componentType];
    const size = component * COMPONENTS[accessor.type];
    if (!(size > 0)) refuse('an accessor of a type a still model does not use');
    if (accessor.bufferView !== undefined)
      elements(accessor.bufferView, accessor.byteOffset ?? 0, accessor.count, size, view(accessor.bufferView).byteStride ?? size, component);
  }
  for (const image of Array.isArray(doc.images) ? doc.images : [])
    if (image && typeof image === 'object' && image.bufferView !== undefined) elements(image.bufferView, 0, 1, view(image.bufferView).byteLength);
  const out = Buffer.from(data);
  for (let at = 0; at < out.length; at++) if (!read[at]) out[at] = 0;
  return out;
}

/** Every identifier of AwwO's form a run record holds (its tenant, canvas, runs, sessions and stored files): what no
 * published file may name. */
export function recordIds(raw) {
  return [...new Set(JSON.stringify(raw).match(new RegExp(AWWO_ID.source, 'g')) ?? [])];
}

/**
 * An agent's GLB (a Blender maker's) as the homepage serves it, before publish-run.mjs's neutralGlb: self-contained (no
 * buffer or image outside the file, which a page with no network could not load either); its text kept only where it
 * is plain (review rounds 10 to 12, where every pattern for a path in free text let another form through or stopped a
 * sound model): no extras (where Blender keeps custom properties), no free-text copyright (a case's credits are its
 * page's), no XMP metadata, no extension AwwO does not know (one stops the publish), and every name plain (PLAIN_NAME)
 * and naming nothing of the run, else renamed by its kind and index; its pictures encoded afresh (`reencode(bytes,
 * mimeType, reference)`, publish-run.mjs's ffmpeg): what a picture's metadata can carry is never parsed, only left
 * behind; and every byte of its binary chunk that nothing reads zeroed (zeroUnread). A GLB whose strings or bytes still
 * name the run stops the publish. Still models only (review round 24): an animation, a skin or a morph target stops it
 * (rounds 15 to 24 each found another way one kept bytes no viewer shows, its pointers included), so what a viewer
 * reads is its scenes' nodes and their meshes.
 */
export function agentGlb(bytes, reference, ids = [], reencode = undefined) {
  const word = at => bytes.readUInt32LE(at);
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'glTF' || word(4) !== 2 || word(8) !== bytes.length) throw new Error(`${reference}: not a glTF 2.0 binary`);
  if (bytes.toString('latin1', 16, 20) !== 'JSON') throw new Error(`${reference}: its first chunk is not JSON`);
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + word(12)));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${reference}: its JSON chunk is not a glTF document`);
  // A well-formed document (review round 30: a null node, mesh or accessor, or a view without its buffer, passed and
  // then failed to load): every item of every list is an object, every mesh has a list of primitives, each with its
  // attributes, and every view names its buffer.
  const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  // glTF 2 (round 31: a missing asset, or a version three.js does not load, passed and failed to load).
  if (!object(doc.asset) || typeof doc.asset.version !== 'string' || !/^2\.\d+$/.test(doc.asset.version))
    throw new Error(`${reference}: it is not a glTF 2 document (its asset version); export the GLB again`);
  for (const key of ['scenes', 'nodes', 'meshes', 'accessors', 'bufferViews', 'buffers', 'materials', 'textures', 'images', 'samplers', 'cameras'])
    if (doc[key] !== undefined && (!Array.isArray(doc[key]) || !doc[key].every(object)))
      throw new Error(`${reference}: its ${key} are not a list of objects; export the GLB again`);
  if ((doc.meshes ?? []).some(mesh => !Array.isArray(mesh.primitives) || !mesh.primitives.every(primitive => object(primitive) && object(primitive.attributes))))
    throw new Error(`${reference}: a mesh whose primitives are not objects with attributes; export the GLB again`);
  if ((doc.bufferViews ?? []).some(view => view.buffer === undefined))
    throw new Error(`${reference}: a buffer view that names no buffer; export the GLB again`);
  // An empty list is none; anything else of an animation, a skin or shape keys (a mesh's or a node's weights, a
  // primitive's targets) is refused, whatever its form.
  const present = value => value !== undefined && !(Array.isArray(value) && value.length === 0);
  const listed = value => (Array.isArray(value) ? value : []);
  const moving = present(doc.animations) || present(doc.skins)
    || listed(doc.nodes).some(node => node && typeof node === 'object' && (node.skin !== undefined || node.weights !== undefined))
    || listed(doc.meshes).some(mesh => mesh && typeof mesh === 'object' && (mesh.weights !== undefined
      || listed(mesh.primitives).some(primitive => primitive && typeof primitive === 'object' && primitive.targets !== undefined)));
  if (moving) throw new Error(`${reference}: it is animated, skinned or has shape keys, and the homepage publishes still models only; export the GLB without animation, armature or shape keys`);
  delete doc.animations;
  delete doc.skins;
  // One scene, the default (review round 26: a GLB with none, which three.js loads nothing of, kept a path in a mesh;
  // a second scene is loaded but never shown). Blender exports the pieces in one.
  if (!Array.isArray(doc.scenes) || doc.scenes.length !== 1 || !item(doc.scenes, 0) || (doc.scene !== undefined && doc.scene !== 0))
    throw new Error(`${reference}: it does not have one scene that is its default; export the GLB's pieces in one scene`);
  // No sparse accessor (round 26: the data one replaced whole was kept). Blender writes none for a still mesh.
  if (listed(doc.accessors).some(accessor => accessor && typeof accessor === 'object' && accessor.sparse !== undefined))
    throw new Error(`${reference}: it has a sparse accessor, which the homepage does not publish; export the GLB without them`);
  // Triangles only (round 29: for points and lines three.js draws with a material of its own that reads only the base
  // colour's texture, so a normal map's picture was kept unread). Blender exports a still mesh's as triangles.
  const primitives = listed(doc.meshes).flatMap(mesh => (mesh && typeof mesh === 'object' ? listed(mesh.primitives) : []));
  if (primitives.some(primitive => primitive && typeof primitive === 'object' && primitive.mode !== undefined && primitive.mode !== 4))
    throw new Error(`${reference}: a primitive that is not triangles (points, lines, strips or fans), which the homepage does not publish; export the GLB as triangles`);
  // glTF's own vertex attributes only, and no matrix-typed accessor (round 27: a custom attribute three.js overwrote
  // kept its bytes; a matrix's column padding is read as components). Blender exports a still mesh's as these.
  const attributes = primitives
    .flatMap(primitive => (primitive && typeof primitive === 'object' && primitive.attributes && typeof primitive.attributes === 'object' ? Object.keys(primitive.attributes) : []));
  const custom = attributes.find(name => !ATTRIBUTE_KEY.test(name));
  if (custom !== undefined) throw new Error(`${reference}: a vertex attribute the homepage does not publish (${JSON.stringify(custom.slice(0, 40))}: only POSITION, NORMAL, TANGENT, TEXCOORD_n and COLOR_n); export the GLB without custom attributes`);
  if (listed(doc.accessors).some(accessor => accessor && typeof accessor === 'object' && /^MAT/.test(String(accessor.type))))
    throw new Error(`${reference}: it has a matrix-typed accessor, which a still model does not use; export the GLB without it`);
  // The binary chunk, a copy (its pictures are rewritten), and nothing after it: a chunk of any other kind carries
  // nothing a page loads.
  const after = bytes.subarray(20 + word(12));
  if (after.length && (after.length < 8 || after.toString('latin1', 4, 8) !== 'BIN\0' || after.readUInt32LE(0) > after.length - 8))
    throw new Error(`${reference}: its second chunk is not its binary chunk`);
  let data = after.length ? Buffer.from(after.subarray(8, 8 + after.readUInt32LE(0))) : Buffer.alloc(0);
  for (const kind of ['buffers', 'images']) for (const value of doc[kind] ?? [])
    if (value && typeof value === 'object' && 'uri' in value) throw new Error(`${reference}: its ${kind} name a file outside it; export the GLB with everything inside`);
  const strip = value => {
    if (Array.isArray(value)) value.forEach(strip);
    else if (value && typeof value === 'object') { delete value.extras; Object.values(value).forEach(strip); }
  };
  strip(doc);
  if (doc.asset && typeof doc.asset === 'object') {
    delete doc.asset.copyright;
    doc.asset.generator = 'AwwO';
  }
  // XMP metadata goes (its packets on the root, the index of one on any object), and with it its name in the lists.
  const unxmp = value => {
    if (Array.isArray(value)) value.forEach(unxmp);
    else if (value && typeof value === 'object') {
      if (value.extensions && typeof value.extensions === 'object') {
        delete value.extensions.KHR_xmp_json_ld;
        if (!Object.keys(value.extensions).length) delete value.extensions;
      }
      Object.values(value).forEach(unxmp);
    }
  };
  unxmp(doc);
  for (const list of ['extensionsUsed', 'extensionsRequired']) if (Array.isArray(doc[list])) {
    doc[list] = doc[list].filter(name => name !== 'KHR_xmp_json_ld');
    if (!doc[list].length) delete doc[list];
  }
  const named = new Set([...(doc.extensionsUsed ?? []), ...(doc.extensionsRequired ?? [])]);
  const extensions = value => {
    if (Array.isArray(value)) value.forEach(extensions);
    else if (value && typeof value === 'object') {
      if (value.extensions && typeof value.extensions === 'object') Object.keys(value.extensions).forEach(name => named.add(name));
      Object.values(value).forEach(extensions);
    }
  };
  extensions(doc);
  const unknown = [...named].filter(name => !KNOWN_EXTENSIONS.has(name));
  if (unknown.length) throw new Error(`${reference}: it uses ${unknown.join(', ')}, which AwwO does not publish; export the GLB without it`);
  // No null anywhere (review round 31: a material's `normalTexture: null` and a light list's null passed, then failed
  // to load): glTF's schema gives no property a null value. Checked once the extras and XMP metadata are gone.
  const nullAt = (value, place) => {
    if (value === null) return place || 'the document';
    if (Array.isArray(value)) { for (const [at, item] of value.entries()) { const found = nullAt(item, `${place}[${at}]`); if (found) return found; } }
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { const found = nullAt(item, place ? `${place}.${key}` : key); if (found) return found; }
    return '';
  };
  const nullPlace = nullAt(doc, '');
  if (nullPlace) throw new Error(`${reference}: ${nullPlace} is null, which glTF never has; export the GLB again`);
  // Every reference is an index (review round 28: three.js reads `POSITION: [0]` as accessor 0, a reference this file's
  // own reading skipped, so the shown geometry was zeroed): a whole number from 0 wherever one names an item. Checked
  // once the extras and XMP metadata, which may hold any keys, are gone.
  const badReference = indexProblem(doc);
  if (badReference) throw new Error(`${reference}: ${badReference} is not an index; export the GLB again`);
  // The scene's nodes form a tree (round 30: a node that is its own child sent three.js into endless recursion): no
  // node is reached twice from the scene's roots.
  const seen = new Set(), pending = [...listed(doc.scenes[0].nodes)];
  while (pending.length) {
    const index = pending.pop();
    if (seen.has(index)) throw new Error(`${reference}: its scene's nodes are not a tree (node ${index} is reached twice); export the GLB again`);
    seen.add(index);
    pending.push(...listed(doc.nodes[index].children));
  }
  // Every picture is one a material the scene shows uses (review round 26: a picture no material used survived its
  // encoding afresh with a path in its pixels' coding; encoding keeps what a picture shows, so one nothing shows goes
  // only by being refused).
  const shown = shownPictures(doc);
  const unshown = listed(doc.images).findIndex((image, index) => !shown.has(index));
  if (unshown >= 0) throw new Error(`${reference}: picture ${unshown} is not used by any material its scene shows; export the GLB without unused images`);
  // Every name in a list not plain, or naming the run, an extension's list too (KHR_lights_punctual's lights, a
  // variant), is renamed by the list's kind and its place there, never to a name the list keeps (review round 15).
  const singular = kind => (kind === 'meshes' ? 'mesh' : kind.replace(/s$/, ''));
  // A drive's relative path (C:scene.blend) has no separator: a name may hold none, at its start or after another
  // word (Armature|C:scene.blend), though mixamorig:Hips stays (review rounds 16 and 17).
  const plainName = name => typeof name === 'string' && PLAIN_NAME.test(name) && !/(?<![\p{L}\p{N}])[A-Za-z]:/u.test(name) && !identifying(name, ids);
  const rename = (value, kind) => {
    if (Array.isArray(value)) {
      const named = item => item && typeof item === 'object' && !Array.isArray(item) && 'name' in item;
      const taken = new Set(value.filter(item => named(item) && plainName(item.name)).map(item => item.name));
      value.forEach((item, index) => {
        if (named(item) && !plainName(item.name)) {
          let name = `${singular(kind)}_${index}`;
          for (let next = 2; taken.has(name); next++) name = `${singular(kind)}_${index}_${next}`;
          taken.add(name);
          item.name = name;
        }
        rename(item, kind);
      });
    } else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (item && typeof item === 'object') rename(item, key);
  };
  rename(doc, 'document');
  // Its pictures encoded afresh: each new one at the binary chunk's end, its old bytes zeroed, its view pointed at it.
  const images = (doc.images ?? []).filter(image => image && typeof image === 'object');
  if (images.length) {
    if (!reencode) throw new Error(`${reference}: it holds pictures, and nothing was given to encode them afresh`);
    // A buffer or view with an extension holds bytes this rewrite would neither clean nor keep whole (review round 5:
    // meshopt's compressed copy of a view's bytes). No known extension has one now (meshopt is refused, round 21); this
    // stops the publish should one be added.
    for (const kind of ['buffers', 'bufferViews']) for (const value of doc[kind] ?? [])
      if (value && typeof value === 'object' && value.extensions && Object.keys(value.extensions).length)
        throw new Error(`${reference}: it holds pictures and compressed or extended ${kind}, which AwwO does not rewrite; export without compression`);
    // Each picture's view once, its bytes copied before any are zeroed (two views may cover the same bytes).
    const pictures = new Map();
    for (const image of images) {
      if (!['image/png', 'image/jpeg'].includes(image.mimeType))
        throw new Error(`${reference}: a picture of type ${image.mimeType}, which AwwO does not encode afresh; export textures as PNG or JPEG`);
      const view = doc.bufferViews?.[image.bufferView];
      if (!view || (view.buffer ?? 0) !== 0) throw new Error(`${reference}: a picture outside its binary chunk`);
      const at = view.byteOffset ?? 0;
      if (!Number.isInteger(at) || !Number.isInteger(view.byteLength) || at < 0 || at + view.byteLength > data.length)
        throw new Error(`${reference}: a picture runs past its binary chunk`);
      const known = pictures.get(image.bufferView);
      if (known && known.mimeType !== image.mimeType) throw new Error(`${reference}: one picture read as two types`);
      if (!known) pictures.set(image.bufferView, { at, length: view.byteLength, mimeType: image.mimeType, bytes: Buffer.from(data.subarray(at, at + view.byteLength)) });
    }
    // A picture's bytes that anything else reads too (an accessor, a compressed mesh, another view over them) are
    // refused: zeroing them would zero that as well.
    const read = [];
    const walk = value => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        if (key === 'bufferView') read.push(item);
        walk(item);
      }
    };
    for (const [key, value] of Object.entries(doc)) if (key !== 'images') walk(value);
    for (const image of images) for (const [key, value] of Object.entries(image)) if (key !== 'bufferView') walk(value);
    if (read.some(index => pictures.has(index))) throw new Error(`${reference}: a picture's view is read as something else too`);
    (doc.bufferViews ?? []).forEach((view, index) => {
      if (pictures.has(index) || !view || typeof view !== 'object' || (view.buffer ?? 0) !== 0) return;
      const at = view.byteOffset ?? 0;
      for (const picture of pictures.values())
        if (at < picture.at + picture.length && picture.at < at + view.byteLength) throw new Error(`${reference}: a picture shares its bytes with other data`);
    });
    for (const picture of pictures.values()) data.fill(0, picture.at, picture.at + picture.length);
    const added = [];
    let end = data.length;
    for (const [index, picture] of pictures) {
      const fresh = reencode(picture.bytes, picture.mimeType, reference);
      const pad = (4 - (end % 4)) % 4;
      added.push(Buffer.alloc(pad), fresh);
      doc.bufferViews[index].byteOffset = end + pad;
      doc.bufferViews[index].byteLength = fresh.length;
      end += pad + fresh.length;
    }
    data = Buffer.concat([data, ...added]);
  }
  data = zeroUnread(doc, data, reference);
  if (data.length) {
    data = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    if (doc.buffers?.[0]) doc.buffers[0].byteLength = data.length;
  }
  const text = JSON.stringify(doc);
  // Each key and string as it is, not as JSON escapes it: what is left is names (plain now) and structure, which may
  // name nothing of the run.
  const texts = [];
  const gather = value => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(gather);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { texts.push(key); gather(item); }
  };
  gather(doc);
  // Every key is glTF's or a known extension's (SCHEMA_KEYS), a semantic in an attributes dictionary, or a known
  // extension's name in an extensions object: no key is free text, none builds a structure glTF does not have.
  const odd = [];
  const keysOf = (value, parent) => {
    if (Array.isArray(value)) value.forEach(item => keysOf(item, parent));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      const known = value === doc ? ROOT_KEYS.has(key) : parent === 'attributes' || parent === 'targets' ? ATTRIBUTE_KEY.test(key)
        : parent === 'extensions' ? KNOWN_EXTENSIONS.has(key) : SCHEMA_KEYS.has(key);
      if (!known) odd.push(key);
      keysOf(item, key);
    }
  };
  keysOf(doc, '');
  if (odd.length) throw new Error(`${reference}: its JSON chunk has a key AwwO does not publish (${JSON.stringify(odd[0].slice(0, 40))}); export the GLB without it`);
  // A string is a plain name (wherever it is: a name the renaming could not reach, the document's own, is checked
  // here) or one of STRING_PLACES' at its place. No field is free text.
  const loose = [];
  const strings = (value, place) => {
    if (typeof value === 'string') {
      const sound = /(?:^|\.)name$/.test(place) ? plainName(value) : STRING_PLACES.get(place)?.test(value) === true;
      if (!sound) loose.push(`${place}: ${JSON.stringify(value.slice(0, 40))}`);
    } else if (Array.isArray(value)) value.forEach(item => strings(item, `${place}[]`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) strings(item, place ? `${place}.${key}` : key);
  };
  strings(doc, '');
  if (loose.length) throw new Error(`${reference}: its JSON chunk has text AwwO does not publish (${loose.slice(0, 3).join('; ')}); export the GLB without it`);
  if (texts.some(value => identifying(value, ids))) throw new Error(`${reference}: its JSON chunk names a path, a stored file or an identifier`);
  if (identifying(data.toString('latin1'), ids, true)) throw new Error(`${reference}: its binary chunk names a path, a stored file or an identifier`);
  const plain = Buffer.from(text, 'utf8');
  const json = Buffer.concat([plain, Buffer.alloc((4 - (plain.length % 4)) % 4, 0x20)]);
  const bin = data.length ? Buffer.concat([Buffer.alloc(8), data]) : Buffer.alloc(0);
  if (data.length) { bin.writeUInt32LE(data.length, 0); bin.write('BIN\0', 4, 'latin1'); }
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + json.length + bin.length, 8);
  head.writeUInt32LE(json.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, json, bin]);
}

/**
 * Pictures encoded afresh by ffmpeg from their pixels alone, in `scratch`: no metadata, and no mark of the encoder's
 * (`+bitexact`), so the same picture is the same file. `encode(bytes, mimeType, reference, width)` writes the picture,
 * whatever it was, as `mimeType` (PNG, else JPEG): a GLB's texture as the type it was, at its size (agentGlb's
 * `reencode`), or with a width, an agent's picture as a JPEG at most that wide.
 */
export function picture(scratch) {
  let count = 0;
  return (bytes, mimeType, reference, width = 0) => {
    const png = mimeType === 'image/png';
    const source = path.join(scratch, `picture-${count}.in`), out = path.join(scratch, `picture-${count++}.${png ? 'png' : 'jpg'}`);
    fs.writeFileSync(source, bytes);
    // A picture with a colour profile, or tagged with another colour space than sRGB (a PNG's gAMA or cHRM), would show
    // other colours once encoded afresh, and AwwO does not convert between them: it is refused (review rounds 7 and 8;
    // Blender's renders and exported textures carry neither).
    const facts = frameFacts(source, reference);
    if (facts.sideData.includes('ICC profile'))
      throw new Error(`${reference}: a picture with a colour profile (ICC), which AwwO does not convert; export it in sRGB without one`);
    const other = facts.colours.find(([transfer, primaries]) => !SRGB_TRANSFERS.has(transfer) || !SRGB_PRIMARIES.has(primaries));
    const why = other ? `transfer ${other[0]}, primaries ${other[1]}` : pngNotSrgb(bytes);
    if (why) throw new Error(`${reference}: a picture in another colour space than sRGB (${why}), which AwwO does not convert; export it in sRGB`);
    // Any other side data a decoded frame keeps is deleted, so ffmpeg writes none of it into the new file (review
    // round 6: an ICC profile, whose text tags can name anything, came through).
    ffmpeg(reference, ['-y', '-v', 'error', '-i', source, '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-frames:v', '1',
      '-vf', `sidedata=mode=delete${width ? `,scale='min(${width},iw)':-2` : ''}`, ...(png ? [] : ['-q:v', width ? '3' : '2']), out]);
    const fresh = fs.readFileSync(out);
    pixelsOnly(fresh, png, reference);
    return fresh;
  };
}

// What a fresh picture may hold: a PNG's pixels, palette and their numeric colour and density chunks; a JPEG's tables,
// frame and scans, and a bare JFIF header.
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'pHYs', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'sBIT', 'IDAT', 'IEND']);
const JPEG_SEGMENTS = new Set([0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xdd]);

/** Throws unless a picture ffmpeg wrote holds only its pixels (PNG_CHUNKS, JPEG_SEGMENTS): a backstop behind
 * picture()'s options, read from a file ffmpeg's own encoder wrote, so plainly laid out. */
export function pixelsOnly(bytes, png, reference) {
  const refuse = what => { throw new Error(`${reference}: its picture encoded afresh still holds ${what}`); };
  if (png) {
    if (bytes.toString('latin1', 1, 4) !== 'PNG') refuse('no PNG');
    for (let at = 8; ; ) {
      if (at + 12 > bytes.length) refuse('a cut chunk');
      const length = bytes.readUInt32BE(at), kind = bytes.toString('latin1', at + 4, at + 8);
      if (!PNG_CHUNKS.has(kind)) refuse(`a ${kind} chunk`);
      at += 12 + length;
      if (kind === 'IEND') { if (at !== bytes.length) refuse('bytes after its end'); return; }
    }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) refuse('no JPEG');
  for (let at = 2; ; ) {
    if (bytes[at] !== 0xff || at + 4 > bytes.length) refuse('a cut segment');
    const marker = bytes[at + 1], length = bytes.readUInt16BE(at + 2);
    if (marker === 0xe0) {
      if (length !== 16 || bytes.toString('latin1', at + 4, at + 9) !== 'JFIF\0' || bytes[at + 16] || bytes[at + 17]) refuse('a JFIF header with more than its fields');
    } else if (marker !== 0xda && !JPEG_SEGMENTS.has(marker)) refuse(`a segment ${marker.toString(16)}`);
    at += 2 + length;
    if (marker !== 0xda) continue;
    // A scan's data, its stuffed bytes and restart markers, up to the next marker: another table or scan, or the end.
    while (at + 1 < bytes.length && !(bytes[at] === 0xff && bytes[at + 1] !== 0x00 && (bytes[at + 1] < 0xd0 || bytes[at + 1] > 0xd7))) at++;
    if (bytes[at + 1] === 0xd9) { if (at + 2 !== bytes.length) refuse('bytes after its end'); return; }
  }
}

// The colour tags of a picture taken as sRGB (an untagged one is; gamma 2.2, which ffprobe names bt470m, and BT.709's
// curve are near enough). ffprobe says unknown also for a tag it has no name for: pngNotSrgb reads a PNG's own.
const SRGB_TRANSFERS = new Set(['unknown', 'iec61966-2-1', 'bt709', 'bt470m']);
const SRGB_PRIMARIES = new Set(['unknown', 'bt709']);
// sRGB's chromaticities as a PNG's cHRM holds them (white, red, green, blue; x then y, times 100000), and its gAMA.
const SRGB_CHRM = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
const SRGB_GAMA = 45455;

/** Why a PNG's own colour chunks say it is not sRGB, or null (not a PNG, or sRGB), in the order a decoder takes them
 * (review rounds 9 and 10): coding points (cICP) decide alone, sRGB only if BT.709's primaries with the sRGB or BT.709
 * curve, RGB, full range; then a profile (iCCP) is refused; then an sRGB chunk is sRGB; then a gamma other than 1/2.2
 * or chromaticities other than sRGB's are refused. Read only up to its pixels. */
export function pngNotSrgb(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let srgb = false, profile = false, gamma = null, chrm = null, points = null;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at), kind = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
    if (kind === 'IDAT' || kind === 'IEND') break;
    if (kind === 'cICP') points = [...data];
    if (kind === 'iCCP') profile = true;
    if (kind === 'sRGB') srgb = true;
    if (kind === 'gAMA' && data.length === 4) gamma = data.readUInt32BE(0);
    if (kind === 'cHRM' && data.length === 32) chrm = Array.from({ length: 8 }, (_, k) => data.readUInt32BE(4 * k));
    at += 12 + length;
  }
  if (points) return points.length === 4 && points[0] === 1 && (points[1] === 13 || points[1] === 1) && points[2] === 0 && points[3] === 1
    ? null : `coding points ${points.join('/')}`;
  if (profile) return 'a colour profile';
  if (srgb) return null;
  if (gamma !== null && Math.abs(gamma - SRGB_GAMA) > 200) return `gamma ${gamma ? (100000 / gamma).toFixed(2) : 'none'}`;
  if (chrm && chrm.some((value, k) => Math.abs(value - SRGB_CHRM[k]) > 1000)) return 'chromaticities other than sRGB';
  return null;
}

/** What ffprobe finds on a picture's frames: the kinds of side data ('ICC profile', …) and each frame's colour transfer
 * and primaries. */
function frameFacts(file, reference) {
  const done = spawnSync('ffprobe', ['-v', 'error', '-show_frames', '-show_entries', 'frame=color_transfer,color_primaries:frame_side_data=side_data_type',
    '-of', 'json', file], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`ffprobe ${reference}: ${done.stderr}`);
  const frames = JSON.parse(done.stdout).frames ?? [];
  return { sideData: frames.flatMap(frame => (frame.side_data_list ?? []).map(item => item.side_data_type)),
    colours: frames.map(frame => [frame.color_transfer ?? 'unknown', frame.color_primaries ?? 'unknown']) };
}

/** ffmpeg with `args`; a failure stops the publish, naming the file it was for. */
export function ffmpeg(reference, args) {
  const done = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`ffmpeg ${reference}: ${done.stderr}`);
}

/** A record as a typed module. JSON.stringify escapes every string, so outputs stay inert data. */
export function recordText(record) {
  return `// Generated by scripts/showcase/ from a recorded run; do not edit by hand.\nimport type { ProductionRunRecord } from '../productionRuns';\n\nconst record: ProductionRunRecord = ${JSON.stringify(record, null, 2)};\nexport default record;\n`;
}

export function writeRecord(file, record) {
  fs.writeFileSync(file, recordText(record));
}

/** production-runs/summary.json — what the homepage cards show without loading a record — with the record's case. */
export function summaryText(file, record, delivered) {
  const summary = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  summary[record.caseId] = { completed: record.completed, total: record.total, seconds: record.seconds, delivered, capturedOn: record.capturedOn, model: record.model, runtime: record.runtime,
    ...(record.media?.length ? { media: { completed: record.media.filter(item => item.status === 'done').length, total: record.media.length } } : {}) };
  const ordered = Object.fromEntries(Object.keys(summary).sort().map(key => [key, summary[key]]));
  return JSON.stringify(ordered, null, 2) + '\n';
}

export function writeSummary(file, record, delivered) {
  fs.writeFileSync(file, summaryText(file, record, delivered));
}

/**
 * Write each [file, text] so that a case's record, summary and media manifest change together or not at all (review
 * rounds 5 and 6): every new text is written whole beside its file first (a failure there leaves every file as it was),
 * then each file is swapped for its new text by renames, which need no room, its old contents kept beside it until
 * all are swapped. A failed swap puts the old files back. Whatever cannot be put back or tidied away is reported with
 * the first failure, never in its place (review round 7); once all are swapped, a left-over copy is only warned of.
 */
export function writeTogether(writes) {
  // Only files are swapped: a directory where a file belongs stops the publish before anything moves (review round 8).
  for (const [file] of writes) if (fs.existsSync(file) && !fs.statSync(file).isFile()) throw new Error(`${file} is not a file`);
  const left = [];
  const tidy = file => {
    try {
      fs.rmSync(file, { force: true });
    } catch (failure) {
      left.push(`${file} (${failure.message})`);
    }
  };
  const fail = (error, lost = []) => {
    const notes = [...(lost.length ? [`putting back failed for ${lost.join(', ')}`] : []), ...(left.length ? [`left behind: ${left.join(', ')}`] : [])];
    return notes.length ? new Error(`${error.message}; and ${notes.join('; ')}`, { cause: error }) : error;
  };
  const staged = [];
  try {
    for (const [file, text] of writes) {
      staged.push(`${file}.${process.pid}.new`);
      fs.writeFileSync(staged.at(-1), text);
    }
  } catch (error) {
    staged.forEach(tidy);
    throw fail(error);
  }
  const swapped = [];
  try {
    writes.forEach(([file], index) => {
      const old = fs.existsSync(file) ? `${file}.${process.pid}.old` : null;
      if (old) fs.renameSync(file, old);
      swapped.push([file, old]);
      fs.renameSync(staged[index], file);
    });
  } catch (error) {
    const lost = [];
    for (const [file, old] of swapped.reverse()) {
      try {
        if (old) fs.renameSync(old, file);
        else fs.rmSync(file, { force: true });
      } catch (failure) {
        lost.push(`${file} (${failure.message}${old ? `; its old contents are in ${old}` : ''})`);
      }
    }
    staged.forEach(tidy);
    throw fail(error, lost);
  }
  for (const [, old] of swapped) if (old) tidy(old);
  if (left.length) console.warn(`published, but could not remove ${left.join(', ')}`);
}

// Offline checks of what the publishers share (publish-common.mjs): an agent's GLB and pictures are published
// self-contained and without anything that names the run behind them. Run: node --test scripts/showcase/publish-common.test.mjs
// (the re-encoding test needs ffmpeg and ffprobe on PATH, and is skipped without them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { agentGlb, identifying, picture, pixelsOnly, pngNotSrgb, recordIds, writeTogether } from './publish-common.mjs';

/** A GLB of `doc` and, after it, a binary chunk of `bin`. A `doc` without a `scenes` key gets the one scene a published
 * model must have, holding all its nodes (set `scenes: undefined` for a model with none). */
function glb(doc, bin = Buffer.alloc(8)) {
  if (!('scenes' in doc)) doc = { ...doc, scenes: [{ nodes: (doc.nodes ?? []).map((_, index) => index) }] };
  const pad = (bytes, fill) => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4, fill)]);
  const json = pad(Buffer.from(JSON.stringify(doc), 'utf8'), 0x20), data = pad(bin, 0);
  const chunk = (kind, bytes) => { const head = Buffer.alloc(8); head.writeUInt32LE(bytes.length, 0); head.write(kind, 4, 'latin1'); return Buffer.concat([head, bytes]); };
  const body = Buffer.concat([chunk('JSON', json), chunk('BIN\0', data)]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}
const readJson = bytes => JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
const CANVAS = 'cv-lq3k9z2a-4-x9y8';

test('an agent GLB keeps its names in any script, renames those with a path\'s separator, and refuses odd keys', () => {
  const doc = readJson(agentGlb(glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }],
    materials: [{ name: '金银铜' }, { name: '金/银/铜' }, { name: 'Gold_18k (warm) #2' }, { name: '/My "Projects"/gold' }, { name: 'C:\\gold' }, { name: '' }],
    meshes: [{ name: 'Band|inner', primitives: [] }],
    nodes: [{ name: 'mixamorig:Hips' }, { name: 'C:private-scene.blend' }, { name: 'Armature|C:private-scene.blend' }, { name: 'source=C:private-scene.blend' }, { name: 'Size: L' }] }), 'x.glb'));
  // A drive's relative path, at a name's start or after another word (review rounds 16 and 17).
  assert.deepEqual(doc.nodes.map(node => node.name), ['mixamorig:Hips', 'node_1', 'node_2', 'node_3', 'Size: L']);
  assert.deepEqual(doc.materials.map(material => material.name), ['金银铜', 'material_1', 'Gold_18k (warm) #2', 'material_3', 'material_4', 'material_5']);
  // A page may look a part up by its name (review round 13), and a renamed one never takes a name the list keeps
  // (round 15).
  assert.deepEqual([doc.meshes[0].name, doc.nodes[0].name], ['Band|inner', 'mixamorig:Hips']);
  const parts = readJson(agentGlb(glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }],
    meshes: [{ name: '/Users/alice/private/move.blend', primitives: [] }, { name: 'mesh_0', primitives: [] }] }), 'x.glb'));
  assert.deepEqual(parts.meshes.map(mesh => mesh.name), ['mesh_0_2', 'mesh_0']);
  // A dictionary's keys are free text too, and three.js lowercases a custom one (review round 27: `_MARK` and `_mark`
  // were one attribute, the other's bytes kept unread): glTF's own vertex attributes pass, any other stops the publish.
  const attributes = keys => ({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }], accessors: [{ componentType: 5126, type: 'VEC3', count: 1 }],
    meshes: [{ primitives: [{ attributes: keys }] }] });
  for (const keys of [{ POSITION: 0, '_C:/USERS/ALICE/PRIVATE/SCENE.BLEND': 0 }, { POSITION: 0, _MARK: 0, _mark: 0 }, { POSITION: 0, _BATCHID: 0 },
    { POSITION: 0, JOINTS_0: 0, WEIGHTS_0: 0 }, { POSITION: 0, TEXCOORD_01: 0 }, { position: 0 }])
    assert.throws(() => agentGlb(glb(attributes(keys)), 'x.glb'), /a vertex attribute the homepage does not publish/, JSON.stringify(keys));
  assert.doesNotThrow(() => agentGlb(glb(attributes({ POSITION: 0, NORMAL: 0, TANGENT: 0, TEXCOORD_0: 0, TEXCOORD_1: 0, COLOR_0: 0 })), 'x.glb'));
  // Review round 14: no field is free text: a known extension's unknown field holding a path stops the publish; a long
  // name Blender allows stays.
  const glow = { asset: { version: '2.0' }, buffers: [{ byteLength: 8 }], extensionsUsed: ['KHR_materials_emissive_strength'],
    materials: [{ name: 'Gold', extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2, sourcePath: '/Users/alice/private/scene.blend' } } }] };
  assert.throws(() => agentGlb(glb(glow), 'x.glb'), /a key AwwO does not publish \("sourcePath"\)/);
  const long = 'Ring_' + 'A'.repeat(195);
  assert.equal(readJson(agentGlb(glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }], nodes: [{ name: long }] }), 'x.glb')).nodes[0].name, long);
  // Blender 5.2 can export KHR_meshopt_compression, whose stream's unused table entries can hold a path (review round
  // 21) and which no AwwO viewer decodes: it stops the publish, as Draco does.
  assert.throws(() => agentGlb(glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }], extensionsUsed: ['KHR_meshopt_compression'],
    bufferViews: [{ buffer: 0, byteLength: 8, extensions: { KHR_meshopt_compression: { buffer: 0, byteLength: 8, byteStride: 4, count: 2, mode: 'ATTRIBUTES' } } }] }), 'x.glb'),
  /it uses KHR_meshopt_compression, which AwwO does not publish/);
});

test('an agent GLB keeps its names but those that name a path or an identifier, and loses its extras', () => {
  const made = glb({ asset: { version: '2.0', generator: 'Khronos glTF Blender I/O v5.2' }, scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: 'Ring', mesh: 0 }, { name: '/workspace/out/ring.blend' }, { name: 'part-0f8c2a9e-1b2c-4d5e-8f90-123456789abc' }],
    meshes: [{ name: CANVAS, extras: { source: '/workspace/scene.py' }, primitives: [] }],
    materials: [{ name: '18k gold', extras: { blend: '/opt/awwo/blender/user/scene.blend' } }], buffers: [{ byteLength: 8 }] });
  const doc = readJson(agentGlb(made, 'ring/ring.glb', [CANVAS]));
  assert.deepEqual(doc.nodes.map(node => node.name), ['Ring', 'node_1', 'node_2']);
  assert.deepEqual([doc.meshes[0].name, doc.materials[0].name], ['mesh_0', '18k gold']);
  assert.equal(JSON.stringify(doc).includes('extras'), false);
  // Its geometry stays as it was: the binary chunk is byte for byte the same.
  const out = agentGlb(made, 'ring/ring.glb', [CANVAS]);
  assert.deepEqual(out.subarray(20 + out.readUInt32LE(12)), made.subarray(20 + made.readUInt32LE(12)));
});

test('an agent GLB that reaches outside itself, or names the run where it cannot be renamed, is refused', () => {
  const base = { asset: { version: '2.0' }, buffers: [{ byteLength: 8 }] };
  assert.throws(() => agentGlb(glb({ ...base, images: [{ uri: 'textures/gold.png' }] }), 'x.glb'), /outside it/);
  assert.throws(() => agentGlb(glb({ ...base, buffers: [{ byteLength: 8, uri: 'data.bin' }] }), 'x.glb'), /outside it/);
  // Free text is kept out, not searched (review rounds 10 to 12, where every pattern for a path let another form
  // through): the copyright goes, whatever it holds.
  for (const copyright of ['/Users/alice/private/scene.blend', 'C:/scene.blend', 'C:\\scene.blend', 'file:/studio/alice/scene.blend',
    '\\\\studio-nas\\alice-private\\scene.blend', '//studio-nas/alice-private/scene.blend', '/My "Projects"/scene.blend',
    'https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0, Atelier Minima'])
    assert.equal('copyright' in readJson(agentGlb(glb({ ...base, asset: { version: '2.0', copyright } }), 'x.glb')).asset, false, copyright);
  // An extension AwwO does not know stops it; XMP metadata goes; a pointer into the document stays.
  const vendor = { ...base, extensionsUsed: ['VENDOR_scene'], nodes: [{ name: 'Ring', extensions: { VENDOR_scene: { source: '/Users/alice/x.blend' } } }] };
  assert.throws(() => agentGlb(glb(vendor), 'x.glb'), /it uses VENDOR_scene, which AwwO does not publish/);
  // Round 19: so does Draco, whose compressed stream can hold metadata (a source file's path) agentGlb does not read.
  assert.throws(() => agentGlb(glb({ ...base, extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } }] }] }), 'x.glb'),
  /it uses KHR_draco_mesh_compression, which AwwO does not publish/);
  const xmp = readJson(agentGlb(glb({ ...base, extensionsUsed: ['KHR_xmp_json_ld'], asset: { version: '2.0', extensions: { KHR_xmp_json_ld: { packet: 0 } } },
    extensions: { KHR_xmp_json_ld: { packets: [{ 'dc:source': 'file:///Users/alice/scene.blend' }] } } }), 'x.glb'));
  assert.equal(JSON.stringify(xmp).includes('xmp'), false);
  // A pointer anywhere stops it as free text; so does a name with a path on the document itself, and a structure glTF
  // does not have, by its key (review rounds 15 to 17).
  assert.throws(() => agentGlb(glb({ ...base, extensionsUsed: ['KHR_materials_emissive_strength'],
    materials: [{ extensions: { KHR_materials_emissive_strength: { pointer: '/Users/alice/private/README' } } }] }), 'x.glb'),
  /text AwwO does not publish \(materials\[\]\.extensions\.KHR_materials_emissive_strength\.pointer/);
  assert.throws(() => agentGlb(glb({ ...base, name: '/Users/alice/private/scene.blend' }), 'x.glb'), /a key AwwO does not publish \("name"\)/);
  assert.throws(() => agentGlb(glb({ ...base, Users: { alice: { private: {} } } }), 'x.glb'), /a key AwwO does not publish \("Users"\)/);
  assert.throws(() => agentGlb(glb({ ...base, source: [{}] }), 'x.glb'), /a key AwwO does not publish \("source"\)/);
  // Round 24: still models only. Rounds 15 to 24 each found another way an animation, a skin or a morph target kept
  // bytes no viewer shows: a channel with no target (glTF ignores it, yet its sampler was kept), a skin's joint whose
  // child holds a mesh three.js never loads, pointers into structures forged for them. Each of these stops the publish,
  // in any form; an empty list of animations or skins is none and goes.
  const still = /the homepage publishes still models only/;
  for (const more of [
    { animations: [{ name: 'Idle', samplers: [{ input: 0, output: 0 }], channels: [{ sampler: 0, target: { path: 'translation' } }] }] },
    { animations: [{ name: 'Glow', samplers: [], channels: [] }] },
    { extensionsUsed: ['KHR_animation_pointer'], animations: [{ samplers: [{ input: 0, output: 0 }],
      channels: [{ sampler: 0, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/nodes/0/translation' } } } }] }] },
    { nodes: [{ name: 'Body', skin: 0 }, { name: 'Bone', children: [2] }, { name: 'Hidden', mesh: 0 }], skins: [{ joints: [1] }] },
    { skins: [{ joints: [] }] },
    { nodes: [{ name: 'Body', skin: 0 }] },
    { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] }] }] },
    { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [] }] }] },
    { meshes: [{ primitives: [], weights: [0] }] },
    { nodes: [{ name: 'Ring', weights: [0] }] },
    { animations: {} },
    { skins: 'C:/Users/alice/private/rig.blend' },
  ]) assert.throws(() => agentGlb(glb({ ...base, ...more }), 'x.glb'), still, JSON.stringify(more));
  const empty = readJson(agentGlb(glb({ ...base, animations: [], skins: [], nodes: [{ name: 'Ring' }] }), 'x.glb'));
  assert.deepEqual(['animations' in empty, 'skins' in empty], [false, false]);
  // KHR_animation_pointer is not among the extensions a published model may use, with an animation or without.
  assert.throws(() => agentGlb(glb({ ...base, extensionsUsed: ['KHR_animation_pointer'] }), 'x.glb'), /it uses KHR_animation_pointer, which AwwO does not publish/);
  // Round 25: nor GPU instancing, whose instances three.js leaves unread on a points or lines mesh (there an
  // instance attribute kept a path whole); a still case's pieces need none. Named in the lists or only on a node.
  const points = { ...base, bufferViews: [{ buffer: 0, byteLength: 4 }], accessors: [{ bufferView: 0, componentType: 5121, type: 'SCALAR', count: 4 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }], scenes: [{ nodes: [0] }] };
  for (const listed of [{ extensionsUsed: ['EXT_mesh_gpu_instancing'] }, {}])
    assert.throws(() => agentGlb(glb({ ...points, ...listed, nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { _MARK: 0 } } } }] }), 'x.glb'),
      /it uses EXT_mesh_gpu_instancing, which AwwO does not publish/, JSON.stringify(listed));
  // The bytes a loader reads that name the run stop the publish (the bytes nothing reads are zeroed first).
  const read = { ...base, bufferViews: [{ buffer: 0, byteLength: 40 }], accessors: [{ bufferView: 0, componentType: 5121, type: 'SCALAR', count: 40 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }] };
  assert.throws(() => agentGlb(glb(read, Buffer.from('....Blender:File:/opt/awwo/x.blend....'.padEnd(40, '.'))), 'x.glb'), /binary chunk/);
  assert.throws(() => agentGlb(glb(read, Buffer.from(`..${CANVAS}..`.padEnd(40, '.'))), 'x.glb', [CANVAS]), /binary chunk/);
  assert.throws(() => agentGlb(Buffer.from('not a glb at all'), 'x.glb'), /not a glTF 2.0 binary/);
});

test('an agent GLB keeps only the bytes its content reads: a view or an accessor nothing uses, a gap, padding and the tail are zeroed (review rounds 20 to 22)', () => {
  // Three positions, a gap, a view nothing reads (and an accessor of it nothing uses), a view of two interleaved VEC2s
  // 16 bytes apart (8 of each 16 unread), views 3 to 6 nothing reads (an accessor of a matrix type is refused, round 27),
  // and the chunk's tail; a mesh uses all but the one over the unused view.
  const bin = Buffer.alloc(176);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => bin.writeFloatLE(value, index * 4));
  bin.write('C:/x', 36, 'latin1');
  bin.write('/Users/alice/private/customer-x/scene.blend', 40, 'latin1');
  [[88, 2], [92, 3], [104, 4], [108, 5]].forEach(([at, value]) => bin.writeFloatLE(value, at));
  bin.write('alice-01', 96, 'latin1');
  bin.write('alice-02', 112, 'latin1');
  bin.writeUInt32LE(1, 120);
  [7, 8, 9].forEach((value, index) => bin.writeFloatLE(value, 124 + index * 4));
  Buffer.from([1, 2, 0x51, 0x31, 3, 4, 0x51, 0x32, 5, 6, 0x51, 0x33, 7, 8, 0x51, 0x34, 9, 10, 0x51, 0x35, 11, 12, 0x51, 0x36]).copy(bin, 136);
  bin.write('/alice/tail.blen', 160, 'latin1');
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 176 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 40, byteLength: 48 }, { buffer: 0, byteOffset: 88, byteLength: 32, byteStride: 16 },
      { buffer: 0, byteOffset: 120, byteLength: 4 }, { buffer: 0, byteOffset: 124, byteLength: 12 }, { buffer: 0, byteOffset: 136, byteLength: 16 },
      { buffer: 0, byteOffset: 152, byteLength: 8 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }, { bufferView: 2, componentType: 5126, type: 'VEC2', count: 2 },
      { bufferView: 1, componentType: 5121, type: 'SCALAR', count: 48 }, { bufferView: 1, componentType: 5121, type: 'SCALAR', count: 48 }],
    // The scene shows node 0's mesh; node 1, whose mesh reads accessor 2, is in no scene, and accessor 3 nothing uses.
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }, { primitives: [{ attributes: { NORMAL: 2 } }] }],
    nodes: [{ mesh: 0 }, { mesh: 1 }], scenes: [{ nodes: [0] }] };
  const out = agentGlb(glb(doc, bin), 'x.glb');
  const data = out.subarray(20 + out.readUInt32LE(12) + 8);
  for (const gone of ['alice', 'C:/x', 'scene.blend']) assert.equal(data.includes(Buffer.from(gone)), false, gone);
  assert.deepEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 88, 92, 104, 108].map(at => data.readFloatLE(at)), [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 3, 4, 5]);
  assert.deepEqual([...data.subarray(120, 176)], new Array(56).fill(0));
  assert.equal(data.length, 176);
  // A read past its view, or past the chunk, stops the publish.
  const past = structuredClone(doc);
  past.accessors[0].count = 4;
  assert.throws(() => agentGlb(glb(past, bin), 'x.glb'), /a read past its view/);
  const outside = structuredClone(doc);
  outside.bufferViews[0].byteOffset = 152;
  assert.throws(() => agentGlb(glb(outside, bin), 'x.glb'), /a read past its binary chunk/);
  // So does a stride that is not a whole number of bytes, or shorter than an element.
  for (const byteStride of [16.5, 4]) {
    const odd = structuredClone(doc);
    odd.bufferViews[2].byteStride = byteStride;
    assert.throws(() => agentGlb(glb(odd, bin), 'x.glb'), /a read it cannot place/, String(byteStride));
  }
  // Round 27: an accessor of a matrix type stops the publish (three.js reads a matrix attribute's column padding as
  // components, rounds 21 and 22 zeroed it), whatever uses it.
  assert.throws(() => agentGlb(glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }], bufferViews: [{ buffer: 0, byteLength: 8 }],
    accessors: [{ bufferView: 0, componentType: 5121, type: 'MAT2', count: 1 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }] },
  Buffer.from([1, 2, 0x50, 0x51, 3, 4, 0x52, 0x53])), 'x.glb'), /a matrix-typed accessor/);
});

test('an agent GLB three.js r186 could not load is refused, not published broken (review round 31)', () => {
  const base = { asset: { version: '2.0' }, buffers: [{ byteLength: 32 }] };
  // A document that is not glTF 2, or holds a null where glTF has a value, is not a model to publish.
  for (const asset of [undefined, { version: '1.0' }, { version: 2 }, { generator: 'Blender' }])
    assert.throws(() => agentGlb(glb({ ...base, asset }), 'x.glb'), /it is not a glTF 2 document/, JSON.stringify(asset));
  assert.throws(() => agentGlb(glb({ ...base, materials: [{ name: 'Gold', normalTexture: null }] }), 'x.glb'), /materials\[0\]\.normalTexture is null/);
  assert.throws(() => agentGlb(glb({ ...base, extensionsUsed: ['KHR_lights_punctual'], extensions: { KHR_lights_punctual: { lights: [null] } } }), 'x.glb'),
    /extensions\.KHR_lights_punctual\.lights\[0\] is null/);
  // Each read starts on a whole component and steps a whole number of them, and an interleaved one's whole slice
  // (count × stride bytes from its stride's start) is in its view, as GLTFLoader cuts its typed arrays.
  const mesh = (view, accessor) => ({ ...base, bufferViews: [{ buffer: 0, byteLength: 32, ...view }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 2, ...accessor }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }] });
  for (const [view, accessor, error] of [
    [{}, { type: 'SCALAR', byteOffset: 1 }, /a read that is not aligned to its components/],
    [{ byteOffset: 2, byteLength: 28 }, {}, /a read that is not aligned to its components/],
    [{ byteStride: 18 }, {}, /a read that is not aligned to its components/],
    [{ byteLength: 28, byteStride: 16 }, {}, /an interleaved read past its view/],
    [{}, { count: 0 }, /a read of no elements/],
  ]) assert.throws(() => agentGlb(glb(mesh(view, accessor), Buffer.alloc(32)), 'x.glb'), error, JSON.stringify([view, accessor]));
  // The same accessor, aligned and with its slice in its view, passes.
  for (const [view, accessor] of [[{}, {}], [{ byteLength: 32, byteStride: 16 }, {}], [{ byteOffset: 4, byteLength: 28 }, {}], [{}, { type: 'SCALAR', byteOffset: 4 }]])
    assert.doesNotThrow(() => agentGlb(glb(mesh(view, accessor), Buffer.alloc(32)), 'x.glb'), JSON.stringify([view, accessor]));
});

test('a still agent GLB keeps the meshes its scene shows, its nodes\' children\'s too, and zeroes the rest (review rounds 24 and 26)', () => {
  // Node 0 is in the scene and its child, node 2, holds mesh 1; node 1, in no scene, holds mesh 2, whose bytes hold a
  // path.
  const bin = Buffer.alloc(108);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => bin.writeFloatLE(value, index * 4));
  [2, 0, 0, 3, 0, 0, 0, 3, 0].forEach((value, index) => bin.writeFloatLE(value, 36 + index * 4));
  bin.write('C:/Users/alice/private/scene.blend', 72, 'latin1');
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 108 }],
    bufferViews: [[0, 36], [36, 36], [72, 36]].map(([byteOffset, byteLength]) => ({ buffer: 0, byteOffset, byteLength })),
    accessors: [0, 1, 2].map(bufferView => ({ bufferView, componentType: 5126, type: 'VEC3', count: 3 })),
    meshes: [0, 1, 2].map(POSITION => ({ primitives: [{ attributes: { POSITION } }] })),
    nodes: [{ name: 'Ring', mesh: 0, children: [2] }, { name: 'Hidden', mesh: 2 }, { name: 'Stone', mesh: 1 }], scenes: [{ nodes: [0] }] };
  const out = agentGlb(glb(doc, bin), 'x.glb');
  const data = out.subarray(20 + out.readUInt32LE(12) + 8);
  assert.deepEqual(Array.from({ length: 18 }, (_, index) => data.readFloatLE(index * 4)), [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 0, 3, 0]);
  assert.deepEqual([...data.subarray(72, 108)], new Array(36).fill(0));
  assert.equal(data.includes(Buffer.from('alice')), false);
  // Round 26: one scene, its default. A model with none (three.js loads nothing of it) or a second (loaded, never
  // shown), or whose default is not its one scene, is refused; so is a sparse accessor (the data it replaced whole was
  // kept).
  const scenes = /it does not have one scene that is its default|its scenes are not a list of objects/;
  for (const more of [{ scenes: undefined }, { scenes: [] }, { scenes: [{ nodes: [0] }, { nodes: [1] }] }, { scene: 1 }, { scenes: [null] }])
    assert.throws(() => agentGlb(glb({ ...doc, ...more }, bin), 'x.glb'), scenes, JSON.stringify(more));
  assert.doesNotThrow(() => agentGlb(glb({ ...doc, scene: 0 }, bin), 'x.glb'));
  const sparse = structuredClone(doc);
  sparse.accessors[0].sparse = { count: 3, indices: { bufferView: 1, componentType: 5121 }, values: { bufferView: 2 } };
  assert.throws(() => agentGlb(glb(sparse, bin), 'x.glb'), /it has a sparse accessor/);
  // Round 28: a reference that is not an index (three.js reads `[0]` as 0, so the shown geometry was zeroed) is refused,
  // wherever it is.
  const malformed = [
    copy => { copy.meshes[0].primitives[0].attributes.POSITION = [0]; },
    copy => { copy.nodes[0].mesh = [0]; },
    copy => { copy.scenes[0].nodes = [[0]]; },
    copy => { copy.nodes[0].children = [2.5]; },
    copy => { copy.accessors[0].bufferView = '0'; },
    copy => { copy.scene = -1; delete copy.scenes[1]; },
  ];
  for (const [at, edit] of malformed.entries()) {
    const copy = structuredClone(doc);
    edit(copy);
    assert.throws(() => agentGlb(glb(copy, bin), 'x.glb'), /is not an index|does not have one scene/, String(at));
  }
  // Round 29: a reference past the end of its list (a node, a mesh, an accessor that is not there) is refused too; and
  // a primitive that is not triangles (three.js draws points and lines with a material of its own that reads only the
  // base colour's texture), whatever else it is.
  const past = [
    copy => { copy.scenes[0].nodes = [3]; },
    copy => { copy.nodes[0].mesh = 3; },
    copy => { copy.meshes[0].primitives[0].attributes.POSITION = 3; },
    copy => { copy.nodes[0].children = [0, 9]; },
    copy => { copy.accessors[0].bufferView = 3; },
    copy => { copy.meshes[0].primitives[0].material = 0; },
  ];
  for (const [at, edit] of past.entries()) {
    const copy = structuredClone(doc);
    edit(copy);
    assert.throws(() => agentGlb(glb(copy, bin), 'x.glb'), /is not an index/, String(at));
  }
  for (const mode of [0, 1, 2, 3, 5, 6]) {
    const copy = structuredClone(doc);
    copy.meshes[0].primitives[0].mode = mode;
    assert.throws(() => agentGlb(glb(copy, bin), 'x.glb'), /a primitive that is not triangles/, String(mode));
  }
  const triangles = structuredClone(doc);
  triangles.meshes[0].primitives[0].mode = 4;
  assert.doesNotThrow(() => agentGlb(glb(triangles, bin), 'x.glb'));
  // Round 30: a document three.js cannot load is refused, not published broken: a null node, mesh or accessor, a mesh
  // with no list of primitives or a primitive with no attributes, a view that names no buffer, and a node reached twice
  // (its own child, or two parents' child).
  const broken = [
    [copy => { copy.nodes[1] = null; }, /its nodes are not a list of objects/],
    [copy => { copy.meshes[2] = null; }, /its meshes are not a list of objects/],
    [copy => { copy.accessors[2] = null; }, /its accessors are not a list of objects/],
    [copy => { delete copy.meshes[0].primitives; }, /a mesh whose primitives are not objects with attributes/],
    [copy => { delete copy.meshes[0].primitives[0].attributes; }, /a mesh whose primitives are not objects with attributes/],
    [copy => { delete copy.bufferViews[0].buffer; }, /a buffer view that names no buffer/],
    [copy => { copy.nodes[0].children = [0]; }, /not a tree \(node 0 is reached twice\)/],
    [copy => { copy.nodes[1].children = [2]; copy.scenes[0].nodes = [0, 1]; }, /not a tree \(node 2 is reached twice\)/],
  ];
  for (const [at, [edit, error]] of broken.entries()) {
    const copy = structuredClone(doc);
    edit(copy);
    assert.throws(() => agentGlb(glb(copy, bin), 'x.glb'), error, String(at));
  }
});

test('every picture of a published model is one a material its scene shows uses (review round 26)', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('pixels holding C:/Users/alice/private/scene.blend')]);
  const fresh = () => Buffer.from('fresh png!');
  const used = readJson(withPictures([[png, 'image/png']]));
  // The picture used by the scene's material passes; the same picture as a second image nothing uses is refused, and so
  // is one only a material off the scene, or a texture no material names, uses.
  assert.doesNotThrow(() => agentGlb(glb(used, twin(withPictures([[png, 'image/png']]))), 'x.glb', [], fresh));
  const extra = structuredClone(used);
  extra.images.push({ bufferView: 0, mimeType: 'image/png' });
  assert.throws(() => agentGlb(glb(extra, twin(withPictures([[png, 'image/png']]))), 'x.glb', [], fresh), /picture 1 is not used by any material its scene shows/);
  const offScene = structuredClone(used);
  offScene.scenes = [{ nodes: [] }];
  assert.throws(() => agentGlb(glb(offScene, twin(withPictures([[png, 'image/png']]))), 'x.glb', [], fresh), /picture 0 is not used/);
  const unnamed = structuredClone(used);
  unnamed.materials = [{}];
  assert.throws(() => agentGlb(glb(unnamed, twin(withPictures([[png, 'image/png']]))), 'x.glb', [], fresh), /picture 0 is not used/);
  // A known extension's texture is one three.js loads: a clearcoat's normal map passes.
  const clearcoat = structuredClone(used);
  clearcoat.extensionsUsed = ['KHR_materials_clearcoat'];
  clearcoat.materials = [{ extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatNormalTexture: { index: 0 } } } }];
  assert.doesNotThrow(() => agentGlb(glb(clearcoat, twin(withPictures([[png, 'image/png']]))), 'x.glb', [], fresh));
  // The material extensions some of whose textures three.js does not load are refused, as are textures it would need a
  // decoder for.
  for (const name of ['KHR_materials_pbrSpecularGlossiness', 'KHR_materials_diffuse_transmission', 'KHR_materials_variants',
    'KHR_materials_unlit', 'KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'])
    assert.throws(() => agentGlb(glb({ ...used, extensionsUsed: [name] }, twin(withPictures([[png, 'image/png']]))), 'x.glb', [], fresh),
      new RegExp(`it uses ${name}, which AwwO does not publish`), name);
});

// Made-up identifiers of AwwO's forms (a tenant's, a workspace's): no real one belongs in a test.
const TENANT = 'aFixtureTenant' + '0'.repeat(19), WORKSPACE = 'f'.repeat(16) + '0123456789abcdef'.repeat(3);

test('AwwO\'s own identifiers name the run, in text by their form and in bytes when the record holds them', () => {
  for (const text of [TENANT, `run ${TENANT}.`, WORKSPACE]) {
    assert.equal(identifying(text), true, text);
    assert.equal(identifying(text, [], true), false, text);
    assert.equal(identifying(text, [TENANT, WORKSPACE], true), true, text);
  }
  // Review round 3: eight vertex colours of (0.4, 0.4, 0.4, 0.4) as normalized unsigned shorts are 64 bytes of 0x66,
  // which read as 64 hex digits: in a GLB's binary chunk they are numbers, not a workspace.
  const colours = Buffer.alloc(64);
  for (let at = 0; at < 64; at += 2) colours.writeUInt16LE(Math.round(0.4 * 65535), at);
  assert.equal(colours.toString('latin1'), 'f'.repeat(64));
  assert.equal(identifying(colours.toString('latin1')), true, 'as text it would be one');
  assert.doesNotThrow(() => agentGlb(glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 64 }],
    bufferViews: [{ buffer: 0, byteLength: 64 }], accessors: [{ bufferView: 0, componentType: 5123, normalized: true, count: 8, type: 'VEC4' }],
    meshes: [{ primitives: [{ attributes: { COLOR_0: 0 } }] }], nodes: [{ mesh: 0 }] }, colours), 'x.glb'));
  // A shorter or longer token of the same letters is not one.
  assert.equal(identifying(`${TENANT}x`), false);
  assert.equal(identifying(TENANT.slice(0, 30)), false);
  assert.deepEqual(recordIds({ tenant: TENANT, files: [{ workspace: WORKSPACE }, { name: 'ring.glb' }] }).sort(), [TENANT, WORKSPACE].sort());
  // In a GLB: an id-named light inside an extension is renamed, not left to name the tenant.
  const made = glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }],
    extensions: { KHR_lights_punctual: { lights: [{ name: TENANT, type: 'point' }] } } });
  assert.equal(readJson(agentGlb(made, 'x.glb')).extensions.KHR_lights_punctual.lights[0].name, 'light_0');
});

/** A GLB holding `pictures` ([bytes, mimeType]), each in a view of its own, 4-byte aligned, and an image of each view
 * (or of the views `images` lists). */
function withPictures(pictures, images = pictures.map((_, index) => index)) {
  const parts = [], views = [];
  let at = 0;
  for (const [bytes] of pictures) {
    views.push({ buffer: 0, byteOffset: at, byteLength: bytes.length });
    const pad = Buffer.alloc((4 - (bytes.length % 4)) % 4);
    parts.push(bytes, pad);
    at += bytes.length + pad.length;
  }
  const bin = Buffer.concat(parts);
  return glb({ asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], bufferViews: views,
    images: images.map(index => ({ bufferView: index, mimeType: pictures[index][1] })), ...shows(images.length) }, bin);
}
/** The textures, materials, mesh and node that show `count` pictures, each a material's base colour: every picture of
 * a published model is one its scene shows. */
function shows(count) {
  const each = Array.from({ length: count }, (_, index) => index);
  return { textures: each.map(source => ({ source })), materials: each.map(index => ({ pbrMetallicRoughness: { baseColorTexture: { index } } })),
    meshes: [{ primitives: each.map(material => ({ attributes: {}, material })) }], nodes: [{ mesh: 0 }] };
}
/** A GLB's views as their bytes. */
function viewsOf(out) {
  const doc = readJson(out), data = out.subarray(20 + out.readUInt32LE(12) + 8);
  return { doc, data, view: index => data.subarray(doc.bufferViews[index].byteOffset, doc.bufferViews[index].byteOffset + doc.bufferViews[index].byteLength) };
}

test('an agent GLB\'s pictures are encoded afresh: the old bytes are gone, each view holds the new ones, the chunk adds up', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('zTXt /workspace/out/scene.blend made on a laptop')]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('Exif C:/Users/alice/private/scene.blend trailing note'), Buffer.from([0xff, 0xd9])]);
  const calls = [];
  const fresh = (bytes, mimeType) => { calls.push(mimeType); return Buffer.from(mimeType === 'image/png' ? 'fresh png!' : 'fresh jpeg'); };
  const out = agentGlb(withPictures([[png, 'image/png'], [jpeg, 'image/jpeg']]), 'x.glb', [], fresh);
  const { doc, data, view } = viewsOf(out);
  assert.deepEqual(calls, ['image/png', 'image/jpeg']);
  assert.deepEqual([view(0).toString(), view(1).toString()], ['fresh png!', 'fresh jpeg']);
  for (const gone of ['zTXt', 'workspace', 'laptop', 'Exif', 'alice', 'trailing']) assert.equal(data.includes(Buffer.from(gone)), false, gone);
  assert.equal(doc.buffers[0].byteLength, data.length);
  assert.equal(out.readUInt32LE(8), out.length);
  for (const viewed of doc.bufferViews) assert.equal(viewed.byteOffset % 4, 0);
  // Two images of one view are encoded once.
  calls.length = 0;
  agentGlb(withPictures([[png, 'image/png']], [0, 0]), 'x.glb', [], fresh);
  assert.deepEqual(calls, ['image/png']);
  // Without an encoder, or a picture of a type it does not encode afresh, it stops the publish.
  assert.throws(() => agentGlb(withPictures([[png, 'image/png']]), 'x.glb'), /nothing was given to encode them afresh/);
  assert.throws(() => agentGlb(withPictures([[png, 'image/webp']]), 'x.glb', [], fresh), /does not encode afresh/);
  // Review round 4: two views over the same bytes are each encoded from the bytes as they were, not from the zeros the
  // first left; bytes a picture shares with a mesh's data, or a view that is a picture's and an accessor's, are refused.
  const twice = withPictures([[png, 'image/png']]);
  const doubled = readJson(twice);
  doubled.bufferViews.push({ ...doubled.bufferViews[0] });
  doubled.images.push({ bufferView: 1, mimeType: 'image/png' });
  doubled.textures.push({ source: 1 });
  doubled.materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: 1 } } });
  doubled.meshes[0].primitives.push({ attributes: {}, material: 1 });
  const seen = [];
  const copy = bytes => { seen.push(bytes.toString('latin1')); return Buffer.from('fresh png!'); };
  agentGlb(glb(doubled, twin(twice)), 'x.glb', [], copy);
  assert.deepEqual(seen, [png.toString('latin1'), png.toString('latin1')]);
  const shared = readJson(twice);
  shared.bufferViews.push({ buffer: 0, byteOffset: 4, byteLength: 8 });
  shared.accessors = [{ bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR' }];
  assert.throws(() => agentGlb(glb(shared, twin(twice)), 'x.glb', [], fresh), /shares its bytes with other data/);
  const reused = readJson(twice);
  reused.accessors = [{ bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' }];
  assert.throws(() => agentGlb(glb(reused, twin(twice)), 'x.glb', [], fresh), /read as something else too/);
  // Round 5: a view compressed with EXT_meshopt_compression keeps its bytes in a source range of its own, which the
  // rewrite would leave as it was; such a GLB is refused (since round 21 for its extension, pictures or not).
  const compressed = readJson(twice);
  compressed.bufferViews[0].extensions = { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 8, byteStride: 4, count: 2, mode: 'ATTRIBUTES' } };
  assert.throws(() => agentGlb(glb(compressed, twin(twice)), 'x.glb', [], fresh), /it uses EXT_meshopt_compression, which AwwO does not publish/);
});

test('a record, its summary and its media manifest change together or not at all (review round 5)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-together-'));
  try {
    const manifest = path.join(dir, 'case.media.json'), record = path.join(dir, 'case.ts'), summary = path.join(dir, 'no', 'summary.json');
    fs.writeFileSync(manifest, 'the old manifest');
    assert.throws(() => writeTogether([[manifest, 'a new manifest'], [record, 'a new record'], [summary, '{}']]), /ENOENT/);
    assert.equal(fs.readFileSync(manifest, 'utf8'), 'the old manifest');
    assert.equal(fs.existsSync(record), false, 'a file that was not there is not left half-made');
    writeTogether([[manifest, 'a new manifest'], [record, 'a new record']]);
    assert.deepEqual([fs.readFileSync(manifest, 'utf8'), fs.readFileSync(record, 'utf8')], ['a new manifest', 'a new record']);
    // Round 6: a swap that fails part-way (the summary's here) puts the files swapped before it back, and leaves no
    // staged or old copies behind.
    const rename = fs.renameSync;
    fs.writeFileSync(summary.replace(`${path.sep}no${path.sep}`, path.sep), 'the old summary');
    const kept = summary.replace(`${path.sep}no${path.sep}`, path.sep);
    fs.renameSync = (from, to) => { if (to === kept && from.endsWith('.new')) throw new Error('EIO: the disk failed'); return rename(from, to); };
    try {
      assert.throws(() => writeTogether([[manifest, 'a third manifest'], [record, 'a third record'], [kept, '{"x": 1}']]), /EIO/);
    } finally {
      fs.renameSync = rename;
    }
    assert.deepEqual([fs.readFileSync(manifest, 'utf8'), fs.readFileSync(record, 'utf8'), fs.readFileSync(kept, 'utf8')],
      ['a new manifest', 'a new record', 'the old summary']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['case.media.json', 'case.ts', 'summary.json']);
    // A staged copy that cannot be tidied away after a failed swap is reported with the failure, not in its place.
    const remove = fs.rmSync;
    fs.renameSync = (from, to) => { if (to === kept && from.endsWith('.new')) throw new Error('EIO: the disk failed'); return rename(from, to); };
    fs.rmSync = (file, options) => { if (String(file).endsWith('.new')) throw new Error('EBUSY: in use'); return remove(file, options); };
    try {
      assert.throws(() => writeTogether([[kept, '{"x": 3}']]), /EIO.*left behind: .*summary\.json\.\d+\.new \(EBUSY/);
    } finally {
      fs.renameSync = rename;
      fs.rmSync = remove;
    }
    assert.equal(fs.readFileSync(kept, 'utf8'), 'the old summary');
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.new')) fs.rmSync(path.join(dir, name));
    // A directory where a file belongs stops it before anything moves (review round 8).
    const folder = path.join(dir, 'case-folder.ts');
    fs.mkdirSync(folder);
    assert.throws(() => writeTogether([[kept, '{"x": 4}'], [folder, 'a record']]), /case-folder\.ts is not a file/);
    assert.equal(fs.readFileSync(kept, 'utf8'), 'the old summary');
    assert.equal(fs.statSync(folder).isDirectory(), true);
    fs.rmdirSync(folder);
    // And when putting a file back fails as well, the error says so, and where its old contents are.
    fs.renameSync = (from, to) => { if (to === kept) throw new Error('EIO: the disk failed'); return rename(from, to); };
    try {
      assert.throws(() => writeTogether([[kept, '{"x": 2}']]), /EIO.*putting back failed for .*summary\.json.*its old contents are in .*summary\.json\.\d+\.old/);
    } finally {
      fs.renameSync = rename;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a picture encoded afresh holds only its pixels, or the publish stops (review round 6)', () => {
  const crcChunk = (kind, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(kind, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bare = [crcChunk('IHDR', Buffer.alloc(13)), crcChunk('IDAT', Buffer.alloc(4)), crcChunk('IEND', Buffer.alloc(0))];
  assert.doesNotThrow(() => pixelsOnly(Buffer.concat([signature, ...bare]), true, 'x'));
  for (const [kind, what] of [['tEXt', /a tEXt chunk/], ['iCCP', /an? iCCP chunk|a iCCP chunk/], ['eXIf', /eXIf chunk/]])
    assert.throws(() => pixelsOnly(Buffer.concat([signature, bare[0], crcChunk(kind, Buffer.from('/workspace/x')), ...bare.slice(1)]), true, 'x'), what);
  assert.throws(() => pixelsOnly(Buffer.concat([signature, ...bare, Buffer.from('more')]), true, 'x'), /after its end/);
  const segment = (marker, data) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(data.length + 2, 2); return Buffer.concat([head, data]); };
  const jfif = segment(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1'));
  const scan = Buffer.concat([segment(0xda, Buffer.alloc(10)), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])]);
  const jpeg = parts => Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts, Buffer.from([0xff, 0xd9])]);
  assert.doesNotThrow(() => pixelsOnly(jpeg([jfif, segment(0xdb, Buffer.alloc(65)), segment(0xc0, Buffer.alloc(15)), scan]), false, 'x'));
  assert.throws(() => pixelsOnly(jpeg([jfif, segment(0xfe, Buffer.from('Blender:File:/workspace/x')), scan]), false, 'x'), /segment fe/);
  assert.throws(() => pixelsOnly(jpeg([jfif, segment(0xe2, Buffer.from('ICC_PROFILE\0')), scan]), false, 'x'), /segment e2/);
  assert.throws(() => pixelsOnly(Buffer.concat([jpeg([jfif, scan]), Buffer.from('trailing note')]), false, 'x'), /after its end/);
});

/** A GLB's binary chunk's data. */
function twin(bytes) {
  const at = 20 + bytes.readUInt32LE(12);
  return bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at));
}

const FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

test('ffmpeg encodes a picture afresh from its pixels alone, the same picture to the same file', { skip: !FFMPEG && 'no ffmpeg' }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-common-'));
  try {
    const make = name => {
      const out = path.join(scratch, name);
      const done = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=1', '-frames:v', '1', out]);
      assert.equal(done.status, 0, String(done.stderr));
      return fs.readFileSync(out);
    };
    // A JPEG with Blender's comment (the scene file's path), an Exif segment and a note after its end; a PNG with a
    // compressed text chunk naming the workspace.
    const plain = make('in.jpg');
    const segment = (marker, data) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(data.length + 2, 2); return Buffer.concat([head, data]); };
    const jpeg = Buffer.concat([plain.subarray(0, 2), segment(0xfe, Buffer.from('Blender:File:/workspace/out/scene.blend')),
      segment(0xe1, Buffer.from('Exif\0\0C:/Users/alice/private', 'latin1')), plain.subarray(2), Buffer.from('trailing note')]);
    const chunk = (kind, data) => {
      const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(kind, 4, 'latin1');
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
      return Buffer.concat([head, data, crc]);
    };
    const flat = make('in.png');
    const png = Buffer.concat([flat.subarray(0, 33), chunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0'), deflateSync('/workspace/out/scene.blend')])), flat.subarray(33)]);
    // A colour profile (its copyright tag naming the workspace, compressed: review round 6) is refused, since without it
    // the picture would show other colours (round 7).
    const profile = Buffer.concat([Buffer.alloc(128), Buffer.from('cprt /workspace/private/scene.blend')]);
    const profiled = Buffer.concat([flat.subarray(0, 33), chunk('iCCP', Buffer.concat([Buffer.from('ICC Profile\0\0', 'latin1'), deflateSync(profile)])), flat.subarray(33)]);
    const encode = picture(scratch);
    const probe = bytes => {
      fs.writeFileSync(path.join(scratch, 'probe'), bytes);
      const done = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', path.join(scratch, 'probe')], { encoding: 'utf8' });
      return done.stdout.trim();
    };
    assert.equal(probe(jpeg), 'mjpeg,96,64', 'the test JPEG decodes');
    assert.equal(probe(png), 'png,96,64', 'the test PNG decodes');
    assert.throws(() => encode(profiled, 'image/png', 'x'), /a picture with a colour profile/);
    // So is a picture tagged with another colour space: a PNG of linear light (gAMA 1.0) would come out darker as an
    // sRGB JPEG (review round 8).
    const tagged = (...chunks) => Buffer.concat([flat.subarray(0, 33), ...chunks, flat.subarray(33)]);
    const gama = value => { const data = Buffer.alloc(4); data.writeUInt32BE(value, 0); return chunk('gAMA', data); };
    const chrm = values => { const data = Buffer.alloc(32); values.forEach((value, k) => data.writeUInt32BE(value, 4 * k)); return chunk('cHRM', data); };
    assert.throws(() => encode(tagged(gama(100000)), 'image/jpeg', 'x', 48), /another colour space than sRGB \(transfer linear/);
    // Round 9: a gamma ffprobe has no name for, and Adobe RGB's chromaticities, are refused by the PNG's own chunks;
    // gamma 1/2.2 alone, and sRGB's chunk with its fallback gAMA and cHRM, are sRGB.
    assert.throws(() => encode(tagged(gama(70000)), 'image/jpeg', 'x', 48), /another colour space than sRGB \(gamma 1\.43\)/);
    assert.throws(() => encode(tagged(chrm([31270, 32900, 64000, 33000, 21000, 71000, 15000, 6000])), 'image/jpeg', 'x', 48), /chromaticities other than sRGB/);
    assert.equal(probe(encode(tagged(gama(45455)), 'image/jpeg', 'x', 48)), 'mjpeg,48,32');
    assert.equal(probe(encode(tagged(chunk('sRGB', Buffer.from([0])), gama(45455), chrm([31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000])), 'image/jpeg', 'x', 48)), 'mjpeg,48,32');
    // Round 10: coding points decide alone, as a decoder takes them: sRGB at full range despite a linear gAMA beside
    // them, refused at limited range.
    assert.equal(probe(encode(tagged(chunk('cICP', Buffer.from([1, 13, 0, 1])), gama(100000)), 'image/jpeg', 'x', 48)), 'mjpeg,48,32');
    assert.equal(pngNotSrgb(tagged(chunk('cICP', Buffer.from([1, 13, 0, 0])))), 'coding points 1/13/0/0');
    for (const [bytes, type, codec] of [[jpeg, 'image/jpeg', 'mjpeg'], [png, 'image/png', 'png']]) {
      const out = encode(bytes, type, 'x');
      assert.equal(probe(out), `${codec},96,64`);
      for (const gone of ['Blender', 'workspace', 'alice', 'trailing', 'zTXt', 'iCCP', 'Lavc']) assert.equal(out.includes(Buffer.from(gone)), false, `${type}: ${gone}`);
      assert.deepEqual(encode(bytes, type, 'x'), out, `${type}: the same picture, the same file`);
    }
    // An agent's picture as published: a JPEG at most the width asked, whatever it was.
    assert.equal(probe(encode(png, 'image/jpeg', 'x', 48)), 'mjpeg,48,32');
    // Through agentGlb: the textures come back as the types they were, clean.
    const { view } = viewsOf(agentGlb(withPictures([[png, 'image/png'], [jpeg, 'image/jpeg']]), 'x.glb', [], encode));
    assert.deepEqual([[...view(0).subarray(0, 4)], [...view(1).subarray(0, 2)]], [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8]]);
    assert.equal(view(1).includes(Buffer.from('Blender')), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

/** CRC-32 of a PNG chunk's type and data. */
function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

test('in bytes only what cannot come about by chance names the run', () => {
  // A machine's own path in free text is not searched for (a model's free text is kept out instead), in text or bytes.
  assert.equal(identifying('C:/Users/me/x', []), false);
  assert.equal(identifying('C:/Users/me/x', [], true), false);
  for (const text of ['/workspace/out/a.jpg', 'awwo-file:aBcD1234efgh', 'Blender:File:/opt/awwo/x'])
    assert.equal(identifying(text, [], true), true, text);
  assert.equal(identifying('0f8c2a9e-1b2c-4d5e-8f90-123456789abc', []), true);
  assert.equal(identifying('0f8c2a9e-1b2c-4d5e-8f90-123456789abc', [], true), false);
  assert.equal(identifying('a gold ring, 18k, 17.3 mm', [CANVAS]), false);
  assert.equal(identifying(`made by ${CANVAS}`, [CANVAS], true), true);
});

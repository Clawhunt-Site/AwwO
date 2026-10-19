// Leaves out of the app's builds the code the three.js they ship took from where it is under non-commercial or
// share-alike Creative Commons terms, so the owner had it taken out (2026-10-18, 2026-10-19):
// - two shaders from Shadertoy, where a shader is under CC BY-NC-SA unless its author says otherwise. The dithering of
//   three.js's WebGL renderer (https://www.shadertoy.com/view/MslGR8), in 0.186.1 and in r128: dithering() returns the
//   color it gets, so a material with dithering on draws as one with it off. N8's bicubic filtering of the
//   transmission buffer (https://www.shadertoy.com/view/Dl2SDW), in 0.186.1: textureBicubic() samples the buffer's mip
//   levels with textureLod, as three.js did before it took N8's filter, so a rough transmissive material looks a
//   little less smooth.
// - code from three Stack Exchange answers (two on Stack Overflow) and from work on OpenProcessing, under CC BY-SA.
//   generateUUID() and its table of hex digits, CubicPoly, the cubic each coordinate of a CatmullRomCurve3 segment
//   follows, and the spacing of that curve's knots, in 0.186.1's core and in r128; DataUtils.toHalfFloat(), in r128:
//   each is AwwO's own code that does the same (a random UUID of the same form, from as many calls to Math.random();
//   the same curves, to rounding; the same half for every number in its range), and the table is gone.
//   GeometryUtils' hilbert2D() and hilbert3D(), in 0.186.1's add-ons: each throws, saying so.
// The files that hold them ship as code (the app's own 3D views) and as text (?raw: the modules and the r128 library a
// running preview loads, whose size and sha256 src/canvas/previewModules.generated.ts and previewLibraries.ts pin; the
// workspace image keeps the same copies, which deploy/saas/workspace/tools/keep-preview-files.mjs cuts with a copy of
// this file). Both build configs, for the app and for its workers, read them through this plugin's load hook, with
// each piece cut out and its function kept under its own name and signature, so what calls it still compiles and
// runs. The dev server and the test configs cut their ?raw imports too, so a preview there checks the same pinned
// sizes; a code import of three goes there uncut (to Vite's dependency pre-bundling, or to Node), and neither ships.
// This file holds no line of what it cuts: it finds each piece between markers (three.js's code around it) and knows
// it by its sha256.
// The build fails when one of the files is not the release this was written for, when a piece is not exactly the one
// expected, when one of the files would ship by another way (any other ?query), when the bundle takes in any other
// file of either package (three.js's sources and other builds repeat what is cut; its WebGPU and TSL code holds more
// from Shadertoy, none of it cut out), when a file of either package it takes in (as code, as text or as an asset)
// credits Stack Exchange or OpenProcessing but for three links read as references, and when any file it emits, once the
// other plugins have emitted theirs, still holds a mark of what is cut, also inside a base64 data: URL.
// scripts/preview-modules.mjs and the image's keep-preview-files.mjs refuse such a credit too, so neither list holds one.
// tests/saas-three-cuts.test.ts runs the hosted build config, tests/native-three-cuts.test.ts the native one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lines = (...rows) => rows.join('\n');

/**
 * A piece to cut: the text between the end of the last of `after` (each found after the one before it, the first
 * exactly once in the file) and the first `before` that follows, as the file writes it (a shader sits inside a JS
 * string, so its line breaks and tabs are the escapes \n and \t); it must hash to `sha256`, and `put` replaces it.
 */
const DITHERING = {
  what: 'the dithering from https://www.shadertoy.com/view/MslGR8',
  after: ['vec3 dithering( vec3 color ) {'], before: '\\n\\t}\\n#endif',
  sha256: '7507a4fe67025e8375586cf1ef02614c403360130fb2c3d9f3a091cb105e7590',
  put: '\\n\\t\\treturn color;',
};
const BICUBIC = {
  what: "N8's bicubic filtering from https://www.shadertoy.com/view/Dl2SDW",
  // transmission_pars_fragment, from its declarations to getVolumeTransmissionRay(): the filter's weight functions,
  // bicubic() and textureBicubic().
  after: ['var transmission_pars_fragment = "', 'varying vec3 vWorldPosition;\\n'], before: '\\tvec3 getVolumeTransmissionRay(',
  sha256: 'a5f5676ab4b59b6c094cff2e3ee7cbe12bd3eb3be397d4e05287791b9333e4c3',
  put: '\\tvec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {\\n\\t\\treturn textureLod( sampler, uv, lod );\\n\\t}\\n',
};
// three.core.js. The table, from the end of EventDispatcher to the seed of the seeded random numbers, makes way for the
// two arrays generateUUID() writes with.
const UUID_TABLE = {
  what: "generateUUID()'s table of hex digits, from a Stack Overflow answer",
  after: ['\t\t\tevent.target = null;\n\n\t\t}\n\n\t}\n\n}\n\n'], before: 'let _seed = 1234567;',
  sha256: 'ecb07b1943135ff48a28872cc39410559a29e513a10059fc2fe7f011e2c177f1',
  put: lines(
    "// AwwO's own code (see generateUUID()): the char codes of the hex digits by value, and those of one UUID, its dashes in",
    '// place, which generateUUID() fills in.',
    'const _hexCodes = [ 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102 ];',
    'const _uuidCodes = new Array( 36 ).fill( 45 );',
    '', ''),
};
const UUID = {
  what: 'generateUUID(), from a Stack Overflow answer',
  after: ['function generateUUID() {'], before: '\n\n}\n',
  sha256: '9eceeae9c34ce96037d3e10fc1f79568bbba6c7c2c8a102e91e6fbc49fb1bd4a',
  put: lines('', '',
    "\t// AwwO's own code, in place of what three.js took from a Stack Overflow answer (CC BY-SA). Four random 32-bit words",
    '\t// from four calls to Math.random(), as many as three.js made, the second with the version (4) in its third digit and',
    '\t// the third with the variant (8 to b) in its first, written as 32 hex digits around the dashes; String.fromCharCode',
    '\t// makes them one flat string.',
    '\tlet at = 0;',
    '\tfor ( let i = 0; i < 4; i ++ ) {',
    '',
    '\t\tlet word = Math.random() * 0x100000000 >>> 0;',
    '\t\tif ( i === 1 ) word = word & 0xffff0fff | 0x4000;',
    '\t\telse if ( i === 2 ) word = word & 0x3fffffff | 0x80000000;',
    '\t\tfor ( let shift = 28; shift >= 0; shift -= 4 ) {',
    '',
    '\t\t\tif ( at === 8 || at === 13 || at === 18 || at === 23 ) at ++;',
    '\t\t\t_uuidCodes[ at ++ ] = _hexCodes[ word >>> shift & 15 ];',
    '',
    '\t\t}',
    '',
    '\t}',
    '',
    '\treturn String.fromCharCode.apply( null, _uuidCodes );'),
};
const CUBIC_POLY = {
  what: 'CubicPoly, from a Stack Overflow answer',
  after: ['function CubicPoly() {'], before: '\n\n}\n',
  sha256: '9562c0ed21a4011934fa4dba49212a1b2467156d5ffb42156556e8f2687d4c43',
  put: lines('', '',
    "\t// AwwO's own code, in place of what three.js took from a Stack Overflow answer (CC BY-SA). One coordinate of a",
    '\t// Catmull-Rom segment, from its start at t = 0 to its end at t = 1: the cubic Hermite curve with those two values',
    '\t// and, at each, the slope the spline gives it.',
    '\tlet start = 0, end = 0, startSlope = 0, endSlope = 0;',
    '',
    "\t// The slope at b of the parabola through a, b and c, spaced h0 and h1 apart: each chord's slope, weighted by the",
    "\t// other's spacing.",
    '\tconst parabolaSlope = ( a, b, c, h0, h1 ) => ( h1 * ( b - a ) / h0 + h0 * ( c - b ) / h1 ) / ( h0 + h1 );',
    '',
    '\treturn {',
    '',
    '\t\t// Evenly spaced knots: at each end of the segment, the tension times the chord between its two neighbours.',
    '\t\tinitCatmullRom: function ( before, from, to, after, tension ) {',
    '',
    '\t\t\tstart = from;',
    '\t\t\tend = to;',
    '\t\t\tstartSlope = tension * ( to - before );',
    '\t\t\tendSlope = tension * ( after - from );',
    '',
    '\t\t},',
    '',
    "\t\t// Knots spaced h0, h1 and h2 apart: the parabola's slopes, per unit of spacing, times the segment's own, h1, which",
    '\t\t// calc() runs over as 0 to 1.',
    '\t\tinitNonuniformCatmullRom: function ( before, from, to, after, h0, h1, h2 ) {',
    '',
    '\t\t\tstart = from;',
    '\t\t\tend = to;',
    '\t\t\tstartSlope = parabolaSlope( before, from, to, h0, h1 ) * h1;',
    '\t\t\tendSlope = parabolaSlope( from, to, after, h1, h2 ) * h1;',
    '',
    '\t\t},',
    '',
    '\t\tcalc: function ( t ) {',
    '',
    '\t\t\t// The Hermite basis: w = t^2( 3 - 2t ) takes the start to the end, t( 1 - t )^2 and t^2( t - 1 ) weigh the',
    '\t\t\t// slopes. The way from the start to the end is taken from whichever end is nearer, so the curve is exactly at',
    '\t\t\t// its ends at t = 0 and t = 1, and a coordinate with the same value at both ends and no slope does not move.',
    '\t\t\tconst u = 1 - t, w = t * t * ( 3 - 2 * t );',
    '\t\t\tconst along = w < 0.5 ? start + ( end - start ) * w : end - ( end - start ) * ( 1 - w );',
    '\t\t\treturn along + ( startSlope * u * u + endSlope * t * ( t - 1 ) ) * t;',
    '',
    '\t\t}',
    '',
    '\t};'),
};
// CatmullRomCurve3.getPoint(): the spacing of the knots of the centripetal and chordal kinds, which three.js took from
// the same answer, between the test of the kind and the uniform kind's branch.
const KNOTS = {
  what: "CatmullRomCurve3's knot spacing, from a Stack Overflow answer",
  after: ["\t\tif ( this.curveType === 'centripetal' || this.curveType === 'chordal' ) {"], before: "\n\n\t\t} else if ( this.curveType === 'catmullrom' ) {",
  sha256: 'd226dce066aaf2470fd4d0601702afdd1d2be4af00e9b9c2ce1c76a93c9c9091',
  put: lines('', '',
    "\t\t\t// AwwO's own code, in place of what three.js took from a Stack Overflow answer (CC BY-SA). Each knot interval is",
    "\t\t\t// its chord's length to the power 0.5 (centripetal) or 1 (chordal), from the chord's square; an interval under",
    '\t\t\t// 1e-4 (a point repeated) takes the middle one, and the middle one, if under it, takes 1.',
    "\t\t\tconst power = this.curveType === 'chordal' ? 0.5 : 0.25;",
    '\t\t\tconst middle = Math.pow( p1.distanceToSquared( p2 ), power ), first = Math.pow( p0.distanceToSquared( p1 ), power ),',
    '\t\t\t\tlast = Math.pow( p2.distanceToSquared( p3 ), power );',
    '\t\t\tconst h1 = middle < 1e-4 ? 1 : middle, h0 = first < 1e-4 ? h1 : first, h2 = last < 1e-4 ? h1 : last;',
    '\t\t\tpx.initNonuniformCatmullRom( p0.x, p1.x, p2.x, p3.x, h0, h1, h2 );',
    '\t\t\tpy.initNonuniformCatmullRom( p0.y, p1.y, p2.y, p3.y, h0, h1, h2 );',
    '\t\t\tpz.initNonuniformCatmullRom( p0.z, p1.z, p2.z, p3.z, h0, h1, h2 );'),
};
// examples/jsm/utils/GeometryUtils.js: both curves with their doc comments, from the module's doc comment to gosper()'s.
const HILBERT = {
  what: "GeometryUtils' hilbert2D() and hilbert3D(), based on work on OpenProcessing",
  after: ["@three_import import * as GeometryUtils from 'three/addons/utils/GeometryUtils.js';\n */\n"], before: '/**\n * Generates a Gosper curve',
  sha256: '000097923a5d4ebc80e40a71c6b92444a15ae18cd64b21a6262d9419bbfc58f6',
  put: lines('',
    '/**',
    " * Not in AwwO's copy of three.js, nor is hilbert3D(): three.js's Hilbert curves were based on work on OpenProcessing,",
    ' * under CC BY-SA. Throws.',
    ' *',
    ' * @throws {Error}',
    ' */',
    'function hilbert2D() {',
    '',
    "\tthrow new Error( 'GeometryUtils.hilbert2D() is not in the copy of three.js AwwO supplies: generate the points of the curve in the page itself.' );",
    '',
    '}',
    '',
    '/**',
    " * Not in AwwO's copy of three.js, nor is hilbert2D(). Throws.",
    ' *',
    ' * @throws {Error}',
    ' */',
    'function hilbert3D() {',
    '',
    "\tthrow new Error( 'GeometryUtils.hilbert3D() is not in the copy of three.js AwwO supplies: generate the points of the curve in the page itself.' );",
    '',
    '}',
    '', ''),
};
// r128's three.min.js, minified: the same table and functions under the names its build gave them, and AwwO's code in
// the same form.
const R128_UUID_TABLE = {
  what: "generateUUID()'s table of hex digits, from a Stack Overflow answer",
  after: ['t.target=null}}}'], before: 'let at=1234567;',
  sha256: 'ac4ea2f35232054015a31f39985e2a55741479ad48302de38e577d786af6d7b6',
  // The char codes of the hex digits by value, upper case as r128 writes them, and those of one UUID, its dashes in place.
  put: "/* AwwO's own code */const awwoHexCodes=[48,49,50,51,52,53,54,55,56,57,65,66,67,68,69,70],awwoUuidCodes=new Array(36).fill(45);",
};
const R128_UUID = {
  what: 'generateUUID(), from a Stack Overflow answer',
  after: ['let at=1234567;', 'function ct(){'], before: '}function ht(',
  sha256: '756e18ecce43d729f9e2853856370d9c37159495e5bafc64c68ed6be31db3ccf',
  put: "/* AwwO's own code, in place of what three.js took from a Stack Overflow answer (CC BY-SA) */"
    + 'let pos=0;for(let i=0;i<4;i++){let word=Math.random()*4294967296>>>0;if(i===1)word=word&0xffff0fff|0x4000;'
    + 'else if(i===2)word=word&0x3fffffff|0x80000000;for(let shift=28;shift>=0;shift-=4){if(pos===8||pos===13||pos===18||pos===23)pos++;'
    + 'awwoUuidCodes[pos++]=awwoHexCodes[word>>>shift&15]}}return String.fromCharCode.apply(null,awwoUuidCodes)',
};
const R128_CUBIC_POLY = {
  what: 'CubicPoly, from a Stack Overflow answer',
  after: ['function vl(){'], before: '}gl.prototype.isArcCurve=!0;',
  sha256: '94c0566b44b6f48fadcb02ff6e0c3a748e3a6bdc920f87a704c3511cb8f49780',
  put: "/* AwwO's own code, in place of what three.js took from a Stack Overflow answer (CC BY-SA) */"
    + 'let start=0,end=0,startSlope=0,endSlope=0;const parabolaSlope=(a,b,c,h0,h1)=>(h1*(b-a)/h0+h0*(c-b)/h1)/(h0+h1);'
    + 'return{initCatmullRom:function(before,from,to,after,tension){start=from,end=to,startSlope=tension*(to-before),endSlope=tension*(after-from)},'
    + 'initNonuniformCatmullRom:function(before,from,to,after,h0,h1,h2){start=from,end=to,startSlope=parabolaSlope(before,from,to,h0,h1)*h1,'
    + 'endSlope=parabolaSlope(from,to,after,h1,h2)*h1},'
    + 'calc:function(t){const u=1-t,w=t*t*(3-2*t),along=w<.5?start+(end-start)*w:end-(end-start)*(1-w);'
    + 'return along+(startSlope*u*u+endSlope*t*(t-1))*t}}',
};
// The knot spacing in CatmullRomCurve3's getPoint(), its four points named a, h, u and o and its three cubics xl, _l and wl.
const R128_KNOTS = {
  what: "CatmullRomCurve3's knot spacing, from a Stack Overflow answer",
  after: ['"centripetal"===this.curveType||"chordal"===this.curveType){'], before: '}else"catmullrom"===this.curveType&&(',
  sha256: 'd08bb82e7fa762ef3de56e9a66c0e36af69ef85d920502646b9ee4f5e29fdad3',
  put: "/* AwwO's own code, in place of what three.js took from a Stack Overflow answer (CC BY-SA) */"
    + 'const power="chordal"===this.curveType?.5:.25,middle=Math.pow(h.distanceToSquared(u),power),first=Math.pow(a.distanceToSquared(h),power),'
    + 'last=Math.pow(u.distanceToSquared(o),power),h1=middle<1e-4?1:middle,h0=first<1e-4?h1:first,h2=last<1e-4?h1:last;'
    + 'xl.initNonuniformCatmullRom(a.x,h.x,u.x,o.x,h0,h1,h2),_l.initNonuniformCatmullRom(a.y,h.y,u.y,o.y,h0,h1,h2),'
    + 'wl.initNonuniformCatmullRom(a.z,h.z,u.z,o.z,h0,h1,h2)',
};
// DataUtils, whose one function, toHalfFloat(), three.js r128 took from a Game Development Stack Exchange answer: the
// class goes, and one made in a closure, with its own view of a float's bytes, takes its place. The half is the same
// for every number but NaN and one beyond the half's range: the first gives NaN (r128 gave infinity), the second
// infinity (r128 gave infinity with the float's own mantissa bits set, a number no half has).
const R128_HALF_FLOAT = {
  what: 'DataUtils.toHalfFloat(), from a Game Development Stack Exchange answer',
  after: ['t.DataTextureLoader=dl,t.DataUtils='], before: ',t.DecrementStencilOp=7683',
  sha256: '7c2aa8ca0b45e039c36131dc5660a51e6eb8f0bfd590a284fa3fbcd230054ed6',
  put: "(()=>{/* AwwO's own code, in place of what three.js took from a Stack Exchange answer (CC BY-SA) */"
    + 'const view=new DataView(new ArrayBuffer(4));return class{static toHalfFloat(value){view.setFloat32(0,value);'
    // The float's bits; the exponent rebiased for a half (15), the significand with its leading one.
    + 'const bits=view.getUint32(0),sign=bits>>>16&32768,exponent=(bits>>>23&255)-112,significand=8388608|8388607&bits;'
    + 'if(exponent>30)return sign|((bits>>>23&255)===255&&8388607&bits?32256:31744);'
    // A normal half: ten bits of the significand, rounded up when the next is set (a carry into the exponent is right).
    + 'if(exponent>0)return sign+(exponent<<10)+(significand>>>13&1023)+(significand>>>12&1);'
    // A subnormal half: the significand in units of 2^-24, rounded the same way; below 2^-24, zero.
    + 'if(exponent>-10)return sign+(significand>>>14-exponent)+(significand>>>13-exponent&1);'
    + 'return sign}}})()',
};
/** The files that hold them, by package directory under node_modules and the release each was written for. */
export const CUT_FILES = [
  { pkg: 'three', version: '0.186.1', file: 'build/three.module.js', cuts: [DITHERING, BICUBIC] },
  { pkg: 'three', version: '0.186.1', file: 'build/three.core.js', cuts: [UUID_TABLE, UUID, CUBIC_POLY, KNOTS] },
  { pkg: 'three', version: '0.186.1', file: 'examples/jsm/utils/GeometryUtils.js', cuts: [HILBERT] },
  { pkg: 'three-r128', version: '0.128.0', file: 'build/three.min.js',
    cuts: [DITHERING, R128_UUID_TABLE, R128_UUID, R128_CUBIC_POLY, R128_KNOTS, R128_HALF_FLOAT] },
];
/** Text that no file a build emits may hold, from what the cuts take out: names in the two shaders' code, and the
 * links and comments three.js's files give with the code from Stack Overflow, Stack Exchange and OpenProcessing (the
 * cuts take each with its code; a minified build drops them with every comment, a copy as text keeps them). */
export const CUT_MARKS = ['dither_shift_RGB', 'LodSizeInv', 'stackoverflow.com/questions/105034', 'stackoverflow.com/questions/9489736',
  'safety check for repeated points', 'gamedev.stackexchange.com/questions/17326', 'openprocessing.org/sketch/15493', 'openprocessing.org/user/5654'];
/** Where a file of three.js credits code under CC BY-SA: Stack Overflow, the other Stack Exchange sites, OpenProcessing. */
const SHARE_ALIKE_LINK = /\b(?:[a-z]+\.)?(?:stackoverflow\.com|stackexchange\.com|serverfault\.com|superuser\.com|askubuntu\.com|mathoverflow\.net|openprocessing\.org)\/[^\s"'`)\]}>\\]*/gi;
/** The links of that kind that files the builds take in keep: references, read by hand (2026-10-19), beside code of
 * three.js's own: a frustum's edges read from a projection matrix (the answer draws the technique and writes the
 * identity), an ellipse transformed by a matrix (the question describes the maths) and a header a loader reads (the
 * question explains why a server drops it). */
const REFERENCES = ['computergraphics.stackexchange.com/a/4765', 'math.stackexchange.com/questions/4544164', 'serverfault.com/questions/482875'];
/** Of the two packages, the only files a build may take in: three's core and module builds and its add-ons but the
 * TSL ones, and r128's minified build (the load hook cuts those in CUT_FILES). Anything else of theirs brings back
 * what the cuts take out: three's sources and its other builds repeat it, and its WebGPU and TSL code takes more from
 * Shadertoy (TextureBicubic.js, Hash.js, WGSLNodeBuilder.js and TSL add-ons). */
const PACKAGE_FILE = /(?:^|\/)node_modules\/(three|three-r128)\/([^?]*)/;
const SHIPPABLE = { three: /^(?:build\/three\.(?:core|module)\.js|examples\/jsm\/(?!tsl\/).+)$/, 'three-r128': /^build\/three\.min\.js$/ };

const sha256 = text => createHash('sha256').update(text).digest('hex');
const posixPath = id => id.replace(/\\/g, '/');

/** The text with a cut made; throws when its markers are not where they were, or the piece is not the one expected. */
export function cutCode(text, cut, label) {
  const first = cut.after[0];
  if (text.split(first).length !== 2) throw new Error(`${label}: ${JSON.stringify(first)} is not in it exactly once, so ${cut.what} cannot be found.`);
  let end = 0;
  for (const marker of cut.after) {
    const at = text.indexOf(marker, end);
    if (at < 0) throw new Error(`${label}: ${JSON.stringify(marker)} does not follow, so ${cut.what} cannot be found.`);
    end = at + marker.length;
  }
  const stop = text.indexOf(cut.before, end);
  if (stop < 0) throw new Error(`${label}: ${JSON.stringify(cut.before)} does not follow, so ${cut.what} cannot be found.`);
  const body = text.slice(end, stop);
  if (sha256(body) !== cut.sha256) {
    throw new Error(`${label}: the code where ${cut.what} was is not that code any more (sha256 ${sha256(body)}). Check what is there `
      + 'for code under such terms and update scripts/three-cuts.mjs.');
  }
  return text.slice(0, end) + cut.put + text.slice(stop);
}

/** Which of CUT_FILES a module id names (any query), or undefined. */
export function cutFile(id) {
  const path = posixPath(id.split('?')[0]);
  return CUT_FILES.find(entry => path.endsWith(`/node_modules/${entry.pkg}/${entry.file}`));
}

/** The text the builds ship for one of CUT_FILES at this path: the file with its cuts made, after checking that its
 * package is the release they were written for. */
export function shippedText(path) {
  const entry = cutFile(path);
  if (!entry) throw new Error(`${path} is none of the files scripts/three-cuts.mjs cuts.`);
  const file = posixPath(path.split('?')[0]);
  const dir = file.slice(0, file.length - entry.file.length - 1);
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (version !== entry.version) {
    throw new Error(`node_modules/${entry.pkg} is ${version}, not the ${entry.version} scripts/three-cuts.mjs cuts code out of. Check `
      + 'the new release for code under such terms and update the cuts.');
  }
  return entry.cuts.reduce((text, cut) => cutCode(text, cut, `node_modules/${entry.pkg}/${entry.file}`), readFileSync(file, 'utf8'));
}

/** A module id or file name of either package that no build may take in (see SHIPPABLE), or undefined. */
export function strayFile(source) {
  const match = PACKAGE_FILE.exec(posixPath(source));
  return match && !SHIPPABLE[match[1]].test(match[2]) ? source : undefined;
}

/** A text, then the text of each base64 data: URL in it (an inlined asset or worker). */
function* withInlined(text) {
  yield text;
  for (const match of text.matchAll(/data:[^,"'`\s]*;base64,([A-Za-z0-9+/]+=*)/g)) yield Buffer.from(match[1], 'base64').toString('latin1');
}

/** The first link in a text, as it is or inside a base64 data: URL, to a source of code under CC BY-SA that is none of
 * REFERENCES (each a whole post: a longer id is another one), or undefined. */
export function shareAlikeLink(text) {
  for (const part of withInlined(text)) {
    for (const [link] of part.matchAll(SHARE_ALIKE_LINK)) {
      const lower = link.toLowerCase();
      if (!REFERENCES.some(reference => lower.startsWith(reference) && /^(?:$|[/?#])/.test(lower.slice(reference.length)))) return link;
    }
  }
  return undefined;
}

/** The plugin, for both build configs (also as a worker plugin) and both test configs. */
export function withoutCutCode() {
  const texts = new Map();
  return {
    name: 'awwo-three-cuts',
    enforce: 'pre',
    load(id) {
      if (id.startsWith('\0') || !cutFile(id)) return null;
      const query = id.includes('?') ? id.slice(id.indexOf('?') + 1) : '';
      const keys = [...new URLSearchParams(query).keys()];
      // raw: the text a preview loads; import: what the dev server adds to a module's URL.
      if (keys.some(key => key !== 'raw' && key !== 'import')) {
        this.error(`${id} would ship one of three.js's files without the cuts scripts/three-cuts.mjs makes in it: import it as code or as `
          + '?raw text.');
      }
      const path = id.split('?')[0];
      if (!texts.has(path)) texts.set(path, shippedText(path));
      return keys.includes('raw') ? `export default ${JSON.stringify(texts.get(path))};` : texts.get(path);
    },
    // Every file of either package a build takes in, as code or as text, cut or not, before any other plugin's
    // transform: one that credits a source of code under CC BY-SA, but for the references, stops the build (an add-on
    // the app or the preview starts to use may hold such code, as EXRLoader.js and MeshSurfaceSampler.js do).
    transform(code, id) {
      if (id.startsWith('\0') || !PACKAGE_FILE.test(posixPath(id))) return null;
      const link = shareAlikeLink(code);
      if (link) {
        this.error(`${id} credits ${link}, where code is under CC BY-SA: check what three.js took from there and cut it out `
          + '(scripts/three-cuts.mjs), or, if the link is only a reference, add it to the references there.');
      }
      return null;
    },
    // After the other plugins', so that every file the build writes is checked. A chunk names its modules by absolute
    // id, an asset its file from the root.
    generateBundle: { order: 'post', handler(_options, bundle) {
      for (const file of Object.values(bundle)) {
        const sources = file.type === 'chunk' ? Object.keys(file.modules) : file.originalFileNames ?? [];
        const stray = sources.map(strayFile).find(Boolean);
        if (stray) {
          this.error(`${file.fileName} holds ${stray}: of three.js the builds take in only its core and module builds and its add-ons but `
            + "the TSL ones, and r128's three.min.js; its other files repeat what scripts/three-cuts.mjs cuts out (code under CC BY-NC-SA or "
            + 'CC BY-SA terms) or take more from Shadertoy. Find a way without it, or check that file first.');
        }
        const text = file.type === 'chunk' ? file.code : Buffer.from(file.source).toString('latin1');
        const mark = cutMark(text);
        if (mark) {
          this.error(`${file.fileName} holds ${mark}, from what scripts/three-cuts.mjs cuts out of three.js: some file carries it past `
            + 'the cut.');
        }
        // A file of either package taken in as an asset (?url, new URL(...)) passes no transform hook: its own text is
        // checked here. (A chunk's modules were each checked as they were transformed; a chunk may also hold other
        // packages' code, whose strings are none of this check's business.)
        const asset = file.type === 'asset' && sources.some(source => PACKAGE_FILE.test(posixPath(source)));
        const link = asset ? shareAlikeLink(text) : undefined;
        if (link) {
          this.error(`${file.fileName}, from ${sources.join(', ')}, credits ${link}, where code is under CC BY-SA: check what three.js `
            + 'took from there and cut it out (scripts/three-cuts.mjs), or, if the link is only a reference, add it to the references there.');
        }
      }
    } },
  };
}

/** The first of CUT_MARKS a file's text holds, as it is or inside a base64 data: URL (an inlined asset or worker). */
export function cutMark(text) {
  for (const part of withInlined(text)) {
    const found = CUT_MARKS.find(mark => part.includes(mark));
    if (found) return found;
  }
  return undefined;
}

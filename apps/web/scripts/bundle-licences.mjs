// The license texts of the npm code the hosted bundle ships. The hosted build (vite.saas.config.mjs) minifies the
// packages' code, which drops the license comments it carries, and serves other files of theirs as they are (pdf.js's
// worker, character maps and fonts, the three.js modules a running preview loads) under hashed names, with no license
// file beside them; MIT, ISC, BSD and Apache-2.0 each ask that copies carry the license. So this plugin writes one text
// file to the root of the site, OUTPUT: for every package the bundle holds code or files of, the license and notice
// files at its top, in each directory between it and those files and in the directories ALSO names; the comment at the
// top of a file the build minifies when that comment grants a license (vfile's lib/minpath.browser.js does, for code it
// took from path-browserify and Node.js); and the texts SUPPLEMENTS keeps in licences/ for code that came with no
// license of its own, or that a package took from another open-source project without that project's license. Its text
// is COMMITTED, so that a person reads each license before it ships: the build fails when the bundle needs a text that
// file lacks, and `npm run licences:saas` (scripts/write-bundle-licences.mjs) writes the file again from a full build. The build also fails on the ways it knows of for npm code to enter unseen: a stylesheet
// (also a page's <style>) that pulls in npm CSS by @import or CSS Modules' composes/@value … from, which Vite inlines
// without a module; a Web Worker, which Vite bundles in a build of its own; and pdf.js's legacy build, which embeds
// core-js. It does not see a small npm file that a stylesheet's url() or a script's new URL() names, which Vite inlines
// as a data: URL (the app has none).
// tests/saas-bundle-licences.test.ts checks that a full build needs exactly that file.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

/** The committed text, relative to the app root (apps/web), and the file the build writes it to. */
export const COMMITTED = 'src/saas/bundleLicences.txt';
export const OUTPUT = 'third-party-licenses.txt';
/** Set to true on globalThis by `npm run licences:saas`, in its own process and never from the environment: the build then writes COMMITTED. */
export const WRITE = Symbol.for('awwo.bundleLicences.write');

const LICENCE_FILE = /(?:^|[._-])(?:(?:UN)?LICEN[CS]ES?|COPYING|COPYRIGHT|NOTICES?|PATENTS|THIRD[-_ ]?PARTY[-_ ]?NOTICES?|OFL)(?:[._-]|$)/i;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|css|map|html?)$/i;
const STYLE_FILE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/i;
// A module a build tool writes into the bundle itself, from no file under node_modules: Vite's module preload helpers,
// Rolldown's runtime helpers.
const TOOL_MODULE = /^\0(vite|rolldown)\//;
// Vite's LICENSE.md goes on, after Vite's own license, to give those of the packages Vite's own build bundles into it,
// none of which reaches a browser: only the part before that heading is taken.
const OWN_PART = new Map([['vite/LICENSE.md', '\n# Licenses of bundled dependencies\n']]);
// License files in a directory the bundle uses that cover other files of it: each is left out while every file the
// bundle takes from that directory (and below) is one `others` names, and comes back by itself once any other ships.
const LEFT_OUT = [
  { name: 'pdfjs-dist', file: 'standard_fonts/LICENSE_LIBERATION', others: /^standard_fonts\/(?:Foxit[A-Za-z]+\.pfb|LICENSE_FOXIT)$/,
    reason: 'it covers the Liberation Sans fonts, which this site does not ship (pdf.js asks for them only when it may not use the system\'s fonts)' },
  { name: 'three', file: 'examples/jsm/misc/SculptGL.LICENSE.txt', others: /^examples\/jsm\/misc\/GPUComputationRenderer\.js$/,
    reason: 'it covers the Sculptor modules, which this site does not ship' },
];
// Directories whose license files come with a file outside them: pdf.js's worker embeds the JavaScript of pdf.js's
// qcms, OpenJPEG and JBIG2 builds, whose licenses it keeps in wasm/ beside their WebAssembly, which this site does not ship.
const ALSO = [{ name: 'pdfjs-dist', uses: /^build\/pdf\.worker(?:\.min)?\.mjs$/, directory: 'wasm' }];
// Texts kept in licences/ for code that came with no license of its own, and for code a package's file says it took,
// ported or adapted from another open-source project whose license that package does not carry. Each is pinned by the
// SHA-256 of the file a person read and by the version of the package it was read for: a changed file, or another
// version, stops the build until someone has checked the text again. `uses` is a file of the package the bundle ships,
// `helper` a tool's helper module. three.js comes twice: 0.186.1, and 0.128.0 (installed as three-r128), whose
// build/three.min.js holds the same kind of code under older credits.
const PDF_WORKER = /^build\/pdf\.worker(?:\.min)?\.mjs$/, THREE_CORE = /^build\/three\.core\.js$/, THREE_MODULE = /^build\/three\.module\.js$/;
const THREE_R128 = /^build\/three\.min\.js$/;
const SVG_LOADER = /^examples\/jsm\/loaders\/SVGLoader\.js$/;
const SUPPLEMENTS = [
  { name: 'pdfjs-dist', version: '6.3.289', uses: PDF_WORKER, file: 'licences/LICENSE-brotli.txt',
    sha256: '2a57418d6b10947fe0dfbec3a600269e2745136c125cbf15b256e5ae18af23cb',
    label: 'Brotli\'s license, for the decoder its worker embeds (external/brotli/LICENSE_BROTLI in pdf.js at v6.3.289)' },
  { name: 'pdfjs-dist', version: '6.3.289', uses: PDF_WORKER, file: 'licences/NOTICE-brotli-decode.txt',
    sha256: '192a8ef8abda29b039350d266468f1499d3e0f6647514990fe54e2e57e45e60c',
    label: 'the comment at the top of that decoder, which its build drops (external/brotli/decode.js in pdf.js at v6.3.289)' },
  { name: 'pdfjs-dist', version: '6.3.289', uses: PDF_WORKER, file: 'licences/LICENSE-emscripten.txt',
    sha256: '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86',
    label: 'Emscripten\'s license, for the runtime its compiler writes into the JavaScript of the OpenJPEG and JBIG2 decoders the worker embeds (LICENSE in Emscripten, the same from 4.0.23 to 5.0.7, the releases current when pdf.js built those decoders, on 2026-02-13 and 2026-04-23, from emsdk:latest)' },
  { name: 'pdfjs-dist', version: '6.3.289', uses: PDF_WORKER, file: 'licences/LICENSE-wasm-bindgen-mit.txt',
    sha256: '378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
    label: 'wasm-bindgen\'s license (the MIT one of the two it offers), for the glue it writes into the JavaScript of the qcms build the worker embeds (LICENSE-MIT in wasm-bindgen, the same from 0.2.100 to 0.2.129, around pdf.js\'s qcms build of 2026-07-27)' },
  { name: 'three', version: '0.186.1', uses: THREE_CORE, file: 'licences/LICENSE-earcut-3.0.2.txt',
    sha256: '324139c19d87af03fda38afea1590e00ca354c4159bdb2ae9e9cec070cfa46a8',
    label: 'earcut\'s license, for the copy of earcut 3.0.2 in build/three.core.js (LICENSE in mapbox/earcut at v3.0.2)' },
  { name: 'three', version: '0.186.1', uses: THREE_CORE, file: 'licences/LICENSE-paper.js.txt',
    sha256: 'f8833a38807922b4652421eb0cf29065400c55abd6f4832b9c3250dae87e1958',
    label: 'paper.js\'s license, for ShapePath\'s port of its Path#getInteriorPoint() and reorientPaths() in build/three.core.js (LICENSE.txt in paperjs/paper.js at 92775f52, the same since 2020)' },
  { name: 'three', version: '0.186.1', uses: THREE_CORE, file: 'licences/LICENSE-gl-matrix.txt',
    sha256: 'af62d31a0cdc1bf95d5e19428c3e0de368b727d9d5b6b6cdb466f8a52e68ad06',
    label: 'gl-matrix\'s license, for Matrix4.invert() in build/three.core.js, which three.js bases on gl-matrix (LICENSE.md in toji/gl-matrix at v3.4.4)' },
  { name: 'three', version: '0.186.1', uses: THREE_CORE, file: 'licences/NOTICE-geometrictools-dist-ray-segment.txt',
    sha256: '33b0bc55a7218588bef0b5d8d387ee083b3c1eb6b56a6ececbf7be908b3f4f88',
    label: 'the notice of Geometric Tools\' GteDistRaySegment.h, which Ray.distanceSqToSegment() in build/three.core.js comes from (in pmjoniak/GeometricTools, a copy of David Eberly\'s GTEngine, at ae6e933f)' },
  { name: 'three', version: '0.186.1', uses: THREE_CORE, file: 'licences/LICENSE-boost-1.0-geometrictools.txt',
    sha256: '8d8291caf1cee26d23acf3eb67c9f9a2d58f1c681b16a4fbe8cbfb9e3c0b5a9b',
    label: 'the Boost Software License that notice names (LICENSE in pmjoniak/GeometricTools at ae6e933f)' },
  { name: 'three', version: '0.186.1', uses: THREE_CORE, file: 'licences/NOTICE-mathgeolib-sphere.txt',
    sha256: '7b4b3c57712161e2077a136c7721a441b607c49e2be038a0f3f6e39c3b9cf20d',
    label: 'the notice of MathGeoLib\'s Sphere.cpp, for Sphere.expandByPoint() and union() in build/three.core.js, which three.js r128 credits to it and later releases keep without the credit (src/Geometry/Sphere.cpp in juj/MathGeoLib at 2940b99b, written in Latin-1)' },
  { name: 'three', version: '0.186.1', uses: THREE_CORE, file: 'licences/LICENSE-apache-2.0.txt',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    label: 'the Apache License 2.0 that notice names (LICENSE-2.0.txt from apache.org)' },
  { name: 'three', version: '0.186.1', uses: THREE_CORE, file: 'licences/LICENSE-lightgl.js.txt',
    sha256: '223d9247d30f9d8f842cca7de8e2454d104edb435674305ef3df473bae17d44b',
    label: 'lightgl.js\'s license, for CameraHelper in build/three.core.js, based on the frustum of lightgl.js\'s shadow map example (LICENSE in evanw/lightgl.js at 2581efd1)' },
  { name: 'three', version: '0.186.1', uses: THREE_MODULE, file: 'licences/LICENSE-ltc-code.txt',
    sha256: '692a54e97fcadd0f04b14027386e53809c1dcf96de3e15b15af15731b15c1e94',
    label: 'ltc_code\'s license, for the area lights\' linearly transformed cosines and the ACES fit RRTAndODTFit() in build/three.module.js\'s shaders, which three.js\'s sources credit to it in GLSL comments its build strips (LICENSE in selfshadow/ltc_code at 31e5e96b)' },
  { name: 'three', version: '0.186.1', uses: THREE_MODULE, file: 'licences/LICENSE-filament.txt',
    sha256: '02d70b593dd8e9355dd8e1ca8d13c303bee5bcaf3065b66ff6e4f534e1e6a2c1',
    label: 'Filament\'s license, for D_Charlie(), V_Neubelt(), the anisotropy code and the AgX tone mapping in build/three.module.js\'s shaders, which three.js\'s sources credit to Filament\'s code and documentation (LICENSE in google/filament at fc6744ba, which merged its AgX tone mapper; the same at main)' },
  { name: 'three', version: '0.186.1', uses: THREE_MODULE, file: 'licences/LICENSE-apache-2.0.txt',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    label: 'glTF-Sample-Viewer\'s license, for the transmission code in build/three.module.js\'s shaders, which three.js\'s sources base on it, and the iridescence functions evalSensitivity() and evalIridescence(), which follow its iridescence.glsl, comments included (LICENSE.md in KhronosGroup/glTF-Sample-Viewer at f6fa7574, the same since 2019: the Apache License 2.0 as apache.org gives it)' },
  { name: 'three', version: '0.186.1', uses: THREE_MODULE, file: 'licences/NOTICE-agx-minimal.txt',
    sha256: 'fa303e2dfcdaebe8d210304700088a090d9a7c7c8edb84ce74cf1deca63c2384',
    label: 'the notice of Missing Deadlines\' minimal AgX, for agxDefaultContrastApprox() in build/three.module.js\'s shaders (the listing in the appendix of iolite-engine.com/blog_posts/minimal_agx_implementation, read on 2026-10-18)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/environments\/RoomEnvironment\.js$/, file: 'licences/NOTICE-model-viewer-environment-scene.txt',
    sha256: 'b608791cc198a537e976fa3c395c367e953b6fc29238fcf920443d58635ef1c4',
    label: 'the notice of model-viewer\'s EnvironmentScene.ts, which RoomEnvironment.js is based on (packages/model-viewer/src/three-components/EnvironmentScene.ts in google/model-viewer at 2aeefa32, the version current when three.js r117 added RoomEnvironment.js)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/environments\/RoomEnvironment\.js$/, file: 'licences/LICENSE-apache-2.0.txt',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    label: 'the Apache License 2.0 that notice names (LICENSE-2.0.txt from apache.org)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/objects\/Sky\.js$/, file: 'licences/NOTICE-kocmoc-demo.txt',
    sha256: 'f8b0a4e69a58f1e35379230ab2c9e23d854a81894405e56731129ae160a5ecdd',
    label: 'the license section of Simon Wallner\'s kocmoc-demo, for Sky.js\'s sky shader, which comes from that project\'s media/shaders/sky.frag and scattering.glsl; it puts the project\'s source code under the MIT license and its "media files (textures, sounds, etc...)" under CC BY-NC-SA, and Wallner\'s page on the shader (simonwallner.at/project/atmospheric-scattering) says "the source files are licensed under the MIT license and assets are license under the creative commons license" (README.rst in SimonWallner/kocmoc-demo at c4d23868, its RTVIS branch, where those shaders are)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/shaders\/DigitalGlitch\.js$/, file: 'licences/NOTICE-unityglitch.txt',
    sha256: '176e1006e1e8ec5b79c3fde7d9c7f7e6bd22b4d2796d80d695ff14b2129bcccb',
    label: 'the license of staffantan\'s unityglitch, for DigitalGlitch.js, based on its glitch shader for Unity (README in staffantan/unityglitch at dac385b8: the Creative Commons Attribution 3.0 Unported License)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/libs\/stats\.module\.js$/, file: 'licences/LICENSE-stats.js.txt',
    sha256: '9d23ed2d037cc4b97860dc61dc3787ca2c1faac8b11402064a6fa90e91360adc',
    label: 'stats.js\'s license, for examples/jsm/libs/stats.module.js, stats.js r16 (LICENSE in mrdoob/stats.js at r16)' },
  { name: 'three', version: '0.186.1', uses: SVG_LOADER, file: 'licences/LICENSE-svg-numbers.txt',
    sha256: '94bf05d174a5097c436b8d49702c4ff7f50261c6da6bbd3b9164c8b4669decfa',
    label: 'svg-numbers\' license, for the number parser examples/jsm/loaders/SVGLoader.js takes from it (LICENSE in ppvg/svg-numbers at e3e8e311)' },
  { name: 'three', version: '0.186.1', uses: SVG_LOADER, file: 'licences/NOTICE-kopp-dsyev2.txt',
    sha256: '546e88c04ebff4d58fa3e2a96fd6f202a876100f79927e213f8226ab0f250503',
    label: 'the notice of Joachim Kopp\'s dsyev2.c, the eigensolver for symmetric 2x2 matrices that SVGLoader.js adapts in eigenDecomposition(), under the GNU LGPL 2.1 or later (dsyev2.c in dsyev2-C-1.0.tar.gz from www.mpi-hd.mpg.de/personalhomes/globes/3x3)' },
  { name: 'three', version: '0.186.1', uses: SVG_LOADER, file: 'licences/LICENSE-lgpl-2.1-kopp.txt',
    sha256: '0a7e6662e43a02c5dc761b64d9b32a79856afbbb78fcba772f8466a589ddb1e9',
    label: 'the GNU Lesser General Public License 2.1 that notice names (COPYING in the same archive)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/math\/ConvexHull\.js$/, file: 'licences/LICENSE-quickhull3d.txt',
    sha256: '583f44e645afa79058068d52b60f312e169f580163fc2772ccf5418904dcda60',
    label: 'quickhull3d\'s license, for examples/jsm/math/ConvexHull.js, a port of quickhull3d (LICENSE in mauriciopoppe/quickhull3d at bef4fb45, added in 2021 with its year left as YYYY; its package said MIT before)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/(?:shaders\/SMAAShader|postprocessing\/SMAAPass)\.js$/, file: 'licences/LICENSE-smaa.txt',
    sha256: '70086e9cb87b85f58919782bd387abc471f57e3243fb3b693ba0305e6cf6a228',
    label: 'SMAA\'s license, for SMAAShader.js, a port of SMAA 2.8, and the lookup textures SMAAPass.js embeds (LICENSE.txt in iryoku/smaa at v2.8)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/shaders\/SSAOShader\.js$/, file: 'licences/LICENSE-mcnopper-opengl.txt',
    sha256: 'b467b00620b105f5c4d2fbfbce7cb8a7cd6e721ee7a616cd885f473ebc196e65',
    label: 'the license of Norbert Nopper\'s OpenGL examples, for SSAOShader.js, whose shader follows their Example28/shader/ssao.frag.glsl, which it lists as a reference (LICENSE in McNopper/OpenGL at edbc34e2: MIT since 2026-04-13; the repository had no license when three.js took the shader in 2018, and Apache 2.0 from 2022)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/shaders\/(?:BrightnessContrast|HueSaturation|DotScreen)Shader\.js$/, file: 'licences/LICENSE-glfx.js.txt',
    sha256: '223d9247d30f9d8f842cca7de8e2454d104edb435674305ef3df473bae17d44b',
    label: 'glfx.js\'s license, for the brightness-contrast, hue-saturation and dot-screen shaders three.js takes from its filters (LICENSE in evanw/glfx.js at 86ae72ac)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/(?:shaders\/ConvolutionShader|postprocessing\/BloomPass)\.js$/, file: 'licences/NOTICE-o3d-convolution.txt',
    sha256: '15f31a6ab87adf03759c722d7fd043df7d5aafca56aecf7b5bc398d3b46e1d51',
    label: 'the notice of O3D\'s convolution sample, for ConvolutionShader.js, ported from it, and the Gaussian kernel BloomPass.js builds as it does (o3d/samples/convolution.html in Chromium at 11.0.696.0, the same at 9.0.597.0)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/shaders\/VignetteShader\.js$/, file: 'licences/NOTICE-3-dreams-of-black.txt',
    sha256: '70d78d43fdf5a15366448573823cbe46b5ebc9eda4f457f1103bb944f5ee6670',
    label: 'how 3 Dreams of Black opens its code, for VignetteShader.js, based on its PaintEffect post-process (README.md in dataarts/3-dreams-of-black at 9c8ef595)' },
  { name: 'three', version: '0.186.1', uses: /^examples\/jsm\/shaders\/VignetteShader\.js$/, file: 'licences/LICENSE-apache-2.0.txt',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    label: 'the Apache License 2.0 that README names (LICENSE-2.0.txt from apache.org)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/LICENSE-earcut-2.2.2.txt',
    sha256: 'cd661c432ea8243974e6fde6fc433ebee3e96525ca8b66321b9d9971674ede60',
    label: 'earcut\'s license, for build/three.min.js\'s port of earcut 2.2.2 (LICENSE in mapbox/earcut at v2.2.2)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/NOTICE-geometrictools-dist-ray-segment.txt',
    sha256: '33b0bc55a7218588bef0b5d8d387ee083b3c1eb6b56a6ececbf7be908b3f4f88',
    label: 'the notice of Geometric Tools\' GteDistRaySegment.h, which Ray.distanceSqToSegment() comes from (in pmjoniak/GeometricTools, a copy of David Eberly\'s GTEngine, at ae6e933f; three.js r128 names it at www.geometrictools.com)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/NOTICE-geometrictools-intr-ray3-triangle3.txt',
    sha256: 'efa1f7cf1993281ffb95a6b9f8c31023792216720774c28916bff80075e5daf4',
    label: 'the notice of Geometric Tools\' GteIntrRay3Triangle3.h, which Ray.intersectTriangle() comes from (the same)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/LICENSE-boost-1.0-geometrictools.txt',
    sha256: '8d8291caf1cee26d23acf3eb67c9f9a2d58f1c681b16a4fbe8cbfb9e3c0b5a9b',
    label: 'the Boost Software License those notices name (LICENSE in pmjoniak/GeometricTools at ae6e933f)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/NOTICE-mathgeolib-sphere.txt',
    sha256: '7b4b3c57712161e2077a136c7721a441b607c49e2be038a0f3f6e39c3b9cf20d',
    label: 'the notice of MathGeoLib\'s Sphere.cpp, which Sphere.expandByPoint() and union() come from (src/Geometry/Sphere.cpp in juj/MathGeoLib at 2940b99b, the commit three.js names, written in Latin-1)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/LICENSE-apache-2.0.txt',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    label: 'the Apache License 2.0 that notice names (LICENSE-2.0.txt from apache.org)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/LICENSE-lightgl.js.txt',
    sha256: '223d9247d30f9d8f842cca7de8e2454d104edb435674305ef3df473bae17d44b',
    label: 'lightgl.js\'s license, for CameraHelper, based on the frustum of lightgl.js\'s shadow map example (LICENSE in evanw/lightgl.js at 2581efd1)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/LICENSE-ltc-code.txt',
    sha256: '692a54e97fcadd0f04b14027386e53809c1dcf96de3e15b15af15731b15c1e94',
    label: 'ltc_code\'s license, for the area lights\' linearly transformed cosines and the ACES fit RRTAndODTFit() in the shaders, which three.js\'s sources credit to it in GLSL comments its build strips (LICENSE in selfshadow/ltc_code at 31e5e96b)' },
  { name: 'three', version: '0.128.0', uses: THREE_R128, file: 'licences/LICENSE-apache-2.0.txt',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    label: 'Filament\'s license, for D_Charlie() and V_Neubelt() in the shaders, which three.js\'s sources credit to Filament\'s brdf.fs (LICENSE in google/filament at 7b80b313, of 2019: the Apache License 2.0 as apache.org gives it)' },
  { name: 'lucide-react', version: '0.468.0', uses: /^dist\/esm\/icons\//, file: 'licences/LICENSE-feather.txt',
    sha256: 'afcab584f9ecaf796069d8b3cd2a02e3135d89743a2cf17def2e7935dad91e5d',
    label: 'Feather\'s license, for the parts of Lucide\'s icons that come from Feather, which its LICENSE above names (LICENSE in feathericons/feather at v4.28.0, the release before Lucide\'s fork of 2020-06-08; the same at v4.29.0)' },
  { name: 'react-dom', version: '19.2.6', uses: /^cjs\/react-dom-client\.[a-z]+\.js$/, file: 'licences/LICENSE-modernizr.txt',
    sha256: '0145debb9e5fc97a7b40e5d9c6ae7aa59072f36097acd22eda33be12fa0777cd',
    label: 'Modernizr\'s license, for the event check react-dom-client takes from "Modernizr 3.0.0pre (Custom Build) | MIT", as its code says (LICENSE in Modernizr/Modernizr at 2b6caa10, of 2021, the first to give the MIT text: until then it held that one line)' },
  { name: 'extend', version: '3.0.2', uses: /\.js$/, file: 'licences/LICENSE-jquery-1.7.2.txt',
    sha256: '0ade425df7c0386e04fbaa6b49e97a71ec504e53a4c01137c4bfb425a9a92344',
    label: 'jQuery\'s MIT license, for extend(), a port of jQuery.extend() as its package says (MIT-LICENSE.txt in jquery/jquery at 1.7.2, the release current when node-extend was written in April 2012; jQuery then offered the MIT License or the GPL 2.0)' },
  { name: 'fflate', version: '0.8.3', uses: /\.[cm]?js$/, file: 'licences/LICENSE-uzip.js.txt',
    sha256: '786adae9320db47cd483f9a8774ebd3edab8876d714caa4fb0aee8e5b2c3edc0',
    label: 'UZIP.js\'s license, for the code fflate says is similar to UZIP.js\'s, its Huffman tree builder among it (LICENSE in photopea/UZIP.js, the same since 2018)' },
  { name: 'vfile', version: '6.0.3', uses: /^lib\/minurl\.(?:browser|shared)\.js$/, file: 'licences/LICENSE-nodejs.txt',
    sha256: 'fbc04dcc36cecba7c042277274bbbd510ec34c496bd1ebbaf8d5febd1f403ac3',
    label: 'the part of Node.js\'s license that covers Node.js itself, for isUrl() and urlToPath() in lib/minurl.*.js, from Node.js\'s lib/internal/url.js (LICENSE in nodejs/node at 6a3403c, the commit vfile names, up to its list of the libraries Node.js bundles)' },
  { name: 'vite', version: '8.0.16', helper: /^\0vite\/modulepreload-polyfill/, file: 'licences/LICENSE-es-module-shims.txt',
    sha256: '13dc18f97f767475f7ad48fdd12a2e45be30fb309c604730f406f625cf7d8f7f',
    label: 'es-module-shims\' license (its LICENSE from 1.0.0 to 1.5.18), for the module preload polyfill Vite adapted from it, which Rolldown 1.0.3 writes without that notice' },
  { name: 'rolldown', version: '1.0.3', helper: /^\0rolldown\/runtime/, file: 'licences/LICENSE-rolldown-third-party.txt',
    sha256: 'a877291d800ed43692f3f9ae09d8e01cc6f7293ad39d43896059c188ffbb8b7c',
    label: 'the licenses its LICENSE links (Rollup\'s and esbuild\'s), for its runtime helpers, which derive from esbuild\'s (THIRD-PARTY-LICENSE in Rolldown at v1.0.3)' },
];
// Files of a package that need a license this plugin does not carry: the build stops on them.
const REFUSED = [{ name: 'pdfjs-dist', files: /^legacy\//,
  reason: 'pdf.js\'s legacy build embeds core-js as well, whose license this plugin does not carry: add it to SUPPLEMENTS, and the legacy worker to ALSO and to the Brotli texts, before shipping it' }];
// The words of a license grant, which a file's own comment holds when the file has code from elsewhere in it.
const GRANT = /permission is hereby granted|permission to use, copy, modify|redistribution and use in source and binary forms|licensed under the apache license/i;
// A CSS string in either quote, which may hold spaces, the other quote and escapes; the same without its groups.
const STRING = String.raw`"((?:[^"\\\n]|\\[^])*)"|'((?:[^'\\\n]|\\[^])*)'`, ANY_STRING = String.raw`"(?:[^"\\\n]|\\[^])*"|'(?:[^'\\\n]|\\[^])*'`;
// What a stylesheet pulls in from another file: @import "x", 'x', url(x), url("x") or url('x'), and CSS Modules'
// composes: … from "x" and @value … from "x".
const STYLE_IMPORTS = [new RegExp(String.raw`@import\b\s*(?:url\(\s*(?:${STRING}|((?:[^)\s"'\\]|\\[^])*))\s*\)|${STRING})`, 'gi'),
  new RegExp(String.raw`\bcomposes\s*:[^;{}]*?\bfrom\s+(?:${STRING})`, 'gi'), new RegExp(String.raw`@value\s[^;{}]*?\bfrom\s+(?:${STRING})`, 'gi')];
// A comment, or a string, which may hold what looks like one.
const COMMENT_OR_STRING = new RegExp(String.raw`\/\*[^]*?\*\/|${ANY_STRING}`, 'g');
/** The name a CSS string or url() spells, without its escapes: \hex and one white space after it, an escaped line break, \c. */
const unescapeCss = value => value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([^]))/gi, (_, hex, lineBreak, char) => {
  if (lineBreak !== undefined) return '';
  if (char !== undefined) return char;
  const code = parseInt(hex, 16);
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);
});
const RULE = '='.repeat(80);

const text = bytes => bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The package directory a file under node_modules belongs to, and the file's path inside it (POSIX); null for others. */
export function packageOf(file) {
  const path = file.replace(/\\/g, '/'), at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const parts = path.slice(at + '/node_modules/'.length).split('/'), length = parts[0]?.startsWith('@') ? 2 : 1;
  if (parts.length <= length || parts.slice(0, length + 1).some(part => !part)) return null;
  return { dir: path.slice(0, at + '/node_modules/'.length) + parts.slice(0, length).join('/'), file: parts.slice(length).join('/') };
}

/** The comments a file starts with, after a byte order mark or a #! line, exactly as written; '' when code comes first. */
export function leadingComment(source) {
  let at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.startsWith('#!', at)) { const end = source.indexOf('\n', at); at = end < 0 ? source.length : end + 1; }
  let start = -1, end = at;
  for (let i = at; i < source.length;) {
    if (/\s/.test(source[i])) { i += 1; continue; }
    let stop;
    if (source.startsWith('//', i)) { const line = source.indexOf('\n', i); stop = line < 0 ? source.length : line; }
    else if (source.startsWith('/*', i)) { const close = source.indexOf('*/', i + 2); if (close < 0) break; stop = close + 2; }
    else break;
    if (start < 0) start = i;
    end = stop; i = stop;
  }
  return start < 0 ? '' : source.slice(start, end);
}

/**
 * What a bundle uses of each package: by package directory, the files it holds code or text of, each marked when the
 * build minified it (so its comments are gone), and the helper modules a build tool wrote into the bundle itself.
 * bundle: generateBundle's bundle, or a build's output files; root: the app root, whose node_modules holds the tools;
 * followed: npm stylesheets that stylesheets of their own package pull in (checkStyleImports), which have no module.
 * Throws on a Web Worker, whose npm code Vite bundles in a build of its own, out of this plugin's sight.
 */
export function bundleUse(bundle, root, followed = []) {
  const use = new Map();
  const entry = dir => {
    if (!use.has(dir)) use.set(dir, { files: new Map(), helpers: new Set() });
    return use.get(dir);
  };
  const add = (file, minified) => {
    const found = packageOf(file);
    if (!found) return;
    const files = entry(found.dir).files;
    files.set(found.file, files.get(found.file) || minified);
  };
  const worker = name => new Error(`${name} is a Web Worker, or another script Vite emits with no source file. The hosted build refuses every `
    + 'one, since the bundle license plugin (scripts/bundle-licences.mjs) cannot see the npm code a separate build put into it: give that build '
    + 'a license check of its own (Vite\'s worker.plugins) before shipping such a script.');
  for (const file of followed) add(file, true);
  for (const output of Object.values(bundle)) {
    if (output.type === 'asset') {
      const sources = output.originalFileNames ?? [];
      if (/\.[cm]?js$/i.test(output.fileName) && !sources.length) throw worker(output.fileName);
      for (const source of sources) add(isAbsolute(source) ? source : resolve(root, source), false);
      continue;
    }
    for (const [id, module] of Object.entries(output.modules ?? {})) {
      const query = id.includes('?') ? id.slice(id.indexOf('?')) : '', path = id.slice(id.startsWith('\0') ? 1 : 0, id.length - query.length);
      if (/[?&](?:shared)?worker(?:_file)?\b/.test(query)) throw worker(path);
      // Vite takes a stylesheet's rules out of its chunk, so the stylesheet's module renders nothing: count it anyway.
      if (!(module.renderedLength > 0) && !STYLE_FILE.test(path)) continue;
      const tool = TOOL_MODULE.exec(id);
      if (tool) { entry(join(root, 'node_modules', tool[1]).replace(/\\/g, '/')).helpers.add(id); continue; }
      // ?raw, ?url and ?inline put a file's bytes into the bundle as they are, except that a stylesheet's ?inline is
      // the CSS Vite made of it; everything else of code is minified.
      const verbatim = /[?&](?:raw|url)(?:&|$)/.test(query) || (/[?&]inline(?:&|$)/.test(query) && !STYLE_FILE.test(path));
      add(path, !verbatim && (/\.[cm]?[jt]sx?$/i.test(path) || STYLE_FILE.test(path)));
    }
  }
  return use;
}

/**
 * Throws when a stylesheet pulls in npm CSS (@import, or CSS Modules' composes/@value … from), itself or through a
 * stylesheet it pulls in by a relative or root path: Vite inlines such a file into the CSS it emits without a module of
 * its own, so bundleUse would not see the package. Within one npm package a stylesheet's import is that package's own
 * (bundleUse sees the stylesheet a script imports); its targets go into `followed`, for bundleUse to count too.
 * resolveId: a plugin context's resolver; root: the app root, for an import from the site's root ("/x.css").
 */
export async function checkStyleImports(source, file, { resolveId, root, followed = new Set() }, seen = new Set()) {
  if (seen.has(file)) return followed;
  seen.add(file);
  const own = packageOf(file)?.dir;
  // A comment is no import, and a /* inside a string starts none.
  const code = source.replace(COMMENT_OR_STRING, found => (found.startsWith('/*') ? '' : found));
  for (const pattern of STYLE_IMPORTS) {
    for (const match of code.matchAll(pattern)) {
      // The one group of the form that matched.
      const specifier = unescapeCss(match.slice(1).find(group => group !== undefined) ?? '');
      // A URL is the browser's to fetch, not the bundle's.
      if (/^(?:https?:|data:|\/\/)/i.test(specifier)) continue;
      let target = specifier.startsWith('.') ? resolve(dirname(file), specifier)
        : specifier.startsWith('/') ? join(root, specifier) : (await resolveId(specifier, file))?.id?.split('?')[0];
      // A module a plugin makes up (an id starting with \0) is no file this check can follow.
      if (target && (target.startsWith('\0') || !isAbsolute(target))) target = undefined;
      const found = target ? packageOf(target) : null;
      if (!target || (found && found.dir !== own)) {
        throw new Error(`${file} pulls in ${specifier}${target ? ` (${target})` : ''}, which Vite inlines without a module of its own, so the bundle `
          + 'license plugin (scripts/bundle-licences.mjs) cannot see its package: import that stylesheet from a script instead.');
      }
      if (found) followed.add(target.replace(/\\/g, '/'));
      let imported;
      try { imported = readFileSync(target, 'utf8'); } catch { continue; }
      await checkStyleImports(imported, target, { resolveId, root, followed }, seen);
    }
  }
  return followed;
}

const licenceFilesIn = (root, directory) => {
  let names;
  try { names = readdirSync(join(root, directory)); } catch { return []; }
  return names.filter(name => LICENCE_FILE.test(name) && !CODE_FILE.test(name) && isFile(join(root, directory, name))).sort().map(name => posix.join(directory, name));
};

/**
 * The license texts one package needs, as parts of the document: its heading; each license or notice file (from its
 * top, then from the directories of the files used, nearest first, then from those ALSO adds); the texts SUPPLEMENTS
 * adds; and each grant in a minified file's leading comment. root: the app root, which holds licences/. Throws when the
 * package has no license file at all, or a supplement no longer matches what was read.
 */
export function packageParts(dir, { files, helpers = new Set() }, root) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const declared = typeof manifest.license === 'string' ? manifest.license : [manifest.license, ...(manifest.licenses ?? [])].filter(Boolean).map(entry => entry.type ?? String(entry)).join(' OR ') || 'no license field';
  const installed = dir.slice(dir.lastIndexOf('/node_modules/') + '/node_modules/'.length);
  const id = `${manifest.name} ${manifest.version}`;
  const heading = `${id} (${declared})${installed === manifest.name ? '' : `, installed as ${installed}`}${helpers.size ? ', for the helpers it writes into the bundle' : ''}`;
  const parts = [{ label: id, text: `${RULE}\n${heading}\n${RULE}\n` }], leftOut = [];
  const shipped = [...files.keys()].sort();
  for (const rule of REFUSED) {
    const file = rule.name === manifest.name ? shipped.find(path => rule.files.test(path)) : undefined;
    if (file) throw new Error(`${id} ships ${file}: ${rule.reason}.`);
  }
  const paths = new Set(licenceFilesIn(dir, ''));
  for (const file of shipped) {
    for (let directory = posix.dirname(file); directory !== '.' && directory !== ''; directory = posix.dirname(directory)) for (const path of licenceFilesIn(dir, directory)) paths.add(path);
  }
  for (const rule of ALSO) if (rule.name === manifest.name && shipped.some(file => rule.uses.test(file))) for (const path of licenceFilesIn(dir, rule.directory)) paths.add(path);
  const licences = [...paths].filter(path => {
    const rule = LEFT_OUT.find(entry => entry.name === manifest.name && entry.file === path);
    if (!rule || !shipped.filter(file => file.startsWith(`${posix.dirname(path)}/`)).every(file => rule.others.test(file))) return true;
    leftOut.push(`${id}, ${path}: ${rule.reason}.`);
    return false;
  });
  if (!licences.length) throw new Error(`${id} (${dir}) is in the bundle but has no license file (LICENSE*, NOTICE*, COPYING*): add its license text by hand, or keep the package out of the hosted bundle.`);
  for (const path of licences) {
    let body = text(readFileSync(join(dir, path)));
    const own = OWN_PART.get(`${installed}/${path}`);
    if (own) {
      if (!body.includes(own)) throw new Error(`${id}'s ${path} no longer has the heading "${own.trim()}" its own license ends at; read the file again.`);
      body = text(Buffer.from(body.slice(0, body.indexOf(own))));
    }
    parts.push({ label: `${id}: ${path}`, text: `----- ${id}: ${path}${own ? ', its own license' : ''} -----\n${body}` });
  }
  for (const supplement of SUPPLEMENTS) {
    if (supplement.name !== manifest.name) continue;
    if (!(supplement.uses ? shipped.some(file => supplement.uses.test(file)) : [...helpers].some(helper => supplement.helper.test(helper)))) continue;
    if (manifest.version !== supplement.version) {
      throw new Error(`${id} is not the ${supplement.name} ${supplement.version} that ${supplement.file} was checked for: check the text against this release, then update its version in scripts/bundle-licences.mjs.`);
    }
    const bytes = readFileSync(join(root, supplement.file));
    if (createHash('sha256').update(bytes).digest('hex') !== supplement.sha256) {
      throw new Error(`${supplement.file} is not the text that was read (its SHA-256 differs): read it, then pin its new hash in scripts/bundle-licences.mjs.`);
    }
    parts.push({ label: `${id}: ${supplement.file}`, text: `----- ${id}: ${supplement.label} -----\n${text(bytes)}` });
  }
  for (const [file, minified] of [...files].sort(([a], [b]) => compare(a, b))) {
    if (!minified) continue;
    const comment = leadingComment(readFileSync(join(dir, file), 'utf8'));
    if (GRANT.test(comment)) parts.push({ label: `${id}: ${file}`, text: `----- ${id}: ${file}, the comment at its top -----\n${text(Buffer.from(comment))}` });
  }
  return { id, parts, leftOut };
}

/** Every package's parts, in the order of the document: by name and version. root: the app root. */
export function neededLicences(use, root) {
  return [...use].map(([dir, entry]) => packageParts(dir, entry, root)).sort((a, b) => compare(a.id, b.id));
}

const PREAMBLE = `Third-party software in AwwO's hosted app
=========================================

AwwO's hosted app is built from AwwO's source, under the MIT License (see LICENSE in
the repository); from third-party files kept in the repository, which its
THIRD_PARTY_NOTICES.md lists with their licenses; and from code and files of the npm
packages below. Building the app minifies their code, which drops the license comments
in it, and serves some of their files as they are: pdf.js's worker, character maps and
two fonts, and the three.js modules a running preview loads (without two shaders, see
below). For each package, at the version the app's lockfile pins, this file carries its
license and notice files, from its top directory and from each directory between it and
a file the app uses (and pdf.js's wasm/ directory, for the loaders its worker embeds),
and the comment at the top of a file the build minifies when that comment grants a
license. It adds, kept in AwwO's repository, the licenses of three pieces of code that
reach the app with no license text of their own: Brotli's decoder in pdf.js's worker,
the module preload polyfill Vite adds (from es-module-shims), and Rolldown's runtime
helpers (with the list of licenses Rolldown's LICENSE links); and the licenses of other
open-source projects whose code a package carries without their license: code a file or
its package's README says it took, ported or adapted, or that follows a project the
file lists as a reference (in three.js also code its sources credit in shader comments
its build strips, and two functions only an older three.js credits), a library kept
whole (stats.js), and the runtime Emscripten and wasm-bindgen write into the loaders of
pdf.js's worker.
Among them: earcut, paper.js, gl-matrix, Geometric Tools, MathGeoLib, lightgl.js,
ltc_code, Filament and glTF-Sample-Viewer in three.js's core and shaders; the
libraries and shaders three.js's add-ons draw on, among them a function of SVGLoader.js
under the GNU LGPL 2.1 or later and DigitalGlitch.js's shader under CC BY 3.0; Feather
in Lucide's icons, Modernizr in React DOM, jQuery in extend, UZIP.js in fflate and
Node.js in vfile. Each is copied as it was written, with LF line ends (MathGeoLib's
notice converted from Latin-1). Not covered: credits that name a paper, a book, an
article or code published without a license, and code under share-alike or
non-commercial Creative Commons terms, which a license text alone does not settle: in
three.js, two Stack Overflow answers and GeometryUtils' two Hilbert curves, from
sketches on OpenProcessing (CC BY-SA). Not shipped: the two shaders three.js took from
Shadertoy, whose default license is CC BY-NC-SA, its renderer's dithering (in r128 too)
and N8's bicubic filtering of the transmission buffer, which the build cuts out of
every copy of three.js the app ships.
`;

/** The whole document for these packages. */
export function licenceDocument(packages) {
  const leftOut = packages.flatMap(entry => entry.leftOut);
  return [PREAMBLE, ...packages.map(entry => entry.parts.map(part => part.text).join('\n')),
    ...(leftOut.length ? [`${RULE}\nLeft out\n${RULE}\n${leftOut.map(line => `- ${line}`).join('\n')}\n`] : [])].join('\n');
}

/** The labels of the parts the committed text lacks, exactly as they would be written. */
export function uncovered(committed, packages) {
  return packages.flatMap(entry => entry.parts).filter(part => !committed.includes(part.text)).map(part => part.label);
}

/** The Vite plugins: one that checks stylesheets before Vite inlines their @imports, one that checks the bundle, one that serves the committed text in the dev server. root: the app root (apps/web). */
export function bundleLicences(root) {
  // npm stylesheets that stylesheets of their own package pull in, which the bundle holds without a module of their own:
  // found while Vite transforms the stylesheets, counted with the bundle.
  const followed = new Set();
  return [{
    name: 'awwo-bundle-licences-styles', apply: 'build', enforce: 'pre',
    buildStart() { followed.clear(); },
    async transform(code, id) {
      const query = id.includes('?') ? id.slice(id.indexOf('?')) : '', file = id.slice(0, id.length - query.length);
      // A stylesheet's CSS, also one a page writes in a <style> (Vite names it page.html?html-proxy&inline-css…); not a
      // ?raw or ?url one, whose text Vite does not inline (it processes a ?url stylesheet again, as ?transform-only).
      const style = STYLE_FILE.test(file) || /[?&]inline-css\b/.test(query);
      if (!id.startsWith('\0') && style && !/[?&](?:raw|url)(?:&|$)/.test(query)) {
        await checkStyleImports(code, file, { resolveId: (specifier, importer) => this.resolve(specifier, importer), root, followed });
      }
      return null;
    },
  }, {
    name: 'awwo-bundle-licences', apply: 'build', enforce: 'post',
    generateBundle(_options, bundle) {
      const packages = neededLicences(bundleUse(bundle, root, followed), root), committed = join(root, COMMITTED);
      if (globalThis[WRITE] === true) writeFileSync(committed, licenceDocument(packages));
      const current = readFileSync(committed, 'utf8'), missing = uncovered(current, packages);
      if (missing.length) {
        throw new Error(`${COMMITTED} lacks license texts this bundle ships: ${missing.join('; ')}. Read what changed, then run `
          + '`npm run licences:saas` in apps/web (a full build that writes the file) and commit it.');
      }
      this.emitFile({ type: 'asset', fileName: OUTPUT, source: current });
    },
  }, {
    // The dev server answers OUTPUT with the committed text, so the app's links to it open it there too (and not the
    // page Vite falls back to).
    name: 'awwo-bundle-licences-serve', apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `/${OUTPUT}`) return next();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(readFileSync(join(root, COMMITTED)));
      });
    },
  }];
}

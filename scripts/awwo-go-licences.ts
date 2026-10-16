#!/usr/bin/env node
// Builds third_party/go-modules/: the license, notice and patent files of the Go code compiled into the AwwO API
// binary, which the API image and the native release archive carry (THIRD_PARTY_NOTICES.md). That code is the Go
// standard library and every module with a package backend/cmd/api links when it is built the way both of them
// build it, for linux/amd64 without cgo. The files are copied unchanged from the Go module cache, from each
// module's root and from every directory between the root and a linked package or a file such a package embeds,
// so a license that covers only part of a module travels too (client_golang's copy of gddo); so does a README there
// that grants a license or names one that no license file above it grants (fiat-crypto's, in Go's nistec/fiat). A
// compiled or embedded file whose own text grants a license, for code its module took from elsewhere (Go's runtime
// and math, fiat-crypto), or names one that the license files of its directory and those above it do not grant, in
// that variant, gives the comment or literal that holds it, with the copyright notice above it (the whole file, when
// there is none), unchanged, as <file>.notice. Finding them is heuristic: grant wording, copyleft and other licenses
// that need a person, SPDX headers and the usual ways of naming a license; a file that took code from elsewhere under
// its module's own license, or names another license in words this script does not know, is not found. A module is
// read only after its files hash to its h1: line in backend/go.sum, the check `go mod verify` makes.
//
// Each file copied is one a person has read: REVIEWED pins it, by the SHA-256 of its bytes, to the licenses it
// grants, and the License column of README.md comes from there. A new or changed text stops the collector, which
// names the file and what it looks like, until someone has read it and added it. modules.txt holds the Go version
// the standard library's files were read from, then the modules the way `go version -m` prints a binary's
// dependencies: the image and release builds compare the binary they built, toolchain included, with it.
//
// Usage: node scripts/awwo-go-licences.ts [--check]
//   no flag   write the directory
//   --check   exit 1 if the committed directory differs from what this script would write

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = 'third_party/go-modules';
/** The API image and the native release build the binary for this target. */
export const TARGET = Object.freeze({ GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' });
const STANDARD = 'go';

export type GoModule = { path: string; version: string; dir: string; main: boolean; replaced: boolean };
/** embeds: its go:embed files, compiled: the Go, assembly and header files it compiles, syso: objects it links; relative to dir. */
export type GoPackage = { importPath: string; dir: string; standard: boolean; module?: GoModule; embeds?: string[]; compiled?: string[]; syso?: string[] };
/** Each file's path inside OUTPUT (POSIX) and its exact bytes. */
export type Bundle = Map<string, Buffer>;
// dirs: where its license files are looked for; scanned: the files whose own text is searched for notices.
type Source = { name: string; version: string; root: string; prefix: string; sum?: string; dirs: Set<string>; scanned: Set<string> };

const NOTICE_NAME = /^(?:(?:UN)?LICEN[CS]ES?|COPYING|COPYRIGHT|NOTICES?|PATENTS|THIRD[-_ ]?PARTY[-_ ]?NOTICES?|OFL)(?:[._-][\w.-]*)?$/i;
const CODE_FILE = /\.(?:go|s|c|h|cc|proto|json|ya?ml|sh|py|[cm]?[jt]s|html|tmpl)$/i;
// Documentation that can hold a module's license text, such as Go's crypto/internal/fips140/nistec/fiat/README.
const DOC_NAME = /^(?:README|CREDITS)(?:[._-][\w.-]*)?$/i;
// Module path elements and versions as the go command allows them, so neither can leave OUTPUT.
const MODULE_PATH = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/;
const MODULE_VERSION = /^v[0-9A-Za-z.+-]+$/;
// One package a line; its file lists are joined by U+001F, which no module file name can contain.
const LIST_FORMAT = '{{.ImportPath}}\t{{.Dir}}\t{{.Standard}}\t{{join .EmbedFiles "\\x1f"}}\t{{join .GoFiles "\\x1f"}}{{"\\x1f"}}{{join .SFiles "\\x1f"}}{{"\\x1f"}}{{join .HFiles "\\x1f"}}'
  + '\t{{join .SysoFiles "\\x1f"}}\t{{with .Module}}{{.Path}}\t{{.Version}}\t{{.Main}}\t{{.Dir}}\t{{if .Replace}}replaced{{end}}{{end}}';

/** A license, notice or patent file by its name: LICENSE.libyaml, LICENSE_1_0.txt and ThirdPartyNotices.txt are, pgx's notice_response.go is not. */
export function noticeFile(name: string): boolean {
  return NOTICE_NAME.test(name) && !CODE_FILE.test(name);
}
/** A README or CREDITS file, which counts as a license file when its text grants a license. */
export function docFile(name: string): boolean {
  return DOC_NAME.test(name) && !CODE_FILE.test(name);
}

// Every license, notice and patent file the bundle holds, by the SHA-256 of its bytes, with what it grants: SPDX ids,
// or NOTICE or PATENTS. Each was read in full on 2026-10-16: the Apache-2.0 copies match the license word for word
// (with the appendix's placeholder), and no file adds or removes terms. The comment names where the text appears.
export const REVIEWED: ReadonlyMap<string, string> = new Map([
  ['911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad', 'BSD-3-Clause'], // go, go/src/vendor/golang.org/x/*, golang.org/x/*
  ['96f408bfae65bf137fc2525d3ecb030271c50c1e90799f87abf8846d8dd505cc', 'PATENTS'], // the same, and google.golang.org/protobuf
  ['0db7c9ebb3717e526f34f87dd1ee8bc77d36846e29cb0cec9246f7138fbe962b', 'MIT'], // github.com/beorn7/perks
  ['5c0476add4c38b55d0ed5ac11b85e00c38f26e1caee20dfe3ab58190103d1fbc', 'MIT'], // github.com/cenkalti/backoff/v5
  ['f566a9f97bacdaf00d9f21dd991e81dc11201c4e016c86b470799429a1c9a79c', 'MIT'], // github.com/cespare/xxhash/v2
  ['b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1', 'Apache-2.0'], // github.com/go-logr/logr, go.yaml.in/yaml/v2
  ['c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4', 'Apache-2.0'], // github.com/go-logr/stdr, github.com/prometheus/*, go.opentelemetry.io/auto/sdk, go.opentelemetry.io/proto/otlp
  ['0a8d61ed3cbfd5312326e8126c31ce9c627a283adc99131b56896d29ada04b2d', 'BSD-3-Clause'], // github.com/google/uuid
  ['a15b1d1b168954c92ff7fb1620382418f7c72f4f4d251ee791d1098ad68ab0c4', 'BSD-3-Clause'], // github.com/grpc-ecosystem/grpc-gateway/v2
  ['adb1663fda031df8f4344aa68f299fd87d80353e31339406742ded21dae65702', 'MIT'], // github.com/jackc/pgpassfile
  ['fc505773403fe869ed64cc2235cdd13988a427bb7e3a7e7004a3f4b27420f8fc', 'MIT'], // github.com/jackc/pgservicefile
  ['467f95e074fe23079a5623ed652619682692041b8551da27e3c2ddb9659a1507', 'MIT'], // github.com/jackc/pgx/v5
  ['2d50e98a4900b4d6457a38d39c1432fdc156fc2f7b365f2e33ec9344acbb0057', 'MIT'], // github.com/jackc/puddle/v2
  ['2d36597f7117c38b006835ae7f537487207d8ec407aa9d9980794b2030cbc067', 'BSD-3-Clause'], // github.com/ledongthuc/pdf
  ['aa1376b9bc5dea6f30cdefde40c176a254f247d2814d0a9929395138631b2ae0', 'BSD-3-Clause'], // github.com/munnerz/goautoneg
  ['dfffb9ec737eaba985243e95a549bd8c3a4d462032cfe603e2a6704c346427b6', 'BSD-3-Clause'], // github.com/prometheus/client_golang/internal/github.com/golang/gddo
  ['8548bfb2bc1913396df38c548a6ec60b8dbcac3b0800485a40569c8bdd184471', 'NOTICE'], // github.com/prometheus/client_golang
  ['6c79faa15168885fb88a316ae0df18f486deafddefdc16826cdc56dfbd421e24', 'NOTICE'], // github.com/prometheus/client_model
  ['600244c8052c8c1d307043fafacbc83b429c171dd8e08f5a537c0a54014585ee', 'NOTICE'], // github.com/prometheus/common
  ['497fcdb9fae55924c12f55f05cbe83a096662e5c591d79b74e4a8f23bab5ffee', 'NOTICE'], // github.com/prometheus/procfs
  ['1ae07514be1d7bb33f0698f8d91fb51b8b9fe1463157ec1c72081a49b9bc6f40', 'Apache-2.0, BSD-3-Clause'], // go.opentelemetry.io/otel and its exporters, metric, sdk and trace
  ['a94710b55e03b5285f77d048c5ba61bb9d6ee04a06c0eb90e68821e11b0c707a', 'MIT'], // go.yaml.in/yaml/v2 LICENSE.libyaml: the files ported from libyaml
  ['f6c2dd3a67b576eafb89b80200b8b1627230bf3821a0c14cb99a22ac19107d00', 'NOTICE'], // go.yaml.in/yaml/v2
  ['cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', 'Apache-2.0'], // google.golang.org/genproto/googleapis/{api,rpc}, google.golang.org/grpc
  ['693ff28ec216d5112ac1bbfe64ef539005867d1c7bd427b57d579683293b947f', 'NOTICE'], // google.golang.org/grpc NOTICE.txt
  ['4835612df0098ca95f8e7d9e3bffcb02358d435dbb38057c844c99d7f725eb20', 'BSD-3-Clause'], // google.golang.org/protobuf
  // Source notices (<file>.notice), also read in full: Lucent and Vita Nuova's MIT notice (Inferno's memmove), Sun's
  // "freely granted" notice from FreeBSD's msun (SunPro), Stephen L. Moshier's Cephes notice, fiat-crypto's
  // BSD-1-Clause, Google's Protocol Buffers BSD-3-Clause; the rest of each block is the code's own description.
  ['115b35d4c33d49499560fed05811e006e92db5c1416c6ac0f417753b416d5449', 'MIT'], // go/src/runtime/memmove_amd64.s
  ['558003954908d41ed09bcc3daf891cd32994ac9d204c0a1133e0c06339457029', 'SunPro'], // go/src/math/acosh.go
  ['d2a0d020c35b9e830a694d97ebcfcb506043109080b6ef6bea67c9311c38787d', 'SunPro'], // go/src/math/asinh.go
  ['463e2061abd03c3292bd47abf45a6861fc5658750e90b2fd779dcd7a783d0aa6', 'LicenseRef-Cephes'], // go/src/math/atan.go
  ['8c6afe834ca6fdf58437bbbe5dda52aa260d78fa5a21130fd8ac9f1bb7bd3801', 'SunPro'], // go/src/math/atanh.go
  ['abbc05b6173bb8800201f22499ddda1fd32bf8fd4dac764d14befa911845c365', 'SunPro'], // go/src/math/cbrt.go
  ['9987944df868ce4dfa0150661a90e835bebcfa3a4a174f3067f3e824050356d3', 'SunPro'], // go/src/math/erf.go
  ['625af5f087d09398b307a6fd8eb614ad3aff5103d2821b740e331f44d64001a4', 'SunPro'], // go/src/math/exp.go
  ['fd22bd65488f4f6038e8fd9c511f420d3c3ea4fb904a72759cf7ee814756740e', 'SunPro'], // go/src/math/expm1.go
  ['df317bb61b01d40c7801216d8c0bb53a895df489fe2186ce19f4e74117222f35', 'LicenseRef-Cephes'], // go/src/math/gamma.go
  ['b7b7aec3918b05e745093324ceb27e213ca43ba4906c4491159d8fb143c1615b', 'SunPro'], // go/src/math/j0.go
  ['c8ac067fb0e233288914bafb3f7732d253700aca614372ad21dbcca52e4c3303', 'SunPro'], // go/src/math/j1.go
  ['36d293131ff45b0a0efa706c26e20c65f4a35677569bc039e3c830ab8ce7c0de', 'SunPro'], // go/src/math/jn.go
  ['d8c60c71d695667355f7601da66883f4b5be1e17351fa94fe9a400db772c2f26', 'SunPro'], // go/src/math/lgamma.go
  ['2b6df576e6ea2bfa77285340430fc3dfdad1b2ce311b798aace7076cd6e7eb8a', 'SunPro'], // go/src/math/log.go
  ['c1c717b7c684c104334a1a64543507eb62e47a042260a09ba2deba69ac1dbc17', 'SunPro'], // go/src/math/log1p.go
  ['3fa603a2cd535f4b6575f957c264635c0c873627b3b29d767090c12709e59c8b', 'SunPro'], // go/src/math/remainder.go
  ['833858fc3756c1f011688f8470443265b855a1db92579c8667711c5ee18cadba', 'LicenseRef-Cephes'], // go/src/math/sin.go
  ['f894acfd6045a7025f8c6e409103c76096b2b8795ef7c2df226e7e079603cdcd', 'SunPro'], // go/src/math/sqrt.go
  ['24885ab7b237dc1445d2970a2f41472842e208ebeae06b6b9682e4ac57171489', 'LicenseRef-Cephes'], // go/src/math/tan.go
  ['35454dbeb436d53995d234ff21baabb3c501ffc091d9a8a18ed90c04e15d682a', 'LicenseRef-Cephes'], // go/src/math/tanh.go
  ['d63eafda50d8ef034c574babbd3348a4f8bb6995d692a56b2fee6fca0f15f10b', 'BSD-1-Clause'], // go/src/crypto/internal/fips140/edwards25519/scalar.go
  ['819fa70a1f6b0f78d58e2d74cf94c4daece1d2214b9b5cd503016d3b2d29661f', 'BSD-1-Clause'], // go/src/crypto/internal/fips140/nistec/p256_ordinv.go
  ['78765552cd3c4d0711274f37ec4400223b2204ee378b9e5e31e68d3e361be8b8', 'MIT'], // github.com/prometheus/client_golang/prometheus/internal/almost_equal.go
  ['c5f48c4fb5a04a8cf3f52169647661ab10e4db005c496685bd9923d7d8576f28', 'BSD-3-Clause'], // github.com/munnerz/goautoneg/autoneg.go
  ['2f706d67271d8db967046638e30f7887a5ba6e49593e6395e8145a7c9feab96a', 'BSD-3-Clause'], // google.golang.org/protobuf/types/known/{any,duration,field_mask,struct,timestamp}.pb.go
  ['b0b0fa5d93027f32affa999e2984fd9ebcfcdfe593ddb602a3aafa13f9b05b87', 'BSD-3-Clause'], // google.golang.org/protobuf/types/known/wrapperspb/wrappers.pb.go
  // READMEs that hold a license: the module's own text again, and fiat-crypto's for Go's nistec/fiat code.
  ['89b42f5d5c35082bddfccad04905f46a1cba313606cafde7dbc0f9d2f51aa4d6', 'MIT'], // github.com/beorn7/perks/README.md
  ['7aa3885c41607799e08ed55e0546695750c5327a9fd45081c4664249d2b19e6a', 'BSD-3-Clause'], // github.com/munnerz/goautoneg/README.txt
  ['2edb21e35fbd9a239a91dfeb724a02315aff85492aa72824bbb4ac8910da94ac', 'BSD-1-Clause'], // go/src/crypto/internal/fips140/nistec/fiat/README
  // Public-domain dedications, which ask nothing: SLEEF's ("without any obligation") and the Rijndael reference code's.
  ['39560d76c96a55aa9694eb537a24eccb1d2d8f6b338c5498d5a09bd06e8fba8b', 'LicenseRef-public-domain'], // go/src/math/exp_amd64.s
  ['3d1fd2c82964a515df23432df3e5b06b67dc1bcd7416f6dd5d28ba39c731554d', 'LicenseRef-public-domain'], // go/src/crypto/internal/fips140/aes/aes_generic.go, below Go's own header
]);
// Files a person read and left out of the bundle, by the SHA-256 of their bytes, with why; README.md lists them. Like
// REVIEWED, a changed file stops the collector until someone has read it again.
export const LEFT_OUT: ReadonlyMap<string, string> = new Map([
  // go/README.md
  ['8247b7c5de1e74854aac1a08aa5894444d1d33b4045c70d5cc3367ad0e25c3f3', 'its Creative Commons license is the Gopher image\'s, which the binary does not contain; it says the Go source files are under the LICENSE file'],
  // go/src/crypto/internal/boring/LICENSE
  ['56210f826b8f0fbac3160dfe55c97f4019eb6cdda3963b5a0eab8a8bdb62360e', 'it covers the BoringSSL object that Go links only for GOEXPERIMENT=boringcrypto with cgo, and the binary is built without cgo and links no object file (one would stop this script); the Go code in that directory is under Go\'s LICENSE, as the file says'],
]);

const BSD = /Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met/gi;
// Terms that need a person, wherever they appear in a file: copyleft, non-software licenses and advertising clauses.
const NEEDS_REVIEW = /General Public License|Mozilla Public License|Eclipse Public License|Common Development and Distribution License|Server Side Public License|Business Source License|Creative Commons|Commons Clause|advertising materials mentioning/i;
// Licenses copied from source headers carry comment markers at the start of their lines.
const flatten = (text: string): string => text.replace(/^[ \t]*(?:\/\/+|\/\*+|\*+\/|\*+|#+)/gm, ' ').replace(/\s+/g, ' ');
/**
 * The SPDX ids a text looks like it grants, for the person reviewing a file REVIEWED does not have yet; the bundle
 * never takes its labels from here. Each license is recognised by its grant and its conditions, and a text with any
 * term in NEEDS_REVIEW gets none. One file can hold several: OpenTelemetry's LICENSE has Apache-2.0 and the
 * BSD-3-Clause of the code it took from Go.
 */
export function licenceIds(text: string): string[] {
  const flat = flatten(text), ids = new Set<string>();
  if (NEEDS_REVIEW.test(flat)) return [];
  if (/Apache License,? Version 2\.0, January 2004 .{0,80}TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/i.test(flat)) ids.add('Apache-2.0');
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy of this software .{0,600}The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software/i.test(flat)) ids.add('MIT');
  if (/Permission to use, copy, modify, and(?:\/or)? distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies/i.test(flat)) ids.add('ISC');
  const starts = [...flat.matchAll(BSD)].map(match => match.index ?? 0);
  starts.forEach((start, i) => {
    const clauses = flat.slice(start, starts[i + 1] ?? flat.length);
    if (!/Redistributions in binary form must reproduce the above copyright notice/i.test(clauses) || !/THIS SOFTWARE IS PROVIDED BY/i.test(clauses)) return;
    ids.add(/Neither the names? of|names of its contributors may not be used/i.test(clauses) ? 'BSD-3-Clause' : 'BSD-2-Clause');
  });
  return [...ids].sort();
}
function looksLike(text: string): string {
  const flagged = NEEDS_REVIEW.exec(flatten(text))?.[0], ids = licenceIds(text);
  return flagged ? `it mentions "${flagged}"` : ids.length ? `it reads like ${ids.join(', ')}` : 'it is no license this script recognises';
}

// How the API image and the release build, whatever the caller's Go settings say: no go.work above the checkout, and
// no build tags, experiments or other amd64 level, which choose other files.
const BUILD = Object.freeze({ ...TARGET, GOWORK: 'off', GOFLAGS: '-modcacherw', GOEXPERIMENT: '', GOAMD64: '' });
function go(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('go', args, { cwd, env: { ...env, ...BUILD }, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Every package backend/cmd/api links on TARGET, with the module that provides it. */
export function goPackages(backend: string, env: NodeJS.ProcessEnv = process.env): GoPackage[] {
  return go(['list', '-deps', '-f', LIST_FORMAT, './cmd/api'], backend, env).split('\n').filter(line => line.trim()).map(line => {
    const [importPath = '', dir = '', standard, embeds = '', compiled = '', syso = '', path, version = '', main, moduleDir = '', replaced] = line.replace(/\r$/, '').split('\t');
    const list = (files: string): string[] => files.split('\x1f').filter(Boolean);
    return { importPath, dir, standard: standard === 'true', embeds: list(embeds), compiled: list(compiled), syso: list(syso),
      module: path ? { path, version, dir: moduleDir, main: main === 'true', replaced: replaced === 'replaced' } : undefined };
  });
}

function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** The h1: hash go.sum records for a module: SHA-256 over the sorted "<file SHA-256>  <module@version/file>" lines. */
export function moduleHash(directory: string, prefix: string): string {
  const files: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push([`${prefix}/${relative(directory, full).split(sep).join('/')}`, full]);
      else throw new Error(`Unexpected entry in the module cache: ${full}`);
    }
  };
  walk(directory);
  const summary = createHash('sha256');
  for (const [name, file] of files.sort(([a], [b]) => byBytes(a, b))) summary.update(`${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${name}\n`);
  return `h1:${summary.digest('base64')}`;
}

/** go.sum's h1: hash of each module's files, by "path version". */
export function goSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [path, version, sum] = line.trim().split(/\s+/);
    if (path && version && sum && !version.endsWith('/go.mod')) sums.set(`${path} ${version}`, sum);
  }
  return sums;
}

function sources(packages: GoPackage[], goroot: string, sums: Map<string, string>, goVersion: string): Source[] {
  const found = new Map<string, Source>();
  for (const pkg of packages) {
    const module = pkg.module;
    if (module?.main) continue;
    if (module?.replaced) throw new Error(`${module.path} is replaced in backend/go.mod; scripts/awwo-go-licences.ts cannot tell where its license comes from`);
    if (!module && !pkg.standard) throw new Error(`${pkg.importPath} belongs to no module`);
    if (module && (!MODULE_PATH.test(module.path) || !MODULE_VERSION.test(module.version) || !module.dir)) throw new Error(`Unexpected module ${module.path}@${module.version} in ${module.dir || 'no directory'}`);
    if (pkg.syso?.length) throw new Error(`${pkg.importPath} links ${pkg.syso.join(', ')}: an object file, whose notices scripts/awwo-go-licences.ts cannot read`);
    const prefix = module ? `${module.path}@${module.version}` : STANDARD;
    let source = found.get(prefix);
    if (!source) {
      source = module ? { name: module.path, version: module.version, root: resolve(module.dir), prefix, sum: sums.get(`${module.path} ${module.version}`), dirs: new Set(), scanned: new Set() }
        : { name: 'Go standard library and runtime', version: goVersion, root: resolve(goroot), prefix, dirs: new Set(), scanned: new Set() };
      found.set(prefix, source);
    }
    for (const file of [...(pkg.compiled ?? []), ...(pkg.embeds ?? [])]) source.scanned.add(resolve(pkg.dir, file));
    // Each directory from an embedded file's up to the module root, through the package's own.
    for (const start of [resolve(pkg.dir), ...(pkg.embeds ?? []).map(file => dirname(resolve(pkg.dir, file)))]) {
      for (let dir = start; ; dir = dirname(dir)) {
        const rel = relative(source.root, dir);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${pkg.importPath} (${dir}) is not inside ${source.root}`);
        source.dirs.add(dir);
        if (!rel) break;
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.prefix === STANDARD ? -1 : b.prefix === STANDARD ? 1 : byBytes(a.name, b.name)));
}

// Between the words of a phrase: whitespace and comment markers, so wording that wraps across comment lines matches.
const GAP = String.raw`(?:[\s*#]|\/\/)+`;
const phrase = (words: string): string => words.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(GAP);
// Wording that grants a license of its own, for code a module took from elsewhere.
const INLINE_GRANT = new RegExp(['Permission is hereby granted', 'Permission to use, copy, modify', 'Redistribution and use in source and binary forms',
  'is freely granted', 'may be used freely', 'hereby grants'].map(phrase).join('|'), 'gi');
// Licenses that need a person wherever a file names them (copyleft, source-available, font and content licenses), and
// the markers bundled scripts keep their notices behind (/*! … */, @license, "Released under the … license").
const FOREIGN = new RegExp([...['General Public License', 'Mozilla Public License', 'Eclipse Public License', 'Common Development and Distribution License',
  'Server Side Public License', 'Business Source License', 'Commons Clause', 'Creative Commons', 'Open Font License'].map(phrase),
  String.raw`\bA?L?GPL(?:v?\d[\w.-]*)?\b`, String.raw`\bMPL-\d`, String.raw`\bCC[ -]BY\b`, String.raw`\bOFL\b`, String.raw`@license\b`, String.raw`@preserve\b`,
  String.raw`\/\*!`, `Released${GAP}under${GAP}the(?:${GAP}[\\w.-]+){0,3}?${GAP}licen[cs]e`].join('|'), 'gi');
// Licenses named in prose, with the words of a name on one line (quoted or not): a known name before "license" ("MIT
// license", "BSD-style license", "3-clause BSD license", "MIT/X11 license"), the name after "licensed under"
// ("licensed under the PostgreSQL License", "Licensed under MIT (…)"), capitalized words before "license" ("OpenSSL
// License", 'BSD 2-Clause "Simplified" License', "the PostgreSQL license"), and the name after a "License:" label.
// "Public domain" always goes to a person.
const WORD = String.raw`"?[\w.+/-]+"?`, CAPITAL = String.raw`"?[A-Z0-9][\w.+/-]*"?`;
const NAMED = new RegExp(String.raw`\b((?:(?:\d|two|three|four)[ -]clause[ \t]+|(?:new|old|revised|modified|simplified|original)[ \t]+)?(?:MIT|BSD|ISC|Apache|zlib|Boost|Artistic|Unlicense|CC0|WTFPL)(?:[-\/][\w.+]+)*\b(?:[ \t]+${WORD}){0,2}?)${GAP}licen[cs]e[ds]?\b|\b(public)${GAP}domain\b`, 'gi');
const UNDER = new RegExp(String.raw`licen[cs]ed${GAP}under${GAP}(?:(?:the|an?)${GAP})?((?:${WORD}[ \t]+){0,6}?${WORD})(?:[ \t]+licen[cs]e[ds]?\b|(?=[ \t]*(?:[(\[,;:."]|\r?$)))`, 'gim');
const CAPITALIZED = new RegExp(String.raw`\b((?:${CAPITAL}[ \t]+){0,3}${CAPITAL})${GAP}[Ll]icen[cs]e\b`, 'g');
const LABEL = new RegExp(String.raw`\bLicen[cs]es?[ \t]*:[ \t]*(${WORD}(?:[ \t]+${WORD}){0,3})`, 'gi');
// What can follow a license's name, also on the next comment line: a clause count or a version ("license
// (4-clause)", "License, Version 1.1", "License 2.0").
const QUALIFIER = new RegExp(String.raw`^,?(?:${GAP})?(?:\(?(\d|two|three|four)[ -]clause\)?|(?:version|v)(?:${GAP})?(\d+(?:\.\d+)?)\b|(\d+\.\d+)\b)`, 'i');
const CLAUSES: ReadonlyMap<string, string> = new Map([['two', '2'], ['three', '3'], ['four', '4']]);
// A copyright notice, which a license asks to keep with it.
const COPYRIGHT = /\bcopyright\b|(?:^|[^\w)])\(c\)|©/im;
// An SPDX header passes only as a single id the module grants: an expression (AND, OR, WITH) goes to a person.
const SPDX = /SPDX-License-Identifier:[ \t]*(.*?)[ \t]*(?:\*\/[ \t]*)?\r?$/gm;
// Words a license's name can carry around it, and the BSD licenses' other names, by clause count.
const FILLER = /^(?:the|an?|this|that|these|those|its|their|our|your|his|her|any|each|every|such|same|other|terms|of|conditions|licen[cs]e[ds]?|version)$/i;
const BSD_NAMES: ReadonlyMap<string, string> = new Map([['new', '3'], ['revised', '3'], ['modified', '3'], ['simplified', '2'], ['old', '4'], ['original', '4']]);
/**
 * Whether a license a file names is one that covers it, in that variant: MIT, ISC, a BSD license (any of those that
 * cover it for "BSD" and "BSD-style", the one with that clause count otherwise) or an Apache license (2.0 unless a
 * version is given). Any other word in the name ("Apache Software", "BSD 4-Clause", "MIT/X11") makes it another one.
 */
function ownName(name: string, licences: ReadonlySet<string>): boolean {
  let family = '', clauses = '', version = '', named = false;
  for (const word of name.split(/[\s,;:]+/).map(each => each.replace(/^["'(]+|["').]+$/g, '')).filter(Boolean)) {
    if (FILLER.test(word)) continue;
    named = true;
    const lower = word.toLowerCase(), known = /^(mit|isc|bsd|apache)(?:-style|-(\d)-clause|-(\d+(?:\.\d+)?))?$/.exec(lower);
    const counted = /^(\d|two|three|four)-clause$/.exec(lower)?.[1], number = /^v?(\d+(?:\.\d+)?)$/.exec(lower)?.[1];
    const clause = counted ? CLAUSES.get(counted) ?? counted : BSD_NAMES.get(lower);
    if (known && !family) {
      const [, name = '', count = '', release = ''] = known;
      // A clause count or version in the name itself must agree with one given before it.
      if ((count && clauses && count !== clauses) || (release && version && release !== version)) return false;
      [family, clauses, version] = [name, clauses || count, version || release];
    }
    else if (clause && (!clauses || clauses === clause)) clauses = clause;
    else if (number && (!version || version === number)) version = number;
    else return false;
  }
  // Words such as "the License" name nothing.
  if (!named) return true;
  if (family === 'mit' || family === 'isc') return !clauses && !version && licences.has(family.toUpperCase());
  if (family === 'bsd') return !version && (clauses ? licences.has(`BSD-${clauses}-Clause`) : [...licences].some(id => id.startsWith('BSD-')));
  return family === 'apache' && !clauses && licences.has(`Apache-${version ? (version.includes('.') ? version : `${version}.0`) : '2.0'}`);
}

/** How a file's comments are written: c (// and /* *\/), hash (#), markup (<!-- -->), or plain text, which has none. */
export type CommentFamily = 'c' | 'hash' | 'markup' | 'plain';
const FAMILIES: ReadonlyArray<[CommentFamily, RegExp]> = [
  ['c', /\.(?:go|s|c|h|cc|cpp|hpp|proto|[cm]?[jt]sx?|css|scss|less|json)$/i],
  ['hash', /\.(?:sh|bash|py|ya?ml|toml|rb|pl)$/i],
  ['markup', /\.(?:html?|xml|svg|tmpl|gohtml)$/i],
];
/** A file's comment family, by its extension. */
export const commentFamily = (file: string): CommentFamily => FAMILIES.find(([, pattern]) => pattern.test(file))?.[0] ?? 'plain';

type Region = { start: number; end: number; line: boolean; comment: boolean };
/**
 * Where a file's comments and literals lie, [start, end), for its family: // and /* *\/ comments with string, raw
 * string and rune literals (c); # comments with '…', "…" and triple-quoted strings (hash); <!-- --> comments (markup).
 * line: a comment that runs to the end of its line; comment: a comment rather than a literal.
 */
function regions(text: string, family: CommentFamily): Region[] {
  const found: Region[] = [];
  // Up to close, skipping what a backslash escapes in a literal; a Go raw string, which has no escapes, can only grow.
  const until = (start: number, close: string, from: number, comment: boolean): number => {
    let end = from;
    while (end < text.length && !text.startsWith(close, end)) end += !comment && text[end] === '\\' ? 2 : 1;
    const stop = Math.min(text.length, end + close.length);
    found.push({ start, end: stop, line: false, comment });
    return stop - 1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i], next = text[i + 1];
    if (family === 'markup') {
      if (text.startsWith('<!--', i)) i = until(i, '-->', i + 2, true);
    } else if (family === 'c' ? char === '/' && next === '/' : char === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      const end = text.indexOf('\n', i), stop = end < 0 ? text.length : end;
      found.push({ start: i, end: stop, line: true, comment: true });
      i = stop;
    } else if (family === 'c' && char === '/' && next === '*') i = until(i, '*/', i + 2, true);
    else if (family === 'c' && char === '`') i = until(i, '`', i + 1, false);
    else if (family === 'hash' && (text.startsWith('"""', i) || text.startsWith('\'\'\'', i))) i = until(i, text.slice(i, i + 3), i + 3, false);
    else if (char === '"' || char === '\'') {
      let j = i + 1;
      while (j < text.length && text[j] !== char && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      found.push({ start: i, end: j + 1, line: false, comment: false });
      i = j;
    }
  }
  return found;
}

/**
 * The block around each license a file grants, or names that the licenses covering it do not, exactly as written
 * and in file order; '' when there is none. A block is the comment or literal that holds the words, or the run of
 * comment lines around them (a comment after code is its line alone); the notice of a file with no comment there, or
 * of plain text, is the whole file. Pass the file decoded as latin1, so the excerpt's bytes are the file's.
 */
export function sourceNotice(text: string, licences: ReadonlySet<string>, family: CommentFamily = 'c'): string {
  // Where each license's words start and end, so its excerpt covers every line they span (across a blank line too).
  const found: number[] = [];
  const take = (match: RegExpMatchArray): void => { found.push(match.index ?? 0, (match.index ?? 0) + Math.max(0, match[0].length - 1)); };
  // A name with the clause count or version that follows it; the module's own one gives nothing.
  const named = (match: RegExpMatchArray, name: string): void => {
    const after = QUALIFIER.exec(text.slice((match.index ?? 0) + match[0].length));
    const clause = after?.[1] ? `${CLAUSES.get(after[1].toLowerCase()) ?? after[1]}-clause` : '';
    if (!ownName(`${name} ${clause} ${after?.[2] ?? after?.[3] ?? ''}`, licences)) take(match);
  };
  for (const match of [...text.matchAll(INLINE_GRANT), ...text.matchAll(FOREIGN)]) take(match);
  for (const match of text.matchAll(NAMED)) {
    if (match[2]) take(match);
    else named(match, match[1] ?? '');
  }
  for (const match of [...text.matchAll(UNDER), ...text.matchAll(CAPITALIZED), ...text.matchAll(LABEL)]) named(match, match[1] ?? '');
  for (const match of text.matchAll(SPDX)) {
    const expression = match[1] ?? '';
    if (!/^[\w.+-]+$/.test(expression) || !licences.has(expression)) take(match);
  }
  if (!found.length || family === 'plain') return found.length ? text : '';
  const lines = text.split('\n'), starts = [0];
  for (const line of lines) starts.push((starts[starts.length - 1] ?? 0) + line.length + 1);
  // The line an offset is on, by binary search over where the lines start.
  const lineOf = (index: number): number => {
    let low = 0, high = lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const spans = regions(text, family), marker = family === 'hash' ? '#' : '//', blocks: Array<[number, number]> = [];
  const commented = (line = ''): boolean => line.trimStart().startsWith(marker);
  for (const index of found) {
    const span = spans.find(({ start, end }) => start <= index && index < end);
    if (!span) return text;
    let start = lineOf(index), end = start;
    if (!span.line) [start, end] = [lineOf(span.start), lineOf(span.end - 1)];
    else if (commented(lines[start])) while (start > 0 && commented(lines[start - 1])) start -= 1;
    // A run of comment lines goes on below; so does a comment after code, in the comment lines right under it.
    if (span.line) while (end < lines.length - 1 && commented(lines[end + 1])) end += 1;
    // The copyright notice in the comment above, past blank lines, is the same notice's: a run of comment lines, or the
    // lines that comments ending there fill with nothing else (never a literal, and never code beside them).
    let above = start - 1;
    while (above >= 0 && !(lines[above] ?? '').trim()) above -= 1;
    if (above >= 0 && commented(lines[above])) {
      let top = above;
      while (top > 0 && commented(lines[top - 1])) top -= 1;
      if (lines.slice(top, above + 1).some(line => COPYRIGHT.test(line))) start = top;
    } else if (above >= 0) {
      const ending = spans.filter(each => lineOf(each.end - 1) === above);
      const top = lineOf(Math.min(...ending.map(each => each.start))), from = starts[top] ?? 0, to = (starts[above + 1] ?? text.length + 1) - 1;
      let rest = '', at = from;
      for (const each of spans.filter(span => span.comment && span.end > from && span.start < to)) {
        rest += text.slice(at, Math.max(at, each.start));
        at = Math.max(at, each.end);
      }
      rest += text.slice(at, to);
      if (ending.length && !rest.trim() && COPYRIGHT.test(text.slice(from, to))) start = top;
    }
    blocks.push([start, end]);
  }
  // Overlapping or adjacent blocks are one, so the excerpt adds no line the file lacks.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of blocks.sort(([a], [b]) => a - b)) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  // Each block's own bytes, its last line's newline included when the file has one there.
  return merged.map(([start, end]) => text.slice(starts[start], starts[end + 1])).join('\n');
}

/** reviewed and leftOut: REVIEWED and LEFT_OUT unless a test supplies its own. */
export type BundleInput = { packages: GoPackage[]; goroot: string; sums: Map<string, string>; goVersion: string; reviewed?: ReadonlyMap<string, string>; leftOut?: ReadonlyMap<string, string> };
type Add = (path: string, bytes: Buffer) => string[] | undefined;
// What the license files in each directory grant, by directory.
type Grants = Map<string, Set<string>>;

/** The licenses that cover a file in dir: what the license files in dir, and in each directory above it up to root, grant. */
function covering(grants: Grants, root: string, dir: string): Set<string> {
  const ids = new Set<string>();
  for (let at = dir; ; at = dirname(at)) {
    for (const id of grants.get(at) ?? []) ids.add(id);
    if (at === root || dirname(at) === at) return ids;
  }
}

/**
 * The license, notice and patent files beside a source's linked packages, and the READMEs there that grant a license
 * or name one the license files covering them do not; add takes each one. grants: what each directory's files grant.
 */
function licenceFiles(source: Source, add: Add): { files: string[]; licences: Set<string>; grants: Grants } {
  const files: string[] = [], licences = new Set<string>(), grants: Grants = new Map(), docs: Array<[string, string, Buffer]> = [];
  const take = (dir: string, file: string, bytes: Buffer): void => {
    const ids = add(`${source.prefix}/${file}`, bytes);
    if (!ids) return;
    const here = grants.get(dir) ?? new Set<string>();
    for (const id of ids) {
      licences.add(id);
      here.add(id);
    }
    grants.set(dir, here);
    files.push(file);
  };
  for (const dir of source.dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const notice = noticeFile(entry.name);
      if (!entry.isFile() || (!notice && !docFile(entry.name))) continue;
      const file = relative(source.root, join(dir, entry.name)).split(sep).join('/'), bytes = readFileSync(join(dir, entry.name));
      if (notice) take(dir, file, bytes);
      else docs.push([dir, file, bytes]);
    }
  }
  // Every README is judged against the license files alone, so their order does not matter; one that holds a license
  // covers its directory once someone has read it.
  const taken = docs.filter(([dir, , bytes]) => sourceNotice(bytes.toString('latin1'), covering(grants, source.root, dir), 'plain'));
  for (const [dir, file, bytes] of taken) take(dir, file, bytes);
  return { files, licences, grants };
}

/** The OUTPUT directory for these packages: license files, source notices, modules.txt and README.md. */
export function goLicenceBundle({ packages, goroot, sums, goVersion, reviewed = REVIEWED, leftOut = LEFT_OUT }: BundleInput): Bundle {
  const bundle: Bundle = new Map(), rows: string[] = [], notices: string[] = [], omitted: string[] = [], unreviewed: string[] = [], used = new Set<string>();
  // Takes a file a person has read into the bundle and returns the licenses it grants; one nobody has read is listed instead.
  const add: Add = (path, bytes) => {
    const hash = createHash('sha256').update(bytes).digest('hex'), grants = reviewed.get(hash), reason = leftOut.get(hash);
    if (reason !== undefined) {
      used.add(hash);
      omitted.push(`\`${path}\` is left out: ${reason}.`);
      return undefined;
    }
    if (!grants) {
      unreviewed.push(`${path} (${hash}): ${looksLike(bytes.toString('utf8'))}`);
      return undefined;
    }
    used.add(hash);
    bundle.set(path, bytes);
    return grants.split(', ').filter(id => id !== 'NOTICE' && id !== 'PATENTS');
  };
  // The toolchain first: the standard library's notices are its own, so the binary must be built with it.
  let modules = `go ${goVersion}\n`, count = 0;
  for (const source of sources(packages, goroot, sums, goVersion)) {
    if (source.prefix !== STANDARD) {
      if (!source.sum) throw new Error(`backend/go.sum has no hash for ${source.prefix}`);
      if (moduleHash(source.root, source.prefix) !== source.sum) throw new Error(`${source.prefix} in ${source.root} does not match its hash in backend/go.sum`);
      modules += `${source.name} ${source.version} ${source.sum}\n`;
      count += 1;
    }
    const before = unreviewed.length, { files, licences, grants: byDirectory } = licenceFiles(source, add);
    if (!licences.size && unreviewed.length === before) throw new Error(`${source.prefix} has no license file beside the packages the API links`);
    for (const file of [...source.scanned].sort(byBytes)) {
      // latin1 keeps every byte, so a notice is the file's own bytes; a file with a NUL byte is binary data. A file is
      // judged against the licenses of its own directory and those above it, never a sibling's.
      const bytes = readFileSync(file), own = covering(byDirectory, source.root, dirname(file)), rel = relative(source.root, file).split(sep).join('/');
      const notice = bytes.includes(0) ? '' : sourceNotice(bytes.toString('latin1'), own, commentFamily(file));
      const grants = notice ? add(`${source.prefix}/${rel}.notice`, Buffer.from(notice, 'latin1')) : undefined;
      if (!grants) continue;
      for (const id of grants) licences.add(id);
      notices.push(`| ${source.name} | [${rel}](${source.prefix}/${rel}.notice) | ${grants.join(', ')} |`);
    }
    const links = files.sort(byBytes).map(file => `[${file}](${source.prefix}/${file})`).join(', ');
    rows.push(`| ${source.name} | ${source.version} | ${[...licences].sort().join(', ')} | ${links} |`);
  }
  if (unreviewed.length) throw new Error(`Nobody has read these license files yet. Read each one, then add its SHA-256 to REVIEWED in scripts/awwo-go-licences.ts with the SPDX ids it grants, or NOTICE or PATENTS:\n  ${unreviewed.sort(byBytes).join('\n  ')}`);
  const stale = [...reviewed.keys(), ...leftOut.keys()].filter(hash => !used.has(hash));
  if (stale.length) throw new Error(`REVIEWED or LEFT_OUT in scripts/awwo-go-licences.ts lists files the API no longer links; remove them: ${stale.join(', ')}`);
  bundle.set('modules.txt', Buffer.from(modules));
  bundle.set('README.md', Buffer.from(readme(rows, notices, count, omitted.sort(byBytes))));
  return bundle;
}

function readme(rows: string[], notices: string[], modules: number, omitted: string[]): string {
  return [
    '# Go licenses in the AwwO API binary',
    '',
    'The AwwO API binary (`backend/cmd/api`, built for linux/amd64 without cgo, as the API image and the native',
    'release archive build it) is compiled from AwwO\'s own code, the Go standard library and runtime, and the',
    `${modules} modules below. This directory holds their license, notice and patent files, unchanged: from each`,
    'module\'s root and from every directory between it and a package the binary links or a file such a package',
    'embeds, with the READMEs there that grant a license or name one that no license file above them grants. A',
    'module listed with more than one license has parts under each.',
    '',
    '`modules.txt` names the Go version whose standard library these files come from, then lists the modules as',
    '`go version -m` prints a binary\'s dependencies, with their hashes from `backend/go.sum`. The API image and',
    'release archive builds fail when the binary they built has another toolchain or links other modules: generate',
    'this directory with the toolchain the API image builds with.',
    '',
    'Generated by `scripts/awwo-go-licences.ts` from the Go module cache, after checking each module\'s files',
    'against its hash in `backend/go.sum`; do not edit by hand. The License column is what a person who read each',
    'file recorded in that script, which stops at any file nobody has read. `npm run check:go-licences` fails when',
    'this directory differs from what it would write.',
    '',
    '| Module | Version | License | Files |',
    '| --- | --- | --- | --- |',
    ...rows,
    ...(omitted.length ? ['', ...omitted.map(line => `- ${line}`)] : []),
    ...(notices.length ? ['', '## Notices in source files', '',
      'These compiled or embedded files grant a license of their own, for code their module took from elsewhere,',
      'or name one that the license files covering them do not. The comment or literal that holds it, with the',
      'copyright notice above it (the whole file, for one with no comment there), is copied here unchanged, as the',
      'file\'s name with `.notice` added.', '',
      '| Module | Source file | License |', '| --- | --- | --- |', ...notices] : []),
  ].join('\n') + '\n';
}

/** The bundle for a checkout's backend/, read from the module cache and toolchain that env's go command uses. */
export function collectGoLicences(backend: string, env: NodeJS.ProcessEnv = process.env): Bundle {
  const [goroot = '', version = ''] = go(['env', 'GOROOT', 'GOVERSION'], backend, env).split('\n').map(line => line.trim());
  if (!goroot || !version) throw new Error('go env printed no GOROOT or GOVERSION');
  return goLicenceBundle({ packages: goPackages(backend, env), goroot, sums: goSums(readFileSync(join(backend, 'go.sum'), 'utf8')), goVersion: version.split(/\s+/)[0] ?? '' });
}

/**
 * Throws unless every part of path below anchor that exists is a real directory, never a link (a symlink, or a
 * junction on Windows) or a file, so nothing is read or written through one.
 */
export function assertNoLinks(anchor: string, path: string): void {
  const rel = relative(anchor, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} is not inside ${anchor}`);
  let dir = resolve(anchor);
  for (const part of rel ? rel.split(sep) : []) {
    dir = join(dir, part);
    const info = lstatSync(dir, { throwIfNoEntry: false });
    if (!info) return;
    if (!info.isDirectory()) throw new Error(`${dir} is not a directory (a link or a file); nothing is read or written through it`);
  }
}

/** Regular files under root as POSIX paths; a link or any other entry is refused, never followed, below anchor too. */
function treeFiles(root: string, anchor: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), info = lstatSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) files.push(relative(root, full).split(sep).join('/'));
      else throw new Error(`Unexpected entry: ${full}`);
    }
  };
  assertNoLinks(anchor, root);
  if (existsSync(root)) walk(root);
  return files;
}

/** What --check reports: the files root lacks, has in addition, or holds with other bytes. anchor: the directory root must be inside of. */
export function bundleDifferences(root: string, bundle: Bundle, anchor = dirname(root)): string[] {
  const present = new Set(treeFiles(root, anchor)), differences: string[] = [];
  for (const file of present) if (!bundle.has(file)) differences.push(`unexpected ${file}`);
  for (const [file, bytes] of bundle) {
    if (!present.has(file)) differences.push(`missing ${file}`);
    else if (!readFileSync(join(root, file)).equals(bytes)) differences.push(`changed ${file}`);
  }
  return differences.sort();
}

/** Makes root hold exactly the bundle, removing the files of modules the binary no longer links. */
export function writeBundle(root: string, bundle: Bundle, anchor = dirname(root)): void {
  for (const file of treeFiles(root, anchor)) if (!bundle.has(file)) unlinkSync(join(root, file));
  const prune = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!lstatSync(full).isDirectory()) continue;
      prune(full);
      if (!readdirSync(full).length) rmdirSync(full);
    }
  };
  if (existsSync(root)) prune(root);
  for (const [file, bytes] of bundle) {
    const target = join(root, ...file.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target) && readFileSync(target).equals(bytes)) continue;
    // A new file renamed into place: a hard link to the old one elsewhere keeps its own bytes.
    const fresh = `${target}.${process.pid}.tmp`;
    writeFileSync(fresh, bytes, { flag: 'wx' });
    renameSync(fresh, target);
  }
}

/** A binary's toolchain and dependencies in modules.txt form, from what `go version -m` prints for it. */
export function linkedModules(versionOutput: string): string {
  // The first line is "<binary>: <version>", and the binary's path can hold spaces and colons.
  const [first = '', ...lines] = versionOutput.split('\n'), colon = first.lastIndexOf(': ');
  if (colon < 0) throw new Error(`go version -m printed no Go version: ${first}`);
  let modules = `go ${first.slice(colon + 2).trim().split(/\s+/)[0]}\n`;
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === '=>') throw new Error('The binary links a replaced module, which modules.txt cannot describe.');
    if (fields[0] === 'dep') modules += `${fields.slice(1, 4).join(' ')}\n`;
  }
  return modules;
}

/** The Go toolchain modules.txt names on its first line, such as go1.27.1: the one the API image builds with. */
export function bundleToolchain(modulesFile: string): string {
  const first = readFileSync(modulesFile, 'utf8').split('\n')[0] ?? '', toolchain = /^go (go\d[\w.+-]*)$/.exec(first)?.[1];
  if (!toolchain) throw new Error(`${modulesFile} names no Go toolchain on its first line`);
  return toolchain;
}

/**
 * Throws unless the binary was built by the toolchain modules.txt names and links exactly the modules it lists; the
 * API image build makes the same check.
 */
export function checkLinkedModules(binary: string, modulesFile: string, env: NodeJS.ProcessEnv = process.env): void {
  const linked = linkedModules(execFileSync('go', ['version', '-m', binary], { env, encoding: 'utf8', maxBuffer: 16 << 20 })), listed = readFileSync(modulesFile, 'utf8');
  const [built = '', wanted = ''] = [linked, listed].map(text => text.slice(3, text.indexOf('\n')));
  if (built !== wanted) throw new Error(`${binary} was built with ${built}, but ${modulesFile} is for ${wanted}, the toolchain the API image builds with; build with that one (GOTOOLCHAIN=${wanted}).`);
  if (linked !== listed) throw new Error(`${binary} links other Go modules than ${modulesFile} lists; run node scripts/awwo-go-licences.ts and commit the result.`);
}

function main(args: string[]): number {
  if (args.some(arg => arg !== '--check')) {
    console.error('Usage: node scripts/awwo-go-licences.ts [--check]');
    return 2;
  }
  const root = join(repository, OUTPUT), bundle = collectGoLicences(join(repository, 'backend'));
  if (args.includes('--check')) {
    const differences = bundleDifferences(root, bundle, repository);
    if (differences.length) {
      console.error(`${OUTPUT} is out of date; run node scripts/awwo-go-licences.ts\n  ${differences.join('\n  ')}`);
      return 1;
    }
    console.log(`${OUTPUT} is up to date (${bundle.size} files).`);
    return 0;
  }
  writeBundle(root, bundle, repository);
  console.log(`wrote ${OUTPUT} (${bundle.size} files)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));

// Builds AwwO's figure kit: the anatomy kit's drawing modules (third_party/anatomy/kit, MIT) as ONE classic browser
// script that defines window.Anatomy. A figure node's generated page loads it by its fixed URL; AwwO's running previews
// inline this exact file instead of fetching anything (src/canvas/previewLibraries.ts), and the hosted site serves the
// same bytes at that URL for downloaded pages (vite.saas.config.mjs).
//
// The output is deterministic. tests/saas-figure-kit.test.ts rebuilds it in memory and compares it byte for byte with
// the committed copy, so editing the bundle by hand or forgetting to rebuild after a vendored update fails the suite.
//
//   node apps/web/scripts/build-figure-kit.mjs           write src/canvas/figureKit/anatomy-kit.js
//   node apps/web/scripts/build-figure-kit.mjs --check   exit 1 when the committed bundle is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const KIT_DIR = join(here, '..', '..', '..', 'third_party', 'anatomy');
export const KIT_OUTPUT = join(here, '..', 'src', 'canvas', 'figureKit', 'anatomy-kit.js');
export const KIT_VERSION = '1';
export const KIT_COMMIT = 'dbf697a527bbf7d358668e1557cb1e35ff725d46';

// Each upstream module, the name its namespace has inside the bundle, and the namespaces its imports resolve to.
const MODULES = [
  { file: 'iso-kit.mjs', name: 'ISO' },
  { file: 'lathe.mjs', name: 'G' },
  { file: 'tube.mjs', name: 'T' },
  { file: 'gl.mjs', name: 'GL' },
];
const SPECIFIERS = { './iso-kit.mjs': 'ISO', './lathe.mjs': 'G' };

/** One ES module as a function body that returns its exports. Only the import and export forms the vendored files
 *  use are accepted; anything else throws, so an upstream change that this does not understand cannot slip through. */
export function moduleBody(source, file) {
  const exported = [];
  const lines = source.split('\n').map((line) => {
    if (line.startsWith('import ')) {
      const named = line.match(/^import \{([^}]*)\} from "([^"]+)";$/);
      const star = line.match(/^import \* as ([A-Za-z_$][\w$]*) from "([^"]+)";$/);
      const target = SPECIFIERS[(named ?? star)?.[2]];
      if (!target) throw new Error(`${file}: unsupported import: ${line}`);
      if (star) return `const ${star[1]} = $${target};`;
      const names = named[1].split(',').map((part) => part.trim()).filter(Boolean)
        .map((part) => part.replace(/^([A-Za-z_$][\w$]*) as ([A-Za-z_$][\w$]*)$/, '$1: $2'));
      return `const { ${names.join(', ')} } = $${target};`;
    }
    const declaration = line.match(/^export (?:const|let|function|class|async function) ([A-Za-z_$][\w$]*)/);
    if (declaration) {
      exported.push(declaration[1]);
      return line.slice('export '.length);
    }
    if (/^export\b/.test(line)) throw new Error(`${file}: unsupported export: ${line}`);
    return line;
  });
  if (!exported.length) throw new Error(`${file}: no exports`);
  // Inlined into an HTML <script>: nothing in it may close the element or open a comment there. In JavaScript source
  // `<\/` and `<\!` read the same as `</` and `<!` inside strings, templates and regular expressions alike.
  const body = lines.join('\n').replace(/<\/script/gi, (match) => `<\\/${match.slice(2)}`).replace(/<!--/g, '<\\!--');
  return { body, exported };
}

// AwwO's additions: the page a figure lives in, and the motion helpers of the kit's React live module, in plain DOM.
const RUNTIME = String.raw`
const STILL = "(prefers-reduced-motion: reduce)";
const calm = () => typeof matchMedia === "function" && matchMedia(STILL).matches;
const PAGE_CSS = '*{box-sizing:border-box}html{color-scheme:light}body[data-theme="dark"]{color-scheme:dark}'
  + 'body{margin:0;min-height:100vh;background:var(--anatomy-page);color:var(--anatomy-text);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}'
  + '.iso-page{width:min(var(--anatomy-width,650px),100% - 24px);margin:24px auto 32px}.iso-page .iso-figure{margin:0}'
  + '.iso-stage{outline:none}.iso-stage:focus-visible{box-shadow:0 0 0 1px var(--anatomy-faint)}';
let reported = false;
function report(error) {
  if (reported) return;
  reported = true;
  console.error(error);
  const note = document.createElement("div");
  note.className = "anatomy-error";
  note.setAttribute("role", "alert");
  note.textContent = "Figure script error · 图解脚本出错：" + String((error && error.message) || error || "unknown error").slice(0, 400);
  note.style.cssText = "margin:16px auto;max-width:640px;padding:10px 12px;border:1px solid #e5484d;color:#b4232a;background:#fff5f5;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap";
  (document.body || document.documentElement).appendChild(note);
}
// A figure whose own script failed before it drew anything says so instead of leaving a blank page.
addEventListener("error", (event) => { if (!document.querySelector(".iso-plate")) report(event.error || event.message); });
function mount({ html, theme = "light", width = 650, title } = {}) {
  if (typeof html !== "string" || !html) throw new TypeError("Anatomy.mount({ html }) needs the plateHtml(...) string");
  if (!document.getElementById("anatomy-kit-css")) {
    const style = document.createElement("style");
    style.id = "anatomy-kit-css";
    style.textContent = ISO.ISO_CSS + PAGE_CSS;
    document.head.appendChild(style);
  }
  const body = document.body;
  body.classList.add("iso");
  body.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  body.style.setProperty("--anatomy-width", Math.max(320, Math.min(1400, Number(width) || 650)) + "px");
  if (title) document.title = String(title);
  let main = document.querySelector("main.iso-page");
  if (!main) {
    main = document.createElement("main");
    main.className = "iso-page";
    body.appendChild(main);
  }
  main.innerHTML = html;
  return { root: main, figure: main.querySelector(".iso-figure"), stage: main.querySelector(".iso-stage"), svg: main.querySelector("svg"), readout: main.querySelector("[data-readout]") };
}
function run(build) {
  const exec = () => { try { return build(); } catch (error) { report(error); return undefined; } };
  // A page that loads its scripts in <head> has no body yet: draw once the document is parsed.
  if (!document.body) { document.addEventListener("DOMContentLoaded", exec, { once: true }); return undefined; }
  return exec();
}
function loop(element, tick) {
  let frame = 0, last = 0, visible = true, wanted = false;
  const step = (now) => {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    wanted = Boolean(tick(dt, calm()));
    frame = wanted && visible ? requestAnimationFrame(step) : 0;
  };
  const kick = () => {
    wanted = true;
    if (!frame && visible) { last = 0; frame = requestAnimationFrame(step); }
  };
  if (element && typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible && wanted) kick();
    }, { rootMargin: "120px 0px" }).observe(element);
  }
  kick();
  return kick;
}
function follow(current, target, dt, seconds, still = false) {
  if (still) return target;
  const next = current + (target - current) * (1 - Math.exp(-dt / seconds));
  return Math.abs(target - next) < 1e-3 ? target : next;
}
function spring(state, target, dt, stiffness, damping, still = false) {
  const drag = still ? 2 * Math.sqrt(stiffness) : damping;
  const steps = Math.max(Math.ceil(dt * 240), 1);
  const slice = dt / steps;
  for (let index = 0; index < steps; index++) {
    state.rate += (target - state.at) * stiffness * slice - state.rate * drag * slice;
    state.at += state.rate * slice;
  }
  if (Math.abs(target - state.at) < 5e-4 && Math.abs(state.rate) < 5e-4) {
    state.at = target;
    state.rate = 0;
  }
  return state.at === target && state.rate === 0;
}
`;

export function buildFigureKit(kitDir = KIT_DIR) {
  const license = readFileSync(join(kitDir, 'LICENSE'), 'utf8').trimEnd().split('\n').map((line) => (line ? ` * ${line}` : ' *')).join('\n');
  const parts = MODULES.map(({ file, name }) => {
    const { body, exported } = moduleBody(readFileSync(join(kitDir, 'kit', file), 'utf8'), file);
    const params = Object.values(SPECIFIERS).filter((space) => space !== name && body.includes(`$${space}`));
    // The body is not re-indented: its multi-line template literals (ISO_CSS, GLSL) must keep their exact text.
    return `// kit/${file}\nconst ${name} = (function (${params.map((space) => `$${space}`).join(', ')}) {\n${body.trimEnd()}\nreturn Object.freeze({ ${exported.join(', ')} });\n})(${params.join(', ')});`;
  });
  return `/*! AwwO figure kit ${KIT_VERSION}: the drawing modules of Anatomy (https://github.com/wheresryan22/anatomy, commit ${KIT_COMMIT}),
 * as one classic script that defines window.Anatomy, plus AwwO's page helpers (mount, run, loop, follow, spring, calm).
 * Generated by apps/web/scripts/build-figure-kit.mjs from third_party/anatomy; do not edit by hand.
 *
${license}
 */
(function () {
"use strict";
${parts.join('\n')}
${RUNTIME.trim()}
const Anatomy = Object.freeze(Object.assign({}, ISO, { G, T, GL, mount, run, loop, follow, spring, calm, version: "${KIT_VERSION}", commit: "${KIT_COMMIT}" }));
window.Anatomy = Anatomy;
})();
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildFigureKit();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(KIT_OUTPUT, 'utf8'); } catch { /* missing counts as stale */ }
    if (current !== built) { console.error('figure kit is stale: run node apps/web/scripts/build-figure-kit.mjs'); process.exit(1); }
    console.log('figure kit is up to date');
  } else {
    writeFileSync(KIT_OUTPUT, built);
    console.log(`wrote ${KIT_OUTPUT} (${Buffer.byteLength(built)} bytes)`);
  }
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(appRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const launchSmokeSource = fs.readFileSync(path.join(appRoot, "tests", "desktop-launch-smoke.test.mjs"), "utf8");
const installedSmokeSource = fs.readFileSync(path.join(appRoot, "tests", "desktop-installed-bundle-smoke.test.mjs"), "utf8");
const betaAcceptanceSource = fs.readFileSync(path.join(appRoot, "tests", "desktop-beta-acceptance.test.mjs"), "utf8");
const prepareMacosBundleSource = fs.readFileSync(path.join(appRoot, "scripts", "prepare-macos-bundle.mjs"), "utf8");
const macosEntitlementsSource = fs.readFileSync(path.join(appRoot, "scripts", "macos-entitlements.plist"), "utf8");
const quickstartSource = fs.readFileSync(path.join(repoRoot, "docs", "desktop-beta-quickstart.md"), "utf8");
const manualUpdateSource = fs.readFileSync(path.join(repoRoot, "docs", "desktop-manual-update.md"), "utf8");
const stylesSource = fs.readFileSync(path.join(repoRoot, "apps", "web", "src", "styles.css"), "utf8");
const tauriLibSource = fs.readFileSync(path.join(appRoot, "src-tauri", "src", "lib.rs"), "utf8");

assert.equal(packageJson.name, "superclaw-desktop");
assert.equal(packageJson.private, true);
assert.equal(packageJson.scripts["sync:titlebar"], undefined);
assert.equal(packageJson.scripts["tauri:dev"], "tauri dev --config src-tauri/tauri.conf.json");
assert.equal(packageJson.scripts["tauri:build"], "node scripts/build-backend.mjs && node scripts/build-clawwork-binary.mjs && node scripts/build-node-server.mjs && tauri build --config src-tauri/tauri.conf.json && node scripts/prepare-macos-bundle.mjs");
assert.equal(packageJson.scripts["build:clawwork"], "node scripts/build-clawwork-binary.mjs");
// The build chain produces the self-contained ClawWork binary, and the bundle
// step embeds it (binary + mandatory governance extension) next to the frozen
// backend so the kernel auto-discovers it at runtime.
assert.ok(fs.existsSync(path.join(appRoot, "scripts", "build-clawwork-binary.mjs")));
assert.ok(prepareMacosBundleSource.includes("superclaw-governance.ts"));
assert.ok(prepareMacosBundleSource.includes("clawwork"));
// Per-environment release builds bake one identity: each variant sets BOTH the backend
// (APP_ENV) and frontend (VITE_APP_ENV) selectors to the same value so the bundle never
// ships a split backend/frontend environment.
assert.equal(packageJson.scripts["tauri:build:staging"], "APP_ENV=staging VITE_APP_ENV=staging npm run tauri:build");
assert.equal(packageJson.scripts["tauri:build:production"], "APP_ENV=production VITE_APP_ENV=production npm run tauri:build");
assert.equal(packageJson.scripts["test:app-env"], "node tests/desktop-app-env.test.mjs");
assert.equal(packageJson.scripts["build:backend"], "node scripts/build-backend.mjs");
assert.equal(packageJson.scripts["test:config"], "node tests/desktop-config.test.mjs");
assert.equal(packageJson.scripts["test:launch-smoke"], "node tests/desktop-launch-smoke.test.mjs");
assert.equal(packageJson.scripts["test:runtime-smoke"], "node tests/desktop-runtime-smoke.test.mjs");
assert.equal(packageJson.scripts["test:workbench-smoke"], "node tests/desktop-workbench-smoke.test.mjs");
assert.equal(packageJson.scripts["test:installed-bundle-smoke"], "node tests/desktop-installed-bundle-smoke.test.mjs");
assert.equal(packageJson.scripts["test:beta-acceptance"], "node tests/desktop-beta-acceptance.test.mjs");
assert.ok(packageJson.devDependencies["@tauri-apps/cli"]);
assert.ok(betaAcceptanceSource.includes("SUPERCLAW_DESKTOP_ACCEPTANCE_REPORT"));
assert.ok(betaAcceptanceSource.includes('.superclaw", "desktop", "desktop-beta-acceptance.json'));
// Acceptance must prove the build baked the resolved environment identity into the
// bundle's build-profile.json (not merely that the per-environment scripts exist).
assert.ok(betaAcceptanceSource.includes("build_profile_identity"));
assert.ok(betaAcceptanceSource.includes("build-profile.json"));
assert.ok(betaAcceptanceSource.includes("resolveBuildAppEnv"));
// prepare-macos-bundle resolves the canonical identity (fail-closed on mismatch) and
// bakes it into the build profile.
assert.ok(prepareMacosBundleSource.includes("resolveBuildAppEnv"));
assert.ok(prepareMacosBundleSource.includes("build-profile.json"));

assert.equal(tauriConfig.productName, "ClawHunt");
assert.equal(tauriConfig.version, "0.1.0");
assert.equal(tauriConfig.identifier, "store.clawhunt.superclaw");
assert.equal(packageJson.version, tauriConfig.version);
assert.equal(tauriConfig.build.devUrl, "http://127.0.0.1:5173");
assert.equal(tauriConfig.build.frontendDist, "../../web/dist");
assert.equal(tauriConfig.build.beforeDevCommand, "npm --prefix ../web run dev");
assert.equal(tauriConfig.build.beforeBuildCommand, "npm --prefix ../web run build");
assert.equal(tauriConfig.app.windows[0].title, "ClawHunt");
assert.equal(tauriConfig.app.windows[0].titleBarStyle, "Overlay");
assert.equal(tauriConfig.app.windows[0].hiddenTitle, true);
assert.deepEqual(tauriConfig.app.windows[0].trafficLightPosition, { x: 12, y: 18 });
assert.equal(tauriConfig.app.windows[0].theme, null);
assert.equal(fs.existsSync(path.join(appRoot, "scripts", "sync-titlebar-layout.mjs")), false);
assert.equal(fs.existsSync(path.join(appRoot, "scripts", "titlebar-layout.mjs")), false);
assert.equal(stylesSource.includes("--app-titlebar-height"), false);
assert.equal(stylesSource.includes("--macos-control-center-y"), false);
assert.equal(stylesSource.includes("--window-control-button-offset-y"), false);
assert.ok(typeof tauriConfig.app.security.csp === "string");
assert.ok(tauriConfig.app.security.csp.includes("connect-src"));
assert.ok(tauriConfig.app.security.csp.includes("img-src"));
assert.ok(tauriConfig.app.security.csp.includes("https:"));
assert.deepEqual(tauriConfig.bundle.icon, ["icons/icon.png"]);
assert.ok(fs.existsSync(path.join(appRoot, "scripts", "prepare-macos-bundle.mjs")));
assert.ok(fs.existsSync(path.join(appRoot, "scripts", "macos-entitlements.plist")));
assert.ok(prepareMacosBundleSource.includes("Contents\", \"_CodeSignature\""));
assert.ok(prepareMacosBundleSource.includes("CFBundleExecutable"));
assert.ok(prepareMacosBundleSource.includes("mainExecutable"));
assert.ok(prepareMacosBundleSource.includes("SUPERCLAW_DESKTOP_CODESIGN_IDENTITY"));
assert.ok(prepareMacosBundleSource.includes("\"--options\""));
assert.ok(prepareMacosBundleSource.includes("\"runtime\""));
assert.ok(prepareMacosBundleSource.includes("\"--entitlements\""));
assert.equal(prepareMacosBundleSource.includes("\"--deep\""), false);
assert.ok(prepareMacosBundleSource.includes("function rebuildDmg"));
assert.ok(prepareMacosBundleSource.includes("\"hdiutil\""));
assert.ok(prepareMacosBundleSource.includes("\"verify\""));
assert.ok(macosEntitlementsSource.includes("com.apple.security.cs.allow-jit"));
assert.ok(macosEntitlementsSource.includes("com.apple.security.cs.allow-unsigned-executable-memory"));
assert.ok(macosEntitlementsSource.includes("com.apple.security.cs.disable-library-validation"));
assert.ok(launchSmokeSource.includes("function builtExecutableCandidates"));
assert.ok(tauriLibSource.includes("pub fn desktop_open_external_url"));
assert.ok(tauriLibSource.includes("commands::desktop_open_external_url"));
assert.ok(tauriLibSource.includes("fn normalize_external_url"));
assert.ok(tauriLibSource.includes("rundll32.exe"));
assert.equal(tauriLibSource.includes("cmd\").args([\"/C\", \"start\""), false);
assert.ok(launchSmokeSource.includes("process.platform === \"win32\""));
assert.ok(launchSmokeSource.includes("process.platform === \"darwin\""));
assert.ok(installedSmokeSource.includes("function builtBundleCandidates"));
assert.ok(installedSmokeSource.includes("function installedExecutableForBundle"));
assert.ok(installedSmokeSource.includes("process.platform === \"win32\""));
assert.ok(installedSmokeSource.includes("SUPERCLAW_DESKTOP_CLI_EXECUTABLE"));
assert.ok(quickstartSource.includes("Windows PowerShell"));
assert.ok(quickstartSource.includes(".venv\\Scripts\\python.exe"));
assert.ok(manualUpdateSource.includes("Windows PowerShell"));
assert.ok(manualUpdateSource.includes(".venv\\Scripts\\python.exe"));

console.log("desktop config ok");

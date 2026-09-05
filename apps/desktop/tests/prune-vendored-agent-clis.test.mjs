import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  pruneVendoredAgentCliBinaries,
  shouldKeepVendoredAgentClis,
  VENDORED_AGENT_CLI_GLOBS,
} from "../scripts/prune-vendored-agent-clis.mjs";

// Mirror a pnpm-deploy node_modules layout: each package exists as a top-level
// `.pnpm/<name>@ver` store dir AND a nested `node_modules/<scope>/<name>` copy.
// Platform binary packages carry a `-{platform}-{arch}` suffix; the JS main
// packages do not.
function makeStagedTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "byo-prune-"));
  const pnpm = path.join(root, "node_modules", ".pnpm");

  const platformPkgs = [
    ["@zed-industries+codex-acp-darwin-arm64@0.12.0", "@zed-industries/codex-acp-darwin-arm64", "codex-acp"],
    ["@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.183", "@anthropic-ai/claude-agent-sdk-darwin-arm64", "claude"],
  ];
  for (const [store, nested, binFile] of platformPkgs) {
    const dir = path.join(pnpm, store, "node_modules", nested);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, binFile), "X".repeat(2048)); // stand-in big binary
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
  }

  // JS main packages (no platform suffix) MUST survive.
  const mainPkgs = [
    ["@zed-industries+codex-acp@0.12.0", "@zed-industries/codex-acp"],
    ["@anthropic-ai+claude-agent-sdk@0.3.183_x", "@anthropic-ai/claude-agent-sdk"],
    ["picocolors@1.1.1", "picocolors"], // unrelated dep
  ];
  for (const [store, nested] of mainPkgs) {
    const dir = path.join(pnpm, store, "node_modules", nested);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), "export default {}");
  }
  return root;
}

test("prune removes ONLY platform binary packages, keeps JS packages", () => {
  const root = makeStagedTree();
  try {
    const logs = [];
    const { removed, freedBytes } = pruneVendoredAgentCliBinaries(root, { log: (m) => logs.push(m) });

    // Both platform binary store dirs are gone (top-level dedup → one entry each).
    assert.equal(removed.length, 2, `expected 2 removals, got ${removed.join(", ")}`);
    assert.ok(freedBytes > 0, "should report freed bytes");
    const codexPlatform = path.join(
      root, "node_modules/.pnpm/@zed-industries+codex-acp-darwin-arm64@0.12.0",
    );
    const claudePlatform = path.join(
      root, "node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.183",
    );
    assert.ok(!fs.existsSync(codexPlatform), "codex-acp platform binary not removed");
    assert.ok(!fs.existsSync(claudePlatform), "claude-agent-sdk platform binary not removed");

    // JS main packages and unrelated deps survive — importing them must never break.
    assert.ok(fs.existsSync(path.join(
      root, "node_modules/.pnpm/@zed-industries+codex-acp@0.12.0/node_modules/@zed-industries/codex-acp/index.js",
    )), "codex-acp JS main package wrongly removed");
    assert.ok(fs.existsSync(path.join(
      root, "node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.183_x/node_modules/@anthropic-ai/claude-agent-sdk/index.js",
    )), "claude-agent-sdk JS main package wrongly removed");
    assert.ok(fs.existsSync(path.join(
      root, "node_modules/.pnpm/picocolors@1.1.1/node_modules/picocolors/index.js",
    )), "unrelated dep wrongly removed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prune is an auditable no-op when there is nothing to remove", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "byo-prune-empty-"));
  try {
    fs.mkdirSync(path.join(root, "node_modules", "picocolors"), { recursive: true });
    const logs = [];
    const { removed, freedBytes } = pruneVendoredAgentCliBinaries(root, { log: (m) => logs.push(m) });
    assert.equal(removed.length, 0);
    assert.equal(freedBytes, 0);
    assert.match(logs.join("\n"), /nothing to remove/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("globs target platform suffixes, never the bare JS package names", () => {
  // Guard the invariant the safety argument rests on: every glob requires a
  // platform token, so a suffix-less main package can never match.
  for (const glob of VENDORED_AGENT_CLI_GLOBS) {
    assert.match(glob, /-(darwin|linux|win32)-/, `${glob} must be platform-scoped`);
  }
});

test("shouldKeepVendoredAgentClis honors the env flag (default prune)", () => {
  assert.equal(shouldKeepVendoredAgentClis({}), false);
  assert.equal(shouldKeepVendoredAgentClis({ SUPERCLAW_BUNDLE_VENDORED_AGENT_CLIS: "1" }), true);
  assert.equal(shouldKeepVendoredAgentClis({ SUPERCLAW_BUNDLE_VENDORED_AGENT_CLIS: "true" }), true);
  assert.equal(shouldKeepVendoredAgentClis({ SUPERCLAW_BUNDLE_VENDORED_AGENT_CLIS: "YES" }), true);
  assert.equal(shouldKeepVendoredAgentClis({ SUPERCLAW_BUNDLE_VENDORED_AGENT_CLIS: "no" }), false);
  assert.equal(shouldKeepVendoredAgentClis({ SUPERCLAW_BUNDLE_VENDORED_AGENT_CLIS: "0" }), false);
});

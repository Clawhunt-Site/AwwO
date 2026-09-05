import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXTERNAL_MCP_ALLOWED_LAUNCHERS,
  resolveExternalMcpSpawnSpec,
  resolveSidecarSpawnSpec,
  resolveSpawnSpec,
  SuperPluginExecError,
} from "../services/super-plugin-exec.js";
import type { SuperPluginRuntimeRecord } from "../services/super-plugin-runtime-store.js";

const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function record(over: Partial<SuperPluginRuntimeRecord> = {}): SuperPluginRuntimeRecord {
  return {
    pluginKey: "dev.x.tool",
    version: "1.0.0",
    runtimeType: "mcp_sidecar",
    transport: "stdio",
    entrypoint: "bin/run",
    command: null,
    url: null,
    args: ["mcp"],
    tools: [],
    installDir: "/unused",
    packageDigest: "sha256:" + "ab".repeat(32),
    status: "installed",
    ...over,
  };
}

describe("resolveSidecarSpawnSpec (real fs RCE gates)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "super-exec-"));
    mkdirSync(path.join(dir, "bin"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeEntrypoint(rel: string, mode: number): void {
    const p = path.join(dir, rel);
    writeFileSync(p, "#!/bin/sh\necho hi\n");
    chmodSync(p, mode);
  }

  it("builds an argv/cwd/narrowed-PATH for an executable entrypoint", () => {
    writeEntrypoint("bin/run", 0o755);
    const spec = resolveSidecarSpawnSpec(dir, { entrypoint: "bin/run", args: ["mcp"] });
    expect(spec.argv[0]).toBe(realpathSync(path.join(dir, "bin", "run")));
    expect(spec.argv.slice(1)).toEqual(["mcp"]);
    expect(spec.cwd).toBe(realpathSync(dir));
    expect(spec.env.PATH).toBe(SAFE_PATH); // never the host PATH
  });

  it("rejects a non-executable entrypoint (no owner-exec bit)", () => {
    writeEntrypoint("bin/run", 0o644);
    expect(() => resolveSidecarSpawnSpec(dir, { entrypoint: "bin/run", args: [] })).toThrow(/not executable/);
  });

  it("rejects a missing entrypoint", () => {
    expect(() => resolveSidecarSpawnSpec(dir, { entrypoint: "bin/missing", args: [] })).toThrow(/not found/);
  });

  it("rejects a symlinked entrypoint", () => {
    writeEntrypoint("bin/real", 0o755);
    symlinkSync(path.join(dir, "bin/real"), path.join(dir, "bin/link"));
    expect(() => resolveSidecarSpawnSpec(dir, { entrypoint: "bin/link", args: [] })).toThrow(/symlink/);
  });

  it("rejects an entrypoint that escapes the install dir via a symlinked parent", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "super-out-"));
    try {
      writeFileSync(path.join(outside, "evil"), "#!/bin/sh\n");
      chmodSync(path.join(outside, "evil"), 0o755);
      symlinkSync(outside, path.join(dir, "escape"));
      expect(() => resolveSidecarSpawnSpec(dir, { entrypoint: "escape/evil", args: [] })).toThrow(/escaped|symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each([
    ["set-uid", 0o4755, 0o4000],
    ["set-gid", 0o2755, 0o2000],
    ["sticky", 0o1755, 0o1000],
  ])("rejects a %s entrypoint", (_label, mode, bit) => {
    writeEntrypoint("bin/run", mode);
    if (!(statSync(path.join(dir, "bin/run")).mode & bit)) return; // OS stripped the bit on chmod — moot
    expect(() => resolveSidecarSpawnSpec(dir, { entrypoint: "bin/run", args: [] })).toThrow(
      /set-uid|set-gid|sticky/,
    );
  });

  it("never inherits the host env or host PATH — only the safe base + declared plugin env", () => {
    writeEntrypoint("bin/run", 0o755);
    const spec = resolveSidecarSpawnSpec(
      dir,
      { entrypoint: "bin/run", args: [] },
      {
        // host secrets MUST NOT leak; the plugin's OWN declared env (PLUGIN_OPT) may pass.
        hostEnv: { PATH: "/evil/writable/bin:/usr/bin", ANTHROPIC_API_KEY: "sk-secret", AWS_SECRET_ACCESS_KEY: "leak" },
        pluginEnv: { PLUGIN_OPT: "1", PATH: "/evil/override" },
      },
    );
    expect(spec.env.PATH).toBe(SAFE_PATH); // host PATH never reaches the child; pluginEnv can't set PATH
    expect(spec.env.PLUGIN_OPT).toBe("1");
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined(); // host secret not inherited
    expect(spec.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(spec.env.PYTHONDONTWRITEBYTECODE).toBe("1");
  });

  it("does not let pluginEnv override the reserved hardening env (PATH / PYTHONDONTWRITEBYTECODE)", () => {
    writeEntrypoint("bin/run", 0o755);
    const spec = resolveSidecarSpawnSpec(
      dir,
      { entrypoint: "bin/run", args: [] },
      { pluginEnv: { PYTHONDONTWRITEBYTECODE: "0", PATH: "/evil" } },
    );
    expect(spec.env.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(spec.env.PATH).toBe(SAFE_PATH);
  });
});

describe("resolveExternalMcpSpawnSpec (allowlist + PATH narrowing + cwd)", () => {
  let installDir: string;
  const okResolver = (cmd: string) => `/opt/toolchain/${cmd}`;

  beforeEach(() => {
    installDir = mkdtempSync(path.join(tmpdir(), "super-mcp-"));
  });
  afterEach(() => rmSync(installDir, { recursive: true, force: true }));

  it("builds argv + pins cwd to the install dir + narrows the child PATH to launcher dir + safe PATH", () => {
    const spec = resolveExternalMcpSpawnSpec(
      installDir,
      { command: "npx", args: ["some-server"] },
      { resolveLauncher: okResolver, hostEnv: { PATH: "/nvm/versions/node/bin:/usr/bin" } },
    );
    expect(spec.argv).toEqual(["/opt/toolchain/npx", "some-server"]);
    expect(spec.cwd).toBe(realpathSync(installDir));
    expect(spec.env.PATH).toBe(`/opt/toolchain${path.delimiter}${SAFE_PATH}`); // not the host PATH
  });

  it("looks the launcher up on the HOST PATH (not the narrowed child PATH)", () => {
    let seenPath: string | undefined;
    resolveExternalMcpSpawnSpec(
      installDir,
      { command: "node", args: [] },
      {
        hostEnv: { PATH: "/host/only" },
        resolveLauncher: (cmd, p) => {
          seenPath = p;
          return `/host/only/${cmd}`;
        },
      },
    );
    expect(seenPath).toBe("/host/only");
  });

  it("rejects a non-allowlisted launcher", () => {
    expect(() =>
      resolveExternalMcpSpawnSpec(installDir, { command: "rm", args: [] }, { resolveLauncher: okResolver }),
    ).toThrow(/not allowlisted/);
  });

  it.each(["/usr/bin/npx", "../npx", "dir/npx"])("rejects a path-bearing command (%s)", (command) => {
    expect(() =>
      resolveExternalMcpSpawnSpec(installDir, { command, args: [] }, { resolveLauncher: okResolver }),
    ).toThrow(/bare launcher/);
  });

  it("rejects a missing command", () => {
    expect(() => resolveExternalMcpSpawnSpec(installDir, { command: null, args: [] })).toThrow(/missing a command/);
  });

  it("rejects a launcher not found on PATH", () => {
    expect(() =>
      resolveExternalMcpSpawnSpec(installDir, { command: "uvx", args: [] }, { resolveLauncher: () => null }),
    ).toThrow(/not found on PATH/);
  });

  it("rejects a resolver that returns a relative path (would resolve against the child cwd)", () => {
    expect(() =>
      resolveExternalMcpSpawnSpec(installDir, { command: "npx", args: [] }, { resolveLauncher: () => "tools/npx" }),
    ).toThrow(/absolute path/);
  });

  it("rejects an install dir that does not resolve", () => {
    expect(() =>
      resolveExternalMcpSpawnSpec("/no/such/dir", { command: "npx", args: [] }, { resolveLauncher: okResolver }),
    ).toThrow(/install dir/);
  });

  it("keeps the canonical launcher allowlist", () => {
    expect([...EXTERNAL_MCP_ALLOWED_LAUNCHERS].sort()).toEqual(
      ["bun", "bunx", "deno", "node", "npx", "python3", "uvx"],
    );
  });
});

describe("resolveSpawnSpec routing", () => {
  let installDir: string;

  beforeEach(() => {
    installDir = mkdtempSync(path.join(tmpdir(), "super-route-"));
  });
  afterEach(() => rmSync(installDir, { recursive: true, force: true }));

  it("routes external_mcp+stdio to the launcher resolver", () => {
    const spec = resolveSpawnSpec(
      record({ runtimeType: "external_mcp", entrypoint: null, command: "node", installDir }),
      { resolveLauncher: (cmd) => `/opt/${cmd}` },
    );
    expect(spec.argv[0]).toBe("/opt/node");
    expect(spec.cwd).toBe(realpathSync(installDir));
  });

  it("throws for external_mcp+sse/http (connects without spawning)", () => {
    expect(() =>
      resolveSpawnSpec(record({ runtimeType: "external_mcp", transport: "sse", entrypoint: null, url: "https://x" })),
    ).toThrow(SuperPluginExecError);
  });
});

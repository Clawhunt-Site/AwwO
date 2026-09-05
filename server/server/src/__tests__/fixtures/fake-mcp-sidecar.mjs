// Self-contained minimal MCP stdio server (NO imports beyond Node built-ins — the
// runner spawns it with a narrowed env that cannot resolve node_modules). Speaks
// newline-delimited JSON-RPC over stdio, matching SuperStdioTransport's framing.
//
// argv: [pidFilePath, mode?]. Writes this process's PID (and any spawned grandchild
// PID, one per line) to that file so an E2E can assert process-group teardown
// (killpg). When mode === "ignore-initialize" the server NEVER answers `initialize`,
// driving the client's connect/initialize timeout teardown path with a real child.
//
// Tools:
//   echo         → returns the arguments + whether SECRET_LEAK_TEST leaked into env.
//   env_dump     → returns the child's full env key set + PATH (for env-isolation asserts).
//   hang         → never responds (drives the per-call timeout / killpg path).
//   spawn_child  → forks a long-lived grandchild in THIS process group, records its
//                  PID, and returns it (so killpg of this group must kill it too).
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const pidFile = process.argv[2];
const mode = process.argv[3];
const ignoreInitialize = mode === "ignore-initialize";
if (pidFile) writeFileSync(pidFile, `${process.pid}\n`);

// A long-lived grandchild in THIS process group that IGNORES SIGTERM — so a teardown
// that only sends SIGTERM (or skips SIGKILL once the launcher exits) would leave it
// alive. Only a SIGKILL to the whole group reaps it. Spawned via the absolute node
// path (PATH is narrowed), stdio ignored.
function spawnResistantGrandchild() {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1e9)"],
    { stdio: "ignore" },
  );
  if (pidFile && child.pid) appendFileSync(pidFile, `${child.pid}\n`);
  return child.pid;
}

// In connect-timeout mode the client never finishes initialize, so exercise group
// teardown of a pre-spawned resistant descendant by starting one immediately.
if (ignoreInitialize) spawnResistantGrandchild();

// "spawn-then-exit": leave a resistant descendant in the group, then EXIT the launcher
// immediately — exercises close()'s ability to reap a group whose leader already died.
if (mode === "spawn-then-exit") {
  spawnResistantGrandchild();
  process.exit(0);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined || msg.id === undefined) return; // notification → ignore
  const { id, method, params } = msg;
  if (method === "initialize") {
    if (ignoreInitialize) return; // never answer → exercise the connect/initialize timeout
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-sidecar", version: "0.0.1" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: { tools: [{ name: "echo" }, { name: "env_dump" }, { name: "hang" }, { name: "spawn_child" }] },
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name === "hang") return; // intentionally never respond
    if (name === "env_dump") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ keys: Object.keys(process.env).sort(), path: process.env.PATH ?? null }) },
          ],
        },
      });
      return;
    }
    if (name === "spawn_child") {
      const grandchildPid = spawnResistantGrandchild();
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(grandchildPid) }] } });
      return;
    }
    // echo (default)
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              args: params?.arguments ?? null,
              leaked: process.env.SECRET_LEAK_TEST ?? null,
              hasHome: Boolean(process.env.HOME),
            }),
          },
        ],
      },
    });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

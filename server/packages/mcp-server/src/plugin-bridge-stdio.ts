#!/usr/bin/env node
import { runPluginBridge } from "./plugin-bridge.js";

void runPluginBridge().catch((error) => {
  // stderr only — stdout is the MCP JSON-RPC channel and must not be polluted.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

# ClawWork

**ClawWork** — SuperClaw's model-relay coding harness.

A self-contained AI coding agent (read / bash / edit / write tools; RPC and
interactive modes), maintained inside SuperClaw. ClawWork supplies the agent
loop; SuperClaw supplies governance — a signed policy snapshot enforced
in-process, fail-closed.

## Packages

* **[@superclaw/clawwork](packages/coding-agent)** — interactive coding agent CLI + agent loop (`clawwork`)
* **[packages/agent](packages/agent)** — agent runtime: tool calling and state management
* **[packages/ai](packages/ai)** — unified multi-provider LLM API (OpenAI, Anthropic, Google, …)
* **[packages/tui](packages/tui)** — terminal UI primitives

## Build

```bash
npm ci --ignore-scripts
npm run build
node packages/coding-agent/dist/cli.js --version
```

The SuperClaw backend auto-discovers the built harness — see
`scripts/build-clawwork.sh` at the SuperClaw repo root. `node_modules/` and
`dist/` are gitignored and built on demand.

## Governance

ClawWork runs are governed by `extensions/superclaw-governance.ts`, loaded via
`-e`: a signed policy snapshot enforces the permission posture in-process
(denylist > allowlist > pay/scan hard gates > read-only mode), failing closed on
a missing or forged snapshot.

## License & attribution

See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

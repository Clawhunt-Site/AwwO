# ClawWork

SuperClaw's model-relay coding harness — a **hard fork** of
[`earendil-works/pi`](https://github.com/earendil-works/pi) taken at `v0.79.1`,
**vendored into SuperClaw at `third_party/clawwork` and maintained here**. The
upstream git history is dropped (this is a snapshot, not a tracking fork) and
SuperClaw owns it from here on — no automatic upstream rebases. See `NOTICE`
for license/attribution. `node_modules/` and `dist/` are gitignored; build the
bundled harness with `scripts/build-clawwork.sh` (or `npm ci && npm run build`
here) and the ClawWork backend auto-discovers it (no env wiring needed).

## Origin policy (D3, docs/clawwork-two-track-dev-plan.md in SuperClaw)

- The v0.79.1 snapshot started as a **config-only** rebrand:
  `packages/coding-agent/package.json` sets
  `piConfig: {name: "clawwork", configDir: ".clawwork"}` and `bin.clawwork`
  (`@superclaw/clawwork`). Pi natively supports white-labeling, so the original
  rebrand changed **zero source lines** — but the harness is now maintained
  in-tree, so this is a starting point, not a rebase constraint.
- `extensions/superclaw-governance.ts` — the policy-snapshot governance
  extension (D4). Canonical copy lives HERE; SuperClaw's backend loads it via
  `-e` (path from `SUPERCLAW_CLAWWORK_GOVERNANCE_EXT`).
- `spikes/` — merge gates (§3b). Run before any upstream rebase:
  - `node spikes/spike-rpc-governance.mjs` — rpc + tool_call block end-to-end
    (+ ready-file content/nonce handshake)
  - `node spikes/spike-failclosed-contract.mjs` — fail-closed variants + hook
    contract pins (pinned to the surface SuperClaw consumes:
    tool_call/block+reason, tool_execution_end, agent_end, prompt)
  - `node spikes/spike-handshake-failclosed.mjs` — failed `-e` load never
    writes the ready file (backend fail-closes)
  - `node spikes/spike-posture-governance.mjs` — headless permission-posture
    projection (acceptEdits/default block bash; bypass + explicit allowlist
    pass; uppercase denylist still blocks)
  - `node spikes/spike-hardgate-bypass.mjs` — pay/scan hard-gate regexes have
    no loopback-exemption SSRF bypass (subdomain / userinfo / port+user)

## Build

```bash
npm ci --ignore-scripts && npm run build
node packages/coding-agent/dist/cli.js --version
```

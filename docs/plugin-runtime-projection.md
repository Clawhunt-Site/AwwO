# Plugin Runtime Projection (Local Agent ↔ SuperClaw Plugins)

Date: 2026-06-07

How SuperClaw plugins are made available to a local agent runtime (codex / Claude
Code) at run time — high-performance, low context cost, conversation-isolated,
and fail-closed.

## Problem

A local agent invoked by SuperClaw used to be blind to installed plugins: the
permission policy carried no MCP config by default, so codex got no MCP servers
and Claude even disabled tools (`--tools=`). The old per-plugin MCP proxy also
spawned one subprocess per plugin and dumped every tool's full JSON Schema into
the model's context.

## Architecture

```
SuperClawOrchestrator
  └─ _project_plugins_into_policy()           # per run, MCP-capable backends only
       └─ plugin_runtime_projection.available_plugins()   # fail-closed governance
            → build_runtime_plugin_policy_addition()       # writes a self-contained
              · superclaw-plugins.mcp.json  (1 aggregate MCP server)
              · superclaw-plugin-set.json   (plugins + cache_root + public_key)
  └─ WorkerLimits(permission_policy=+mcp_config, plugin_capabilities_note=note)
       └─ codex (-c mcp_servers.superclaw…) / claude (--mcp-config …)
            └─ spawns ONE aggregate proxy process per run (stdio)
                 plugin_mcp_proxy.AggregatePluginMcpProxyServer
                   · dispatch meta-tools: list_tools / describe_tool / call_tool
                   · per-run verification warm cache
                   · call_tool → plugin_proxy.invoke_cached_plugin_tool()
                        └─ full governance gate → one-shot plugin sidecar
```

Key files: `plugin_runtime_projection.py`, `plugin_mcp_proxy.py`,
`plugin_proxy.py`, `orchestrator.py` (`_project_plugins_into_policy`, ~L130),
`backends.py` (`_prompt` capabilities note, `_codex_mcp_config_overrides`).

## Low context cost: dispatch meta-tools (default)

The model never sees N×M tool schemas. The aggregate proxy exposes exactly three
meta-tools, so context is decoupled from plugin count:

- `superclaw__list_tools(plugin_id?)` → names + short descriptions (no schema)
- `superclaw__describe_tool(name)` → one tool's full inputSchema, on demand
- `superclaw__call_tool(name, arguments)` → runs it through the governance gate

`full` mode (every tool exposed directly) is available via
`SUPERCLAW_PLUGIN_PROJECTION_MODE=full` as an escape hatch.

## Conversation isolation (no cross-talk) — the core design decision

There are two independent axes; do not conflate them:

- **Aggregate over plugins**: one proxy serves all plugins (not one process per
  plugin). ✔ this is what "aggregate" means.
- **Lifecycle**: the aggregate proxy is spawned **per run** by the agent client
  over stdio (stdio MCP is point-to-point, spawned by the client). It is **not** a
  global singleton shared by all conversations.

Because each run gets its own proxy process (the per-run `superclaw-plugin-set.json`
path makes the codex session key unique), and the proxy is **stateless per call**
(read-only catalog; every `call_tool` spawns a fresh, isolated sidecar with only
that call's args + secrets), **two conversations calling the same plugin cannot
cross-talk**. Proven by `tests/test_plugin_mcp_proxy.py`
(`test_aggregate_servers_have_isolated_catalogs`) and
`tests/test_plugin_runtime_projection.py`
(`test_each_run_gets_its_own_proxy_config_and_process`).

Contrast — Hermes uses a single **global shared MCP connection pool** across all
sessions (one long-lived connection per server, only a per-server RPC lock, no
session isolation), betting servers are stateless. That is the design with the
cross-talk risk; SuperClaw's per-run model avoids it by construction.

## Lifecycle management

- Aggregate proxy: lives for the run, torn down with the run's agent process.
- Verification warm cache: held in the proxy instance → lives and dies with the
  per-run process; bounded by plugin count.
- Plugin sidecar: one short-lived process per `call_tool` (the security boundary).
- No global mutable state is shared across runs/conversations.

## Performance: per-run verification warm cache

The sidecar is one-shot by contract (stdin→stdout→exit), so the worker process
cannot be pooled without a plugin ABI change. The dominant *repeatable* per-call
cost is re-hashing every plugin file + re-verifying its signature, which is
immutable for an on-disk package. The proxy memoizes that per run via
`invoke_cached_plugin_tool(verification_cache=…)`:

- cached: `verify_plugin_integrity()` (digest re-hash + manifest contract +
  signature) — once per (package path, digest);
- always fresh: `check_plugin_revocation()` + entitlement + runtime policy.

Showcase (16 MB plugin, 5 calls): cold ≈0.14s vs warm ≈0.04s (~3–4×). See
`tests/test_plugin_warm_cache.py`.

## Governance: fail-closed gates (always enforced)

Projection only decides whether a plugin is *offered*; every actual call still
runs the full gate in `invoke_cached_plugin_tool`. A plugin is offered only if it
passes ALL of: installed → signature valid → not revoked → entitled → runtime
policy allows. Any failure silently drops it (one bad plugin never blocks the set).
Defense in depth: a tool listed in the startup catalog is still refused at call
time once revoked (`test_aggregate_call_revalidates_governance…`).

### Worked example: `dev.clawhunt.pay-switch-agent` (the "payswitch" plugin)

Verified against the real installed plugin:

- `list_cached_plugins` → **discovered** (`Pay-Switch Agent 0.2.0`, tool `payswitch`).
- `available_plugins` → **excluded (correct fail-closed)** because:
  - `PLUGIN_SIGNATURE_INVALID` — `SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY` not configured,
    so its signature cannot be verified;
  - `PLUGIN_ENTITLEMENT_MISSING` — `pricing_model: private_beta` with empty
    `entitlements.json`.

To make the agent actually discover + use it: (1) set
`SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY` to the key it was signed with; (2) add an
entitlement for `dev.clawhunt.pay-switch-agent` to `entitlements.json`. The
discovery pipeline itself is proven working on free, properly-signed plugins
(`test_available_plugins_lists_installed_free_plugin`).

## Configuration

| Switch | Default | Effect |
| --- | --- | --- |
| `SUPERCLAW_AUTO_PROJECT_PLUGINS` | on | auto-project available plugins into codex/claude runs |
| `SUPERCLAW_PLUGIN_PROJECTION_MODE` | `dispatch` | `dispatch` (3 meta-tools) or `full` (all tools) |
| `SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY` | unset | root key used to verify plugin signatures (required for non-test plugins) |
| `SUPERCLAW_PLUGIN_STATE_ROOT` | `~/.superclaw/plugins` | user-global root for plugin state (cache, revocations, entitlements, policy, local-config) |
| `~/.superclaw/plugins/entitlements.json` | empty | grants for paid/private plugins |
| `~/.superclaw/plugins/revocations.json` | — | revoked plugin versions (checked every call) |

The admission-gate inputs (cache + revocations + entitlements + policy) and the
plugin's runtime config (`local-config.json`) all resolve under the user-global
`SUPERCLAW_PLUGIN_STATE_ROOT`, so a plugin installed once is gated AND configured
identically regardless of the working directory a run is launched from — mirroring
the user-global skill store and projection ledger. The full installed-plugin state
is global; only per-project *authoring* artifacts stay cwd-relative (the fake-cloud
source registry `.superclaw/plugins/cloud` and developer submissions). Overrides:
`SUPERCLAW_PLUGIN_CACHE_PATH` (cache only), `SUPERCLAW_PLUGIN_CONFIG_PATH`
(local-config only), `SUPERCLAW_PLUGIN_LOCAL_STATE_PATH` (the cloud-sync write /
status-read governance root).

`superclaw plugin cloud-sync` writes the synced entitlements/revocations/policy into
this same global root, so a cloud revocation is immediately visible to the gate
(fail-closed) and to the surface's entitlement status — no cwd split. The FastAPI
surface reads the cloud-authoritative governance (`<cloud-root>/governance/*`)
directly rather than the synced local copy; this is the intentional online-vs-offline
split (the server is the sync source of truth), not a divergence from the CLI gate.

Only MCP-capable backends (`codex`, `codex-app-server`, `claude`) receive
projection; `bobo` / `hermes-cli` / `openclaw` reject mcp_configs and are skipped.

## codex MCP tool approval

codex raises `mcpServer/elicitation/request` to confirm each MCP tool call. The
session approves it only when the run's permission mode is auto
(`bypassPermissions` / `dontAsk` / `acceptEdits` / `auto`) via
`CodexApprovalDecision.accept_mcp_tool`; the call is still fully governed by the
plugin proxy. Verified end to end against real codex: `list_tools → call_tool →
"hello from SuperClaw"`.

## Future (only if needed)

- Shared aggregate proxy daemon over Streamable HTTP with `Mcp-Session-Id`
  isolation — fewer processes at very high concurrency; only for HTTP-capable
  clients (claude), and requires explicit per-session scoping. Not needed by the
  current per-run model.
- Opt-in persistent sidecar workers (manifest-declared) to pool plugin processes
  — requires a plugin ABI extension; one-shot plugins stay unaffected.

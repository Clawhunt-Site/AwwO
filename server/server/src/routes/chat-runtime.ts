import os from "node:os";
import { Router } from "express";
import type { DeploymentMode } from "@paperclipai/shared";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { ensureCommandResolvable, ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";
import {
  getServerAdapter,
  listServerAdapters,
  listEnabledServerAdapters,
} from "../adapters/registry.js";
import { adapterSupportsEffort, thinkingEffortOptionsFor } from "../services/adapter-effort.js";
import { isChatEligibleAdapter } from "../services/chat-compat.js";

/**
 * Composer runtime inventory — legacy `/api/backends`, `/api/agents`,
 * `/api/agents/:backend/models`, `/api/agents/probe` projected from the native
 * adapter registry, so the chat composer's runtime/model selectors render
 * unchanged.
 *
 * Effort: the upstream engine has no native reasoning-effort axis (it uses model
 * profiles), so `supports_effort_selection` is false — the surface must not
 * offer an effort the kernel would reject (mirrors the runtime-effort iron rule:
 * only render the control when the runtime truly supports it).
 *
 * Gated to `local_trusted`, matching the single-operator chat surface.
 */
type AdapterLike = { type: string; models?: { id: string; label: string }[] };

function toBackendInfo(adapter: AdapterLike, available: boolean) {
  const models = adapter.models ?? [];
  // Effort is reported per-adapter from the native effort axis (codex/claude/
  // opencode have one; gemini/cursor don't) — NOT a flat false. Mirrors the
  // runtime-effort iron rule: only offer the control when the runtime supports
  // it, with the levels coming from the contract (never hardcoded in the surface).
  const supportsEffort = adapterSupportsEffort(adapter.type);
  const effortLevels = thinkingEffortOptionsFor(adapter.type)
    .map((option) => option.value)
    .filter((value) => value.length > 0);
  return {
    name: adapter.type,
    label: adapter.type,
    // Disabled (registered-but-not-enabled) adapters must read as unavailable so
    // the composer/agent-creation surface hides them — they are intentionally
    // kept out of agent-creation menus (registry: disabled adapters hidden).
    available,
    supports_model_selection: models.length > 0,
    default_model: models[0]?.id ?? null,
    suggested_models: models.map((m) => m.id),
    supports_effort_selection: supportsEffort,
    effort_levels: effortLevels,
    effort_input_mode: supportsEffort ? ("select" as const) : null,
    // Display-only per the iron rule: the runtime's own default governs when the
    // turn sends "" (REQUEST_CLEAR); never backfilled into an explicit request.
    default_effort: null as string | null,
    uses_relay_packages: false,
    // Fail-closed: chat_capable mirrors the run-path predicate exactly
    // (isChatEligibleAdapter = allow-listed type AND trusted built-in module), so
    // the composer never offers a runtime the chat run path would refuse — gateway/
    // cloud relays, process/http built-ins, unlisted adapters, and external
    // overrides of an allow-listed type all report false.
    chat_capable: isChatEligibleAdapter(adapter.type),
    // "native" (not "streaming") — the composer only treats native/upgradeable
    // runtimes as interactive. null when the adapter is not chat-capable.
    chat_tier: isChatEligibleAdapter(adapter.type) ? "native" : null,
  };
}

// Sentinel company id for company-external global runtime probes. Deep probes run
// host-local (executionTarget: null) and never touch per-company secrets/state; the
// sentinel makes that explicit and keeps any incidental adapter logging from
// claiming a real company. (Codex gpt-5.5: placeholder companyId + executionTarget
// null is safe because no real company record is required or persisted.)
const GLOBAL_PROBE_COMPANY_ID = "global-runtime-reachability";

// Mirrors the surface contract apps/web RuntimeProbeResult (and the Python kernel's
// runtime_probe.ProbeResult): the verdict is rendered verbatim, never re-derived.
type RuntimeProbeResult = {
  backend: string;
  verdict: "runtime_ready" | "runtime_present" | "runtime_fail";
  detail: string;
  depth: string;
  present: boolean;
  version?: string | null;
  models_count?: number | null;
  default_model?: string | null;
  latency_ms?: number | null;
  failure_reason?: string | null;
};

function adapterModelSummary(adapter: ServerAdapterModule) {
  const models = adapter.models ?? [];
  return { models_count: models.length, default_model: models[0]?.id ?? null };
}

// LIGHTWEIGHT reachability (default / "Test all"): reuse the adapter's OWN
// declarative command spec + the shared `ensureCommandResolvable` primitive — a
// real on-disk check (PATH resolution + exec-bit), no inference, no token spend.
// Verdicts mirror the CLI kernel's three states verbatim (runtime_probe.py): a
// command ON DISK only proves PRESENCE, never live reachability (login/credentials/
// provider could still fail), so presence is `runtime_present`/`shallow` — NOT
// `runtime_ready`. Only a DEEP live testEnvironment promotes a runtime to
// `runtime_ready`. This is what fixes the old registry fail-open WITHOUT swapping it
// for a command-presence fake-green.
//   - command adapter, resolvable     -> runtime_present / depth "shallow"
//   - command adapter, not resolvable -> runtime_fail    / depth "none" (not installed)
//   - no command spec (http/gateway/cloud): can't probe presence or reachability
//     company-externally -> runtime_present / depth "registry" (registered, unverified)
// Fully wrapped: a single adapter's getRuntimeCommandSpec throwing (e.g. an external
// override) yields THAT runtime's runtime_fail, never a rejected probe batch.
async function probeLightweight(adapter: ServerAdapterModule): Promise<RuntimeProbeResult> {
  try {
    // Inside the try so even a throwing `models` getter on an external adapter is
    // isolated to this runtime's runtime_fail rather than rejecting the batch.
    const base = { backend: adapter.type, ...adapterModelSummary(adapter) };
    const spec = adapter.getRuntimeCommandSpec?.({}) ?? null;
    if (!spec || !spec.command) {
      return {
        ...base,
        verdict: "runtime_present",
        depth: "registry",
        present: true,
        detail: "Registered; run a deep test (or configure an agent) to verify connectivity.",
      };
    }
    const detectCommand = spec.detectCommand ?? spec.command;
    const startedAt = Date.now();
    try {
      await ensureCommandResolvable(detectCommand, os.tmpdir(), ensurePathInEnv({ ...process.env }));
      return {
        ...base,
        verdict: "runtime_present",
        depth: "shallow",
        present: true,
        detail: `CLI present on PATH: ${detectCommand} — run a deep test to verify live reachability.`,
        latency_ms: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        ...base,
        verdict: "runtime_fail",
        depth: "none",
        present: false,
        detail: `CLI not found: ${detectCommand}`,
        failure_reason: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - startedAt,
      };
    }
  } catch (err) {
    // adapterModelSummary or getRuntimeCommandSpec on an external adapter threw —
    // isolate it to this runtime's verdict instead of rejecting the probe batch.
    // Only `adapter.type` (a plain string field) is touched here, so this branch
    // cannot itself throw.
    return {
      backend: adapter.type,
      verdict: "runtime_fail",
      depth: "none",
      present: false,
      detail: "Could not probe the runtime.",
      failure_reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// DEEP reachability (manual, single runtime): call the adapter's OWN native
// `testEnvironment` end-to-end — host-local (executionTarget: null), sentinel
// company id, empty config (the adapter falls back to its built-in defaults and
// reads host credentials). May spend tokens / read local provider creds; only ever
// invoked on an explicit single-runtime request.
async function probeDeep(adapter: ServerAdapterModule): Promise<RuntimeProbeResult> {
  const startedAt = Date.now();
  try {
    // Inside the try so a throwing `models` getter or testEnvironment is isolated
    // to this runtime's runtime_fail rather than rejecting the batch.
    const { models_count, default_model } = adapterModelSummary(adapter);
    const result = await adapter.testEnvironment({
      companyId: GLOBAL_PROBE_COMPANY_ID,
      adapterType: adapter.type,
      config: {},
      executionTarget: null,
    });
    const verdict =
      result.status === "pass"
        ? "runtime_ready"
        : result.status === "warn"
          ? "runtime_present"
          : "runtime_fail";
    const firstError = result.checks.find((check) => check.level === "error");
    // Prefer the most salient line (error > warn > last info) for the one-line detail.
    const salient =
      firstError ??
      result.checks.find((check) => check.level === "warn") ??
      result.checks[result.checks.length - 1];
    return {
      backend: adapter.type,
      verdict,
      depth: "live",
      present: result.status !== "fail",
      detail: salient?.message ?? `Environment test ${result.status}`,
      failure_reason: firstError?.message ?? null,
      models_count,
      default_model,
      latency_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      backend: adapter.type,
      verdict: "runtime_fail",
      depth: "live",
      present: false,
      detail: "Deep environment test failed to run.",
      failure_reason: err instanceof Error ? err.message : String(err),
      models_count: null,
      default_model: null,
      latency_ms: Date.now() - startedAt,
    };
  }
}

export function chatRuntimeRoutes(opts: { deploymentMode: DeploymentMode }) {
  const router = Router();

  const gate = (
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (opts.deploymentMode !== "local_trusted") {
      res.status(403).json({
        error: "Chat is only available on local single-operator instances",
        code: "DEPLOYMENT_MODE_UNSUPPORTED",
      });
      return;
    }
    next();
  };

  router.get("/backends", gate, (_req, res) => {
    const enabled = new Set(listEnabledServerAdapters().map((a) => a.type));
    res.json({ backends: listServerAdapters().map((a) => toBackendInfo(a, enabled.has(a.type))) });
  });

  router.get("/agents", gate, (_req, res) => {
    const enabled = new Set(listEnabledServerAdapters().map((a) => a.type));
    const backends = listServerAdapters().map((a) => toBackendInfo(a, enabled.has(a.type)));
    // ready_count counts only ENABLED runtimes (disabled ones read as unavailable).
    const readyCount = backends.filter((backend) => backend.available).length;
    res.json({ agents: backends, summary: { count: backends.length, ready_count: readyCount } });
  });

  // Literal `/agents/probe` is registered before the parametric model route and
  // before the native `/api/agents/:id`, so a runtime reachability probe never
  // collides with an agent-by-id lookup.
  //
  // Two real-reachability depths, both reusing Paperclip's OWN native machinery
  // (no vendored upstream source changes — only this SuperClaw-owned surface route
  // orchestrates them). Reviewed adversarially by Codex (gpt-5.5): CONFIRMED USABLE.
  //   - default  -> LIGHTWEIGHT: per-adapter `getRuntimeCommandSpec` + the shared
  //     `ensureCommandResolvable` primitive. A real on-disk check (PATH + exec-bit),
  //     no inference, no token spend. This is what "Test all" runs.
  //   - ?depth=deep&backend=X -> DEEP: the adapter's native `testEnvironment`,
  //     host-local (executionTarget: null), end-to-end (process adapters run a real
  //     CLI hello-probe; http adapters HEAD the endpoint). May spend tokens, so it
  //     is manual + single-runtime only (a missing ?backend= is refused).
  router.get("/agents/probe", gate, async (req, res) => {
    const backend = typeof req.query.backend === "string" ? req.query.backend : null;
    const deep = req.query.depth === "deep";
    const scoped = backend
      ? listServerAdapters().filter((a) => a.type === backend)
      : listServerAdapters();

    if (deep && !backend) {
      // Deep probes spawn real CLIs / call providers and may spend tokens; never
      // fan that across every runtime. Deep is manual, single-runtime only.
      res.status(400).json({
        error: "Deep probe requires an explicit ?backend= (never fanned across all runtimes).",
        code: "DEEP_PROBE_REQUIRES_BACKEND",
      });
      return;
    }

    const probes = await Promise.all(
      scoped.map((adapter) => (deep ? probeDeep(adapter) : probeLightweight(adapter))),
    );
    res.json({ probes });
  });

  router.get("/agents/:backend/models", gate, (req, res) => {
    const backend = req.params.backend as string;
    const adapter = getServerAdapter(backend) as unknown as AdapterLike;
    // getServerAdapter falls back to the built-in "process" adapter for unknown
    // types instead of throwing — detect the mismatch and 404 rather than return
    // a bogus empty model list for a backend the operator never installed.
    if (adapter.type !== backend) {
      res.status(404).json({ error: "unknown backend" });
      return;
    }
    res.json({
      name: backend,
      source: "static_contract",
      // The composer reads `models` as a string[] of model ids.
      models: (adapter.models ?? []).map((m) => m.id),
    });
  });

  return router;
}

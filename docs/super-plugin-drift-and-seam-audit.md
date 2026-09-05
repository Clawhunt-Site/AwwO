# Super-plugin drift & Node↔Python seam audit (Node-first)

Status: living backlog. Created 2026-07-01 on `dev/server-refactor`.

Context: after re-platforming the backend onto the vendored Paperclip Node server, this
audit traced (a) whether the Python fail-closed governance is still on the live execution
path, (b) whether the Node↔Python seams that remain can "fall through" (fail-open / contract
drift / half-state), and (c) the DB↔disk consistency of the Node-only "super plugin" runtime.

All file:line references are as of the audit (commit `b100b539` base); line numbers may shift
slightly after later commits but the call sites are stable.

---

## 0. Headline findings (so nobody re-derives them)

- **Runtime Node↔Python cord is essentially cut.** A whole-tree grep for `spawn/exec/execFile/
  fork` targeting a Python interpreter or the `superclaw` binary (non-comment, non-test) returns
  **zero** live hits. The only place Python is genuinely still load-bearing at runtime is the
  capability **install** path (the `workshop-import` signing bridge).
- **That one bridge is robust fail-closed** — NOT a fall-through risk. `POST /api/internal/
  workshop-import` (`server/server/src/routes/super-workshop.ts`) re-verifies the HMAC receipt
  (branded symbol, `workshop-receipt.ts`) + re-hashes the transport digest; loopback reads the
  real socket peer; the HMAC key is a 0600 file passed by path only; the canonical receipt is
  byte-locked by golden vectors exported from the Python signer; install→provenance ordering
  rolls back on failure; Python-down degrades to 503, never a Node-only install that skips
  cosign. Residual = same-UID local forge (== relay_key system-wide posture).
- **The real soft spots are Node-internal DB↔disk projection** for the Node-only super-plugin
  runtime (table `super_plugin_runtimes` + bytes under `~/.superclaw/super-plugins/<key>`).

## 1. DONE — Drift #1: catalog honesty (`effectiveStatus`)

Commit `ae445474` (feat branch `feat/super-plugin-list-honesty`). `listUnifiedPlugins`
(`server/server/src/services/plugin-runtime-router.ts`) previously read ONLY the DB, so a
deleted install dir left a row lying as `installed`. Added a live `fs.stat` probe + a NEW
`effectiveStatus` field (installed/ready+absent→`missing`; installing+absent→`install_failed`;
probe error→`inaccessible`; any other open-text status→passthrough). Strictly additive:
`status`/`official`/`executeTool` untouched; `probeInstallDir` optional. `official` deliberately
NOT downgraded on missing (would break the Python CLI uninstall surface in
`capability_workshop_installed.py`). Codex (gpt-5.5) + Gemini 3.1 Pro both PASS after a
first-round blocker (unknown-status masking) was fixed. 264 family tests + tsc green.

---

## 2. BACKLOG — deferred slices (owner decision 2026-07-01: not doing these now)

Recorded so they are not lost. Each notes whether it is purely additive or carries a real
regression surface (which dictates how cautiously it must be done).

### 2.1 Drift #2 — "installing forever" sentinel cleanup  ·  ADDITIVE-ish  ·  LOW
- What: a double failure (`materializeInstall` fails AND `removeInstallDir` also fails) in
  `rollbackClaim` (`super-plugin-installer.ts:122-138`) deliberately KEEPS the claim row as a
  blocking sentinel (`status:"installing"`). It is non-executable (`EXECUTABLE_SUPER_STATUSES`,
  `plugin-runtime-router.ts:129`) but never garbage-collected, so it lingers in the catalog.
- After Fix #1 it now surfaces as `effectiveStatus:"install_failed"` when its dir is absent.
- Recommended fix: NOT an automatic sweeper. Both advisors flagged the install-in-flight race
  (a naive TTL deletes a row whose `<dir>.tmp` is still being renamed in; startup-only is unsafe
  with >1 process). Instead expose an explicit **force-clean / repair** operation (admin-gated,
  unconditional `DELETE` row + `rm -rf` ignoring ENOENT) and let the human trigger it. The
  existing `DELETE /api/super-plugins/:key` already clears such a row when the dir is removable.

### 2.2 Live-disk digest gap (tamper)  ·  ⚠️ REGRESSION SURFACE  ·  MEDIUM-HIGH
- What: the digest check compares only two DB fields — `prov.packageDigest` vs the runtime
  row's `packageDigest` (`plugin-runtime-router.ts:90` and `:152`). It NEVER recomputes the
  digest over the live on-disk bytes. So if the install dir's bytes are tampered in place
  (realpath unchanged), the catalog still shows `official` and exec still runs the changed
  bytes. Skills already do a live recompute (`computeStoredSkillDigest`); super plugins do not.
- Recommended fix: recompute a live store digest for super plugins and gate `official` (catalog)
  + pre-exec on it, mirroring the skill path.
- ⚠️ NOT purely additive: it adds a gate on the existing catalog/exec path. If the recompute is
  not byte-identical to the digest recorded at install (packaging/normalisation differences),
  it will FALSELY reject currently-official, runnable plugins. Must be done as its own slice with
  the install-time algorithm aligned + heavy tests. Do NOT bundle with additive work.

### 2.3 Pay/scan governance vacuum on the default chat runtime  ·  POLICY  ·  HIGH
- What: the live chat exec chain `POST /api/chat/stream` → `heartbeat.executeRun` →
  `claude_local.execute` → `spawn` never enters Python; `permissions.py`/`fusion.py` (the old
  pay-switch / outbound-scan human gates) are dead on this path. A Node-native pay/scan hard gate
  exists ONLY inside the ClawWork adapter (`adapters/clawwork-local/src/server/governance.ts`,
  signed policy snapshot). The default `claude_local` (and other `*-local`) adapters import no
  governance module, so the agent is spawned with `--dangerously-skip-permissions` and no
  pay/scan choke equivalent to the suspended `fusion.py`.
- Recommended fix: lift the Node-native pay/scan hard gate out of the ClawWork adapter into a
  shared pre-spawn choke applied by all `*-local` adapters, so the default chat path is backed
  by the same fail-closed gate the kernel used to provide for every backend.
- Note: the project's "pay-switch/scan must be kernel-adjudicated, fail-closed across all
  surfaces" iron law still stands; only the "CLI is the single source of truth" law was retired
  (commit `b100b539`). This is the gap that most directly violates a surviving iron law.

### 2.4 Workspace `cwd` fail-open (no root confinement)  ·  POLICY/SECURITY  ·  MEDIUM
- What: a user-supplied workspace `cwd` (`local_path` source) is accepted verbatim. Validators
  only check presence (`server/packages/shared/src/validators/project.ts`, `execution-workspace.ts`);
  `routes/execution-workspaces.ts` passes `req.body.cwd` straight to the DB; `heartbeat.ts`'s
  `resolveWorkspaceForRun` uses it as the agent's launch cwd after only an `fs.stat` existence
  check. The managed branch (`home-paths.ts resolveManagedProjectWorkspaceDir` →
  `~/.paperclip/instances/...`) IS root-confined, but the user-cwd branch bypasses it. The only
  cwd "trust" code is a ~13-entry system-root DENYLIST in `session-workspace-cwd.ts`, consulted
  ONLY on the session-resume branch, and a denylist accepts `~/.ssh` etc.
- Threat model: under the local single-operator desktop model this is low severity (the operator
  already owns the machine). It becomes real only for a multi-tenant / exposed API / company-as-code
  import where a non-fully-trusted caller chooses the path — currently mitigated by the loopback +
  control-token front door.
- Recommended fix: a root-confinement allowlist + symlink rejection at `projects.ts createWorkspace/
  updateWorkspace` and/or `heartbeat.ts`, reusing the existing `resolvePathWithinRoot`/`isWithin`
  helpers already applied to storage/bundle paths but NOT to workspace cwd.

### 2.5 Drift #3 — super plugins split across Node vs Python views  ·  ARCHITECTURE  ·  LOW (down-graded)
- What: Node super plugins live under `~/.superclaw/super-plugins/<key>`; Python's plugin cache
  is a different path/layout (`plugins.py plugin_cache_root` → `~/.superclaw/plugins/cache/...`).
  The regular CLI `plugin list` / invoke / config don't see super plugins; only
  `capability_workshop_installed.py` (which reads Node `/api/super-plugins` over loopback) does.
- Down-grade: this used to be framed as a "CLI is the single source of truth" iron-law violation.
  That iron law was **retired by the owner** (commit `b100b539`). So this is now an accepted
  Node-first asymmetry / unfinished-feature gap, not a law violation. Optional convergence (if
  ever wanted): make `/api/super-plugins` the authoritative super-plugin front door and have the
  CLI union/dispatch with an explicit `origin: python-cache | node-super`. Not required.

---

## 3. Decision log
- 2026-07-01: Owner elects to ship only Fix #1 (`effectiveStatus`, commit `ae445474`) and DEFER
  §2.1–2.5. This doc preserves the analysis + recommended approach + regression-surface notes so
  any slice can be picked up cold later.

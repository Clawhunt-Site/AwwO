import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { globalSkillStoreDir } from "./global-runtime-skills.js";

/**
 * Load a seeded skill's bundled `scripts/manage.sh` from the on-disk asset tree
 * (`seed-skill-scripts/<slug>/manage.sh`, copied into `dist/` at build time the
 * same way `onboarding-assets` is). Resolved relative to THIS module so it works
 * under both `tsx src` (dev/test) and `node dist` (prod). Returns null if the
 * asset is missing (e.g. a packaging miss) so seeding degrades to "skill absent",
 * never a startup crash — seeding is best-effort by contract.
 */
function loadSeedScript(slug: string): string | null {
  try {
    return readFileSync(
      new URL(`./seed-skill-scripts/${slug}/manage.sh`, import.meta.url),
      "utf-8",
    );
  } catch {
    return null;
  }
}

/** Bundle a slug's `scripts/manage.sh` as a 0o755 SeededSkillFile, if present. */
function scriptFiles(slug: string): readonly SeededSkillFile[] {
  const content = loadSeedScript(slug);
  // Treat a missing OR empty script as "no script" so a scripted manager can be
  // fail-closed below (a present-but-empty manage.sh is as broken as an absent one).
  return content === null || content.trim() === ""
    ? []
    : [{ relPath: "scripts/manage.sh", content, mode: 0o755 }];
}

/**
 * Built-in skills seeded into the global skill store (`~/.superclaw/skills`) so a
 * fresh install can author its own skills from within chat. A seeded skill is a
 * normal global-store skill — it rides the §9 union, shows in the `@skill` picker
 * (chat-skills routes), and is injected into every run by the native heartbeat.
 *
 * Seeding is idempotent and NON-destructive: if the skill folder already exists
 * (e.g. the user customized it), it is left untouched. The `.provenance.json`
 * deliberately omits `store_digest` — the runtime recomputes the trust digest
 * from the on-disk bytes, and an empty declared digest skips the tamper compare
 * (a non-empty WRONG one would be dropped), so the seeded skill is trusted by
 * construction without us hand-computing a digest.
 */

const SKILL_CREATOR_SLUG = "skill-creator";

const SKILL_CREATOR_PROVENANCE = {
  schema_version: "0.1.0",
  source_url: null,
  source_digest: null,
} as const;

const SKILL_CREATOR_SKILL_MD = `---
name: skill-creator
description: Author a new SuperClaw skill from within chat — write a SKILL.md + provenance into the global skill store so every future chat can use it.
---

# Skill Creator

A **skill** is a folder in the global skill store with a \`SKILL.md\` (the
instructions an agent loads) and a \`.provenance.json\` (a trust marker). Skills in
the global store are injected into **every** chat run and are selectable in the
composer's \`@skill\` menu. Use this skill to create new ones.

## Where skills live

The global skill store is whatever \`$SUPERCLAW_SKILL_STORE_DIR\` points at, or
\`~/.superclaw/skills\` when that variable is unset. **Always resolve the active
store first** — do not assume \`~/.superclaw/skills\` — and **never write outside
it.** Each skill is a subfolder named by its kebab-case slug.

## To create a skill

1. Resolve the active store dir, e.g. in bash:
   \`\`\`bash
   STORE="\${SUPERCLAW_SKILL_STORE_DIR:-$HOME/.superclaw/skills}"
   \`\`\`
2. Pick a unique kebab-case slug, e.g. \`release-notes\`.
3. Make the folder: \`mkdir -p "$STORE/<slug>"\`
4. Write \`"$STORE/<slug>/SKILL.md"\` — YAML frontmatter then the guidance:

   \`\`\`markdown
   ---
   name: <slug>
   description: <one concise line describing when to use this skill>
   ---

   # <Title>

   <Step-by-step instructions / domain knowledge the agent should follow.>
   \`\`\`

5. Write \`"$STORE/<slug>/.provenance.json"\` exactly:

   \`\`\`json
   { "schema_version": "0.1.0", "source_url": null, "source_digest": null }
   \`\`\`

   Omit \`store_digest\` — the runtime recomputes the trust digest from the files.
   (A non-empty WRONG \`store_digest\` is treated as tampering and the skill is
   dropped, so just leave it out.)

6. Done. The skill is picked up automatically by the **next** chat — no restart.

## Rules

- Write only under the resolved \`$STORE\` (\`$SUPERCLAW_SKILL_STORE_DIR\` or
  \`~/.superclaw/skills\`); never outside it.
- Slug is kebab-case and unique (don't collide with an existing folder).
- \`SKILL.md\` must start with the \`name\` + \`description\` frontmatter.
- Both \`SKILL.md\` and \`.provenance.json\` are required, or the skill is ignored.
- Keep \`SKILL.md\` self-contained guidance — it is loaded verbatim as context.
`;

const COMPANY_MANAGER_SLUG = "company-manager";

const COMPANY_MANAGER_PROVENANCE = {
  schema_version: "0.1.0",
  source_url: null,
  source_digest: null,
} as const;

// Guidance only: the agent manages companies by calling the SAME native company
// REST API the board uses (single source of truth — no parallel implementation).
// On local_trusted the loopback server treats an unauthenticated request as the
// local board, so the agent must call WITHOUT an Authorization header to act as
// the operator; sending an agent token would downgrade it to branding-only edits.
const COMPANY_MANAGER_SKILL_MD = `---
name: company-manager
description: Fully control a company (agent team) from within chat, via SuperClaw's native company API — GUIDED-onboard a new company (parse the need, pick a real runtime+model, hire a founding agent), plus create/list/update/archive/delete the company itself and RUN it: create & drive tasks (issues/subtasks/comments), hire & operate agents (wake/invoke/pause/resume/terminate), inspect the runtime catalog (runtimes/models/profiles), manage assets (projects/goals/routines/labels/environments), secrets & keys, and governance (budgets/approvals/pipelines). Use when the user asks to create, set up, manage OR operate their companies, or @-mentions one.
---

# Company Manager

A **company** is an agent team (its board, agents, issues, budget). This skill
manages AND operates companies from chat by calling the **same native company REST
API** the board UI uses — never a parallel implementation. Reference a company in
chat with **@company** (the composer resolves the mention to its id). Beyond the
company-level create / read / update / archive / delete, this skill drives the whole
company: creating and driving **tasks** (issues, subtasks, comments that wake the
assignee), hiring and operating **agents** (wake / invoke / pause / resume /
terminate), scaffolding **assets** (projects, goals, routines, labels, environments),
managing **secrets & keys**, and resolving **governance** gates (budgets, approvals,
pipelines). Run \`manage.sh help\` for the full command matrix.

## Preferred path: the bundled script

This skill ships an audited wrapper at \`scripts/manage.sh\` (resolve it relative to
this SKILL.md). **Prefer it** over hand-assembling curl — it resolves the API base,
omits the Authorization header (operator), and refuses destructive deletes without
\`--yes\`. It auto-verifies **create** (re-GETs by id), **archive** (confirms status),
and **delete** (confirms 404); for **update** it re-reads the full company and prints
it with \`{"ok":true,"reread":true,...}\` so YOU confirm each changed field took (the API
silently drops unknown keys, so a 2xx alone never proves an update):

**Run the bundled script by its ABSOLUTE path** — it sits next to THIS SKILL.md you are
reading. If you read this file from \`/abs/path/to/company-manager/SKILL.md\`, then the
script is \`/abs/path/to/company-manager/scripts/manage.sh\`. Do NOT use \`$0\`/\`dirname\`
(this SKILL.md is not the running script). **Always prefer this script over hand-rolling
curl** — it verifies writes, gates destructive ops, and encodes inputs safely; raw curl
loses all of that.

\`\`\`bash
SH="/abs/path/to/company-manager/scripts/manage.sh"   # the dir you read this SKILL.md from + /scripts/manage.sh

# --- Company-level CRUD ---
"$SH" list
"$SH" stats
"$SH" inspect <id>
"$SH" create --name "Growth Lab" --description "experiments" --budget-cents 50000
"$SH" update <id> --status paused
"$SH" update <id> --json-patch '{...}'   # any other valid field (branding, attachment
                                         #   limits, …); EITHER flags OR --json-patch
"$SH" archive <id> --yes         # stops the company's agents → needs --yes
"$SH" delete <id> --yes          # PERMANENT — only after the user explicitly confirms

# --- Read live state (all GET) ---
"$SH" dashboard <id>             # rollup: agents, issues, activity
"$SH" agents <id> | issues <id> [--status S] [--project P] | projects <id> | goals <id>
"$SH" routines <id> | activity <id> | approvals <id> | budget <id> | costs <id>
"$SH" search <id> --q "text"

# --- Put the company to WORK: tasks + driving them ---
"$SH" new-issue <companyId> --title "Ship v1" --priority high --assignee-agent <agentUuid>
"$SH" subtask <parentIssueId> --title "write tests"
"$SH" issue <issueId> | issue-update <issueId> --status in_progress
"$SH" comment <issueId> --body "please continue" --resume   # a comment WAKES the assignee

# --- Runtime catalog: which runtimes + models exist (pick what to HIRE) ---
"$SH" runtimes                                    # all runtimes + contract flags
"$SH" runtime-models claude_local                 # a runtime's model ids
"$SH" runtime-profiles <companyId> claude_local   # model lanes (e.g. a "cheap" lane)

# --- Agents: hire the team + run the company ---
"$SH" hire <companyId> --name "Coder" --adapter-type claude_local --model claude-opus-4-8
"$SH" agent <agentId> | agent-update <agentId> --role "reviewer"
"$SH" wake <agentId> --reason "new work" | invoke <agentId>   # invoke = run ONE heartbeat now
"$SH" pause <agentId> | resume <agentId> | approve <agentId> | terminate <agentId> --yes

# --- Assets the company works within (all create + re-read verify) ---
"$SH" new-project <companyId> --name "Launch" --goal <goalUuid>
"$SH" new-goal <companyId> --title "Grow MRR" --level objective
"$SH" new-routine <companyId> --title "Nightly triage" --priority medium
"$SH" new-label <companyId> --name bug --color '#EF4444'
"$SH" new-environment <companyId> --name staging --driver local

# --- Secrets & keys (SENSITIVE — confirm with the user first) ---
"$SH" secrets <id> | provider-configs <id> | agent-keys <agentId>
"$SH" new-secret <companyId> --name OPENAI_KEY --value "sk-…"   # value never echoed back
"$SH" delete-secret <secretId> --yes
"$SH" new-agent-key <agentId> --name ci | delete-agent-key <agentId> <keyId> --yes

# --- Governance & finance ---
"$SH" set-budget <companyId> --monthly-cents 500000            # 0 = unlimited
"$SH" approve-request <approvalId> --note "ok" | reject-request <approvalId>
"$SH" new-pipeline <companyId> --key review --name "Review Flow"

"$SH" help                        # the FULL command matrix + every flag
\`\`\`

It prints the API JSON — with secret-named fields (\`token\`/\`*secret*\`/\`*apiKey*\`/
\`*password*\`/\`private*Key*\`/\`authorization\`/… matching the server's own secret-field
pattern) and the \`env\`/\`envVars\` bindings masked as \`[redacted]\` so credentials never leak
into the chat transcript — then a final status line. (secret VALUES from create/rotate are not
printed at all.) Writes that can be re-read emit
\`{"ok":true,"verified":true,...}\` (create/hire/archive/delete/terminate — re-read to
confirm) or \`{"ok":true,"reread":true,...}\` (update — re-reads so YOU confirm each
changed field, since the API silently drops unknown keys). A non-zero exit with
\`{"ok":false,"error":...}\` means it did **not** succeed — report that error, never
claim success. Destructive verbs (archive/delete/terminate/delete-secret/
delete-provider-config/delete-agent-key) refuse to run without \`--yes\`; get the
user's explicit confirmation first. Run \`"$SH" help\` for the complete matrix; the raw
REST contract below is the fallback when you need a field the script doesn't expose.

## Onboarding a NEW company (guided setup — do NOT leave a bare shell)

\`create\` alone makes an EMPTY company (no agents, no runtime, no model). When the user
asks to **create / set up / build / start a company** (anything beyond a literal "make an
empty company named X, don't ask"), run this guided flow so they end up with a company
that can actually work — **a company + its founding agent (with a real runtime + model)**:

1. **Understand the need.** From what the user said, work out what the company does and
   what its founding agent should handle. Ask **1–3 short clarifying questions ONLY** if
   the request is genuinely underspecified (what it does; what the first agent should own).
   Don't interrogate — infer sensible defaults and confirm them in one pass.

2. **Pick the runtime + model from REAL kernel data (never invent names or prices).**
   - Whether the user named a runtime/model or not, it MUST be validated against the live
     kernel catalog before hiring — the run path validates the adapter TYPE but the model id
     is free-form, so a typo'd or non-existent model would silently persist. If the user
     named one, confirm the backend is present + \`available:true\` + \`chat_capable:true\` in
     \`"$SH" runtimes\`, and the model appears in that runtime's \`suggested_models\` (or
     \`"$SH" runtime-models <backend>\`); if it isn't offered, tell the user and help them
     pick a real one — never pass through an unvalidated id.
   - Otherwise run \`"$SH" runtimes\` and choose among the entries that are BOTH
     \`available:true\` AND \`chat_capable:true\`. Default to **claude_local** (the recommended
     general runtime) when it is in that list, unless the task clearly fits another available
     one. Each \`runtimes\` entry already carries \`default_model\` (the runtime's flagship) and
     \`suggested_models\` — pick the flagship for demanding work, or a lighter entry from
     \`suggested_models\` when the user is cost-sensitive. (\`"$SH" runtime-models <backend>\`
     returns the same runtime's full model-id list if you want to double-check what's live.)
   - **Cost:** the kernel exposes **NO per-token/USD pricing** — do **not** state or invent
     dollar figures. Pre-creation, frame cost only as a capability TIER (the flagship
     \`default_model\` vs. a lighter \`suggested_models\` entry) and say plainly that exact
     pricing isn't available here. Offer a spend CAP via \`set-budget\`/\`set-agent-budget\`
     (below) if the user wants a hard ceiling. (A finer "cheap lane" signal — a runtime's
     model PROFILES — is company-scoped, so it's only reachable AFTER the company exists;
     see step 6.)

3. **Confirm the plan** in one line: company name + what it does + the chosen runtime/model
   + the founding agent's role. Proceed on a yes.

4. **Create the company:** \`"$SH" create --name "…" --description "…"\`.

5. **Hire ONE founding agent** (the chief) with the chosen runtime + model, e.g.
   \`"$SH" hire <companyId> --name "Chief of staff" --adapter-type <backend> --model <model> --role ceo\`.
   Verify it reports \`{"ok":true,"verified":true,"agentId":…}\`.

6. **Stop there — do NOT auto-create a first task, project, or goal.** The company +
   founding agent is the deliverable; let the user drive the first task next (via
   \`new-issue\` / \`comment\`). Report the company id, the chief agent id, and the chosen
   runtime + model with a one-line reason. If the user asked to optimize cost, you MAY now
   (the company exists) run \`"$SH" runtime-profiles <companyId> <backend>\` to surface a
   documented lower-cost lane (e.g. a \`"cheap"\` profile → a cheaper model+effort) and, on
   their OK, apply it with \`agent-update <agentId> --model <cheaper-model>\` — or set a hard
   ceiling with \`"$SH" set-budget <companyId> --monthly-cents N\` / \`set-agent-budget\`.

If the user explicitly wants a bare empty company ("just create one named X"), skip the
guided flow and run \`create\` directly.

## Reaching the API

The local server's base URL is in the \`SUPERCLAW_RUNTIME_API_URL\` environment
variable (fall back to the first entry of \`SUPERCLAW_RUNTIME_API_CANDIDATES_JSON\`
if it is unset). Resolve it first, e.g. in bash:

\`\`\`bash
API="\${SUPERCLAW_RUNTIME_API_URL:?company API base not set}"
\`\`\`

**Call WITHOUT an Authorization header.** On a local single-operator install the
loopback API treats an unauthenticated request as the operator (the board), which
is required to create / update / archive / delete. Adding a token would act as an
agent instead and be limited to branding edits. Always send
\`-H 'Content-Type: application/json'\` for request bodies.

## Operations

- **List**: \`GET $API/api/companies\` → a JSON **array** of companies (the body
  is the array itself, NOT wrapped in an object). Each element has \`id\`, \`name\`,
  \`status\` (active/paused/archived), \`description\`, and budget fields.
- **Stats**: \`GET $API/api/companies/stats\` → an object keyed by company id.
- **Inspect one**: \`GET $API/api/companies/<id>\` → that company object.
- **Create**: \`POST $API/api/companies\` with a JSON body. Only \`name\` is
  required; \`description\` and \`budgetMonthlyCents\` (integer cents, default 0)
  are optional. Returns 201 with the new company (use its \`id\` afterwards):
  \`\`\`bash
  curl -fsS -X POST "$API/api/companies" -H 'Content-Type: application/json' \\
    -d '{"name":"Growth Lab","description":"experiments","budgetMonthlyCents":50000}'
  \`\`\`
- **Update**: \`PATCH $API/api/companies/<id>\` with any subset of
  \`name\`/\`description\`/\`budgetMonthlyCents\`/\`status\`
  (\`active\`|\`paused\`|\`archived\`)/\`requireBoardApprovalForNewAgents\`.
- **Archive** — the PREFERRED way to remove a company. Reversible: it pauses the
  team but keeps all data, so it is the safe default for "remove / shut down this
  company". \`POST $API/api/companies/<id>/archive\` (no body), or \`PATCH\` with
  \`{"status":"archived"}\`. Reactivate any time with \`PATCH {"status":"active"}\`.
- **Delete** — PERMANENT and irreversible: \`DELETE $API/api/companies/<id>\` →
  \`{ "ok": true }\`. Only use this when the user explicitly wants the company and
  all its data gone for good; otherwise archive instead.

## Rules

- Resolve the company **id** before update/archive/delete — list or accept the
  @company mention; never guess an id.
- **Prefer archive over delete.** To remove or shut down a company, archive it
  (reversible) unless the user explicitly asks for permanent deletion. Reach for
  \`DELETE\` only on an unambiguous "delete permanently / wipe it" request.
- **Confirm destructive actions with the user first.** Deleting a company is
  permanent and archiving stops its agents — state exactly which company (name +
  id) and what will happen, and proceed only on an explicit yes.
- Use \`curl -fsS\` (or equivalent) so a non-2xx response surfaces as an error
  instead of being silently treated as success; report the API's error message.
- **Verify the write, don't trust the status code.** The API silently IGNORES
  field names it does not recognize (a misspelled or unsupported key is dropped,
  not rejected), so a 2xx alone does NOT prove your change took effect. After a
  create/update, read the returned JSON (or re-\`GET\` the company) and confirm the
  fields you intended actually hold the new values before telling the user it
  worked.
- Stick to the fields documented above; if you need a field not listed, inspect a
  company's JSON to confirm the exact key the API uses rather than guessing.
`;

/**
 * Global-store keys of the scripted manager skills, in the `superclaw-global:<slug>`
 * form `listGlobalRuntimeSkillEntries` produces. The chat run-config auto-DESIRES
 * these every turn (heartbeat) so they are actually MATERIALIZED into the runtime —
 * a global skill is otherwise only "available" (in the union / @skill picker) and
 * never symlinked into the agent's skills home unless explicitly desired. Single
 * source of truth so the heartbeat allow-list can never drift from the seeded slugs.
 */
export const CHAT_MANAGER_SKILL_KEYS: readonly string[] = [
  "superclaw-global:company-manager",
  "superclaw-global:skill-manager",
  "superclaw-global:plugin-manager",
];

const SKILL_MANAGER_SLUG = "skill-manager";

const SKILL_MANAGER_PROVENANCE = {
  schema_version: "0.1.0",
  source_url: null,
  source_digest: null,
} as const;

const SKILL_MANAGER_SKILL_MD = `---
name: skill-manager
description: Create, edit, optimize, list, validate, or delete SuperClaw skills from within chat — both global-store skills (injected into every chat) and company skills (REST). Use when the user wants to author or improve a skill.
---

# Skill Manager

A **skill** is a folder with a \`SKILL.md\` (instructions an agent loads), a
\`.provenance.json\` (trust marker), and optional \`scripts/\` / \`references/\` /
\`assets/\` subfolders. This skill creates and improves skills **compliantly** —
honoring the trust digest so an edited skill is never dropped as tampered.

There are TWO kinds of skill, with different storage and tooling:

- **Global-store skills** — live in \`$SUPERCLAW_SKILL_STORE_DIR\` (or
  \`~/.superclaw/skills\`), are injected into **every** chat, and are filesystem
  only (no REST). This is what \`skill-creator\` writes.
- **Company skills** — per-company, DB-backed, managed via REST under
  \`/api/companies/<companyId>/skills\`.

## Preferred path: the bundled script

This skill ships \`scripts/manage.sh\` (resolve it relative to this SKILL.md).
**Prefer it** — it locks the frontmatter, keeps provenance correct on every edit,
refuses symlinks, and validates before declaring success:

**Run the bundled script by its ABSOLUTE path** — it sits next to THIS SKILL.md. If you
read this from \`/abs/path/to/skill-manager/SKILL.md\`, the script is
\`/abs/path/to/skill-manager/scripts/manage.sh\`. Do NOT use \`$0\`/\`dirname\`. **Always use
this script** — it locks the frontmatter, keeps provenance correct, and refuses symlinks;
doing it by hand risks the §9 tamper-drop.

\`\`\`bash
SH="/abs/path/to/skill-manager/scripts/manage.sh"   # the dir you read this SKILL.md from + /scripts/manage.sh
# Global-store skills (filesystem, injected into every chat):
"$SH" create-global <slug> --description "one concise line"   # new global skill
"$SH" edit-global   <slug> --description "..."                # ONLY the description (see below)
"$SH" optimize-global <slug>                                  # re-seal provenance + validate after a hand-edit
"$SH" list-global
"$SH" validate <skill-dir>                                    # lint
# Company skills (DB, via REST) — full read loop, not just create/delete:
"$SH" list-company        <companyId> [--q "search"]         # what skills this company has
"$SH" inspect-company     <companyId> <skillId>              # one skill's detail
"$SH" versions-company    <companyId> <skillId>              # its version history
"$SH" new-version-company <companyId> <skillId> [--label T]  # snapshot a NEW version
"$SH" create-company      <companyId> --name N [--slug S] [--description D] [--markdown FILE]
"$SH" delete-company      <companyId> <skillId> --yes
\`\`\`

**Editing a skill's BODY (instructions/logic), not just its description:** \`edit-global\`
changes ONLY the frontmatter \`description\`. To change what a skill actually DOES, edit the
file directly — \`<store>/<slug>/SKILL.md\` (the store dir is \`$SUPERCLAW_SKILL_STORE_DIR\` or
\`~/.superclaw/skills\`) — with your normal file tools, THEN run \`optimize-global <slug>\` to
re-seal provenance + validate. If you skip \`optimize-global\` after a hand-edit, the runtime
drops the skill as tampered. (Company skills are different: \`create-company\` makes a NEW
skill — it is NOT a way to edit an existing one. To snapshot a new VERSION of an existing
company skill use \`new-version-company <companyId> <skillId> [--label T]\`.)

Each verb prints the API/JSON result; create/delete print a final \`{"ok":true,...}\` (or
\`{"ok":false,"error":...}\` + non-zero exit on failure) — report the error, never fake success.

## Compliance rules (these are why the script exists — follow them if you edit by hand)

- **Frontmatter is locked.** \`SKILL.md\` MUST start with \`name: <slug>\` (exactly the
  folder name, kebab-case) and a single-line \`description:\`. Changing \`name\` breaks
  routing — the script refuses a name that doesn't match the folder.
- **Provenance digest discipline (the #1 hazard).** \`.provenance.json\` must always be
  \`{ "schema_version": "0.1.0", "source_url": null, "source_digest": null }\`. NEVER
  write a non-null \`store_digest\`/\`source_digest\`: the runtime recomputes the digest
  from the on-disk bytes, and a stale/wrong declared digest makes the skill get
  **dropped as tampered** on the next chat. After ANY edit to \`SKILL.md\` or a script,
  re-write provenance to this null-digest form.
- **No symlinks, regular files only.** The digest walker refuses a skill folder that
  contains any symlink — write real files.
- **Both files required.** A folder without both \`SKILL.md\` and \`.provenance.json\` is
  ignored by the runtime.
- **Write only under the resolved store** (\`$SUPERCLAW_SKILL_STORE_DIR\` or
  \`~/.superclaw/skills\`); never outside it. Slug is kebab-case and unique.

## Company skills (REST)

Reach the API via \`SUPERCLAW_RUNTIME_API_URL\` (no Authorization header — operator on
loopback). Create: \`POST /api/companies/<companyId>/skills\`; update:
\`PATCH /api/companies/<companyId>/skills/<skillId>\`; new version:
\`POST /api/companies/<companyId>/skills/<skillId>/versions\`; delete:
\`DELETE /api/companies/<companyId>/skills/<skillId>\`. Always verify the write by
re-reading before reporting success.
`;

const PLUGIN_MANAGER_SLUG = "plugin-manager";

const PLUGIN_MANAGER_PROVENANCE = {
  schema_version: "0.1.0",
  source_url: null,
  source_digest: null,
} as const;

const PLUGIN_MANAGER_SKILL_MD = `---
name: plugin-manager
description: Manage plugin lifecycle (list/install/enable/disable/upgrade/config/remove) and scaffold a new plugin starter from within chat. Use when the user wants to manage installed plugins or start building a new one.
---

# Plugin Manager

A **plugin** extends SuperClaw with tools the agent can call (each plugin ships a small
worker process). Authoring a plugin works exactly like creating a skill or a company:
**natively, with NO signature.** This skill does two things:

- **Lifecycle of an existing plugin → the native REST API** under \`/api/plugins\`
  (list / inspect / install / enable / disable / upgrade / config / remove).
- **Create a NEW local plugin → \`scaffold\`, then \`install\`.** \`scaffold\` writes a REAL,
  directly-installable plugin: three plain-JS files (\`package.json\` + \`manifest.js\` +
  \`worker.js\`) with no build step, no SDK and no npm install. You then
  \`install <dir>/<plugin-id> --local --yes\` and it loads and runs immediately —
  **no signing involved.** \`scaffold\`'s JSON output carries an \`install_hint\` with the
  exact command.

**When IS signing needed?** Only when the user wants to **upload the plugin to the
capability workshop** to share it with others — that is the one place identity, a
signature and extra metadata are added. Creating and using a plugin locally never touches
signing, so never tell the user they must sign to author or install their own plugin.

## Preferred path: the bundled script

**Run the bundled script by its ABSOLUTE path** — it sits next to THIS SKILL.md. If you
read this from \`/abs/path/to/plugin-manager/SKILL.md\`, the script is
\`/abs/path/to/plugin-manager/scripts/manage.sh\`. Do NOT use \`$0\`/\`dirname\`. The script
talks to the runtime API for lifecycle and writes the local plugin's files on scaffold — no
external CLI is required.

\`\`\`bash
SH="/abs/path/to/plugin-manager/scripts/manage.sh"   # the dir you read this SKILL.md from + /scripts/manage.sh
# Create a NEW local plugin (real + installable, no signing), then install it:
"$SH" scaffold <plugin-id> [--dir DIR] [--tool-name NAME] [--summary TEXT]
"$SH" install  <dir>/<plugin-id> --local --yes        # loads the scaffolded plugin; runs immediately
# Discover / inspect (read-only):
"$SH" list [--status installed|ready|disabled|error|upgrade_pending|uninstalled]   # filter
"$SH" examples                                        # installable packages (for install)
"$SH" inspect     <plugin-id>
"$SH" health      <plugin-id>                         # is it loaded/healthy? (1st stop when broken)
"$SH" logs        <plugin-id> [--limit N] [--level L] [--since ISO]   # WHY it failed
# Lifecycle (REST):
"$SH" install     <path-or-name> [--local] [--version V] --yes
"$SH" enable      <plugin-id>
"$SH" disable     <plugin-id> [--reason "text"]
"$SH" upgrade     <plugin-id> [--version V]
"$SH" config-get  <plugin-id>
"$SH" config-test <plugin-id> --json '{...}'          # DRY-RUN a config before setting it
"$SH" config-set  <plugin-id> --json '{...}'
"$SH" remove      <plugin-id> --yes [--purge]         # --purge also deletes its stored data
\`\`\`

**Two different id shapes:** \`scaffold\` mints a NEW plugin, so its \`<plugin-id>\` MUST be a
dotted reverse-DNS id (e.g. \`acme.weather\`, lowercase). Every OTHER verb acts on an
ALREADY-INSTALLED plugin, so use whatever id \`list\`/\`inspect\` shows for it (manifest id,
DB UUID, or plugin key) — do not force the dotted form there.

**Diagnosing a broken plugin:** when a plugin "doesn't work", run \`health <id>\` then
\`logs <id>\` before guessing; before \`config-set\`, \`config-test\` the same JSON to dry-run it.

Output: \`scaffold\` prints \`{"ok":true,"installable":true,"id":...,"dir":...,"install_hint":...}\` (run its \`install_hint\` to install it); read/lifecycle
verbs print the API's JSON as-is; \`remove\` prints a final \`{"ok":true,"removed":...,"purged":...}\`.
Any failure is \`{"ok":false,"error":...}\` on a non-zero exit (e.g. \`confirmation_required\` for
install/remove without \`--yes\`). For a mutating verb (enable/disable/upgrade/config-set), the
API returns the new state — re-read with \`inspect\`/\`health\`/\`config-get\` and confirm it took
before reporting success. Report errors, never fake success.

## Compliance & governance (read this before promising anything)

- **Authoring a local plugin needs NO signature.** \`scaffold\` + \`install --local\` create and
  run a plugin natively — exactly like creating a skill or a company. Never tell the user
  they must sign to author or install their own plugin. Signing (identity + a signature +
  extra metadata) is minted ONLY when the user UPLOADS a plugin to the capability workshop
  to share it with others; that is a separate, governed step, not part of authoring.
- **\`install\` and \`remove\` are destructive / privileged** and require \`--yes\`. Installing
  pulls/loads code; confirm with the user first (name + what will happen). The install
  route requires instance-admin — if it returns 403, report it, don't fake success.
- Reach the API via \`SUPERCLAW_RUNTIME_API_URL\` (no Authorization header — operator on
  loopback). For a high-stakes change, **re-read** the plugin yourself with \`inspect <id>\`
  / \`config-get <id>\` and confirm the new state before telling the user it worked.
  (install/remove already block on --yes.)
`;

/** An extra file (e.g. `scripts/manage.sh`) bundled inside a seeded skill folder. */
interface SeededSkillFile {
  /** Path RELATIVE to the skill folder, POSIX-style (e.g. `scripts/manage.sh`). */
  relPath: string;
  content: string;
  /** Optional unix mode, e.g. 0o755 for an executable script. */
  mode?: number;
}

interface SeededSkill {
  slug: string;
  provenance: { schema_version: string; source_url: null; source_digest: null };
  skillMd: string;
  /**
   * Extra files written INTO the skill folder alongside SKILL.md — e.g. a
   * `scripts/manage.sh` the agent runs. They are hashed into the §9 trust digest
   * together with SKILL.md (the union recomputes from on-disk bytes because
   * provenance keeps `source_digest:null`), so a bundled script is trusted by
   * construction — no hand-computed digest. The runtime symlinks the whole folder
   * into the agent's skills home, so the scripts travel with it.
   */
  files?: readonly SeededSkillFile[];
  /**
   * Fail-closed marker: this skill is USELESS without its bundled script (a manager
   * whose SKILL.md tells the model to run `scripts/manage.sh`). If the script asset
   * could not be loaded (packaging miss → `files` empty), the skill is NOT seeded —
   * better an absent capability than a "trusted" SKILL.md promising a script that is
   * not on disk (which would read as a real capability and then no-op).
   */
  requiresScript?: boolean;
  /**
   * SuperClaw-MANAGED built-in: refresh its SKILL.md + bundled files to OUR current
   * version on every seed (overwrite), so a SKILL.md/script fix actually reaches an
   * already-seeded install. Use ONLY for first-party infra skills the user is not
   * expected to fork (the manager skills) — a non-managed seed (e.g. skill-creator,
   * a fork-me template) stays NON-destructive so user edits survive.
   */
  managed?: boolean;
}

/**
 * Reject a bundled-file relPath that could escape the skill folder or create a
 * symlink-like entry. The §9 digest walker throws on the first symlink and refuses
 * the skill, so the seeder must only ever write regular files under the slug dir.
 * Fail-closed: an unsafe relPath throws rather than being silently skipped.
 */
function assertSafeRelPath(relPath: string): void {
  if (!relPath || path.isAbsolute(relPath) || relPath.startsWith("/")) {
    throw new Error(`seeded skill file relPath must be relative and non-empty: ${relPath}`);
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized === "." || normalized.startsWith("..") || normalized.split("/").includes("..")) {
    throw new Error(`seeded skill file relPath must not traverse upward: ${relPath}`);
  }
  if (normalized !== relPath.replace(/\\/g, "/")) {
    throw new Error(`seeded skill file relPath must be a normalized POSIX path: ${relPath}`);
  }
}

// The built-in skills seeded on startup. Each is seeded INDEPENDENTLY (see
// seedChatSkillsInto) so adding a new entry here always seeds it even when the
// others already exist — never a global "one present → skip all" early return.
const SEEDED_SKILLS: readonly SeededSkill[] = [
  { slug: SKILL_CREATOR_SLUG, provenance: SKILL_CREATOR_PROVENANCE, skillMd: SKILL_CREATOR_SKILL_MD },
  {
    slug: COMPANY_MANAGER_SLUG,
    provenance: COMPANY_MANAGER_PROVENANCE,
    skillMd: COMPANY_MANAGER_SKILL_MD,
    files: scriptFiles(COMPANY_MANAGER_SLUG),
    requiresScript: true,
    managed: true,
  },
  {
    slug: SKILL_MANAGER_SLUG,
    provenance: SKILL_MANAGER_PROVENANCE,
    skillMd: SKILL_MANAGER_SKILL_MD,
    files: scriptFiles(SKILL_MANAGER_SLUG),
    requiresScript: true,
    managed: true,
  },
  {
    slug: PLUGIN_MANAGER_SLUG,
    provenance: PLUGIN_MANAGER_PROVENANCE,
    skillMd: PLUGIN_MANAGER_SKILL_MD,
    files: scriptFiles(PLUGIN_MANAGER_SLUG),
    requiresScript: true,
    managed: true,
  },
];

/**
 * Write a bundled file ONLY if it is absent — never overwrite. Used both on a fresh
 * seed and to fill a gap on an already-seeded skill (e.g. a built-in that gained a
 * script in a new version): a missing bundled file is added, an existing one (incl.
 * a user customization) is left untouched. Add-only ⇒ user edits always survive, and
 * because provenance keeps source_digest:null the union recomputes trust over the new
 * file set, so a filled-in script never trips the §9 tamper drop.
 */
/**
 * Atomically write a file: stage to a unique temp sibling, then rename into place.
 * rename(2) is atomic on the same filesystem, so a crash NEVER leaves a half-written
 * (truncated) target — only a stray `.tmp-*` that the next run overwrites. This kills
 * the "partial script looks like a customization and is skipped forever" hazard.
 */
async function writeFileAtomic(target: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${seedTmpCounter++}`;
  await fs.writeFile(tmp, content, "utf-8");
  if (mode !== undefined) await fs.chmod(tmp, mode);
  await fs.rename(tmp, target);
}
let seedTmpCounter = 0;

/**
 * True if `dir` itself OR any entry anywhere beneath it is a symlink — i.e. it is NOT
 * safe to write into via temp+rename (a symlinked `dir` or intermediate `scripts/`
 * would let the write escape OUTSIDE the store).
 *
 * FAIL-CLOSED: only a genuinely ABSENT path (ENOENT) is "safe" (returns false → a
 * fresh seed creates a clean dir). Any OTHER error — the path exists but can't be
 * lstat'd/enumerated (permissions, IO) — returns TRUE (treat as unsafe, refuse the
 * write) rather than fail-open and risk following a pre-placed symlink we couldn't see.
 * Each child is independently `lstat`'d (NOT trusting readdir's `Dirent` type bits,
 * which are `DT_UNKNOWN`/unreliable on some filesystems) so a symlink can't be missed.
 *
 * Threat model / boundary: this guards a once-at-startup seed into the operator's OWN
 * `~/.superclaw/skills` on a local single-operator install — it stops a pre-placed
 * symlink from redirecting a write OUTSIDE the store. It does NOT defend the configured
 * store ROOT itself being a symlink (that is operator config, by design) nor a TOCTOU
 * race that swaps a path to a symlink AFTER this scan (a local process racing startup
 * already has write access to the store). Backstop: the §9 union digest walker REFUSES
 * any skill folder containing a symlink at LOAD time, so even a slipped-through symlink
 * skill is dropped, never trusted/materialized.
 */
async function hasSymlinkInTree(dir: string): Promise<boolean> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false; // absent → clean
    return true; // exists-but-unverifiable → fail-closed
  }
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false; // a regular file at the path — not a symlink
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return true; // dir present but not enumerable → fail-closed
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    let childStat: import("node:fs").Stats;
    try {
      childStat = await fs.lstat(abs); // lstat per child — never trust readdir's type bits
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue; // vanished mid-scan → ignore
      return true; // unverifiable child → fail-closed
    }
    if (childStat.isSymbolicLink()) return true;
    if (childStat.isDirectory() && (await hasSymlinkInTree(abs))) return true;
  }
  return false;
}

/** Fill a bundled file ONLY if absent — never overwrite (preserve customizations). */
async function writeBundledFileIfAbsent(dir: string, file: SeededSkillFile): Promise<void> {
  assertSafeRelPath(file.relPath);
  const target = path.join(dir, file.relPath);
  try {
    await fs.access(target);
    return; // present already → never overwrite (preserve any customization)
  } catch {
    // absent → write it (atomically) below
  }
  await writeFileAtomic(target, file.content, file.mode);
}

/** Seed a single built-in skill if its folder is absent; otherwise fill gaps only. */
async function seedOneSkill(storeDir: string, skill: SeededSkill): Promise<void> {
  // Fail-closed: a script-required manager with no loadable script asset (packaging
  // miss) is NOT seeded — never ship a "trusted" SKILL.md that promises a manage.sh
  // that isn't on disk (it would read as a real capability and then no-op).
  if (skill.requiresScript && !(skill.files && skill.files.length > 0)) {
    console.warn(
      `[seed-chat-skills] refusing to seed "${skill.slug}": its required scripts/manage.sh ` +
        `asset could not be loaded (packaging miss) — skipping rather than seeding a scriptless skill`,
    );
    return;
  }

  const dir = path.join(storeDir, skill.slug);
  const skillFile = path.join(dir, "SKILL.md");
  // UNIFIED symlink guard — applies to EVERY write path below (managed refresh,
  // non-managed gap-fill, AND fresh seed into a pre-existing dir). Every write uses
  // writeFileAtomic (mkdir parent + temp + rename); if `dir` itself OR any component
  // beneath it (e.g. a `scripts/` symlink) is a symlink, the write would follow it
  // OUTSIDE the store. If the dir doesn't exist yet, this is false → a clean fresh
  // seed proceeds. (A non-existent dir + later mkdir creates only regular dirs.)
  if (await hasSymlinkInTree(dir)) {
    console.warn(`[seed-chat-skills] refusing to seed "${skill.slug}": its dir tree contains a symlink`);
    return;
  }
  let present = true;
  try {
    await fs.access(skillFile);
  } catch {
    present = false;
  }
  if (present) {
    if (skill.managed) {
      // MANAGED built-in: refresh SKILL.md + bundled files to OUR current version so a
      // SKILL.md/script fix actually reaches an already-seeded install (atomic overwrite).
      await writeFileAtomic(path.join(dir, ".provenance.json"), `${JSON.stringify(skill.provenance, null, 2)}\n`);
      for (const file of skill.files ?? []) {
        assertSafeRelPath(file.relPath);
        await writeFileAtomic(path.join(dir, file.relPath), file.content, file.mode);
      }
      await writeFileAtomic(skillFile, skill.skillMd);
      return;
    }
    // NON-managed: SKILL.md present (built-in or user-customized) → never overwrite it.
    // But DO fill in any MISSING bundled file so an EXISTING install of a built-in
    // that gained a script in a newer version still gets it (add-only, non-destructive).
    for (const file of skill.files ?? []) {
      await writeBundledFileIfAbsent(dir, file);
    }
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  // Write .provenance.json FIRST, bundled files (scripts) NEXT, SKILL.md LAST, so
  // the SKILL.md-existence idempotency guard above is sound: "SKILL.md present" then
  // implies provenance AND every bundled file were already written. Each write is
  // ATOMIC (temp+rename), and on a fresh seed we OVERWRITE the bundled files (we own
  // the dir) so a stray complete file from a prior crashed attempt is replaced with
  // our content — never a half-skill the union drops or a script that never runs.
  await writeFileAtomic(
    path.join(dir, ".provenance.json"),
    `${JSON.stringify(skill.provenance, null, 2)}\n`,
  );
  for (const file of skill.files ?? []) {
    assertSafeRelPath(file.relPath);
    await writeFileAtomic(path.join(dir, file.relPath), file.content, file.mode);
  }
  await writeFileAtomic(skillFile, skill.skillMd);
}

/**
 * Seed the built-in skills into a specific store directory. Idempotent and
 * non-destructive: each skill is checked INDEPENDENTLY, so an existing skill
 * folder is left untouched (user edits survive) while a newly-added built-in is
 * still seeded. Exposed for tests; production callers use {@link ensureSeedChatSkills}.
 */
export async function seedChatSkillsInto(storeDir: string): Promise<void> {
  for (const skill of SEEDED_SKILLS) {
    await seedOneSkill(storeDir, skill);
  }
}

// Memoized per process: the seed runs once at startup; subsequent calls no-op.
let seeded: Promise<void> | null = null;

/**
 * Idempotently seed the built-in chat skills into the global skill store. Safe to
 * call repeatedly (memoized); a failure drops the cached promise so a later call
 * retries. Best-effort: callers should not let a seed failure break startup — a
 * missing built-in skill only means the agent lacks that guide, never a crash.
 */
export function ensureSeedChatSkills(): Promise<void> {
  if (!seeded) {
    // Resolve the store dir INSIDE the async body so even a synchronous throw
    // (e.g. a bad env) becomes a rejected promise the caller's .catch can swallow,
    // rather than escaping a fire-and-forget `void ensureSeedChatSkills()`.
    seeded = (async () => {
      await seedChatSkillsInto(globalSkillStoreDir());
    })().catch((err) => {
      seeded = null;
      throw err;
    });
  }
  return seeded;
}

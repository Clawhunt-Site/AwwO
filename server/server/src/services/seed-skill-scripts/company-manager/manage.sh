#!/usr/bin/env bash
#
# company-manager — manage SuperClaw companies (agent teams) via the SAME native
# company REST API the board UI uses. A thin, audited wrapper around /api/companies,
# NOT a parallel implementation.
#
# Usage:
#   manage.sh list
#   manage.sh stats
#   manage.sh inspect <id>
#   manage.sh create --name NAME [--description DESC] [--budget-cents N]
#   manage.sh update <id> [--name N] [--description D] [--budget-cents N]
#                         [--status active|paused|archived] [--require-approval true|false]
#                         [--json-patch '{...}']   # any other valid field (branding,
#                              attachment limits, feedback data-sharing, …); EITHER the
#                              convenience flags OR --json-patch, not both.
#   manage.sh archive <id> --yes    # stops the company's agents → needs --yes
#   manage.sh delete  <id> --yes
#
# Read the company's live state (all read-only GET):
#   manage.sh dashboard <id>        # rollup: agents, issues, activity at a glance
#   manage.sh agents <id>           # the company's agents (team)
#   manage.sh issues <id> [--status S] [--project P]   # tasks/issues (filterable)
#   manage.sh blocked-count <id>    # count of BLOCKED issues (the only count the API exposes)
#   manage.sh projects <id> | goals <id> | routines <id> | pipelines <id>
#   manage.sh activity <id> | approvals <id> | live-runs <id> | heartbeat-runs <id>
#   manage.sh members <id> | environments <id> | labels <id> | org <id>
#   manage.sh budget <id> | costs <id>                 # budget overview / cost summary
#   manage.sh search <id> --q TEXT                     # full-text search within the company
#
# Runtime catalog — which agent runtimes + models exist (pick what to HIRE):
#   manage.sh runtimes                                 # all runtimes + contract flags
#   manage.sh runtime-models <backend>                 # a runtime's model ids (e.g. claude_local)
#   manage.sh runtime-profiles <companyId> <backend>   # model PROFILES / lanes (e.g. a "cheap"
#                                                      #   lane); the ONLY cost-adjacent kernel
#                                                      #   signal — there is NO per-token pricing
#
# Put the company to WORK — create tasks + drive them:
#   manage.sh new-issue <companyId> --title T [--description D] [--priority low|medium|high|urgent]
#             [--status S] [--work-mode M] [--assignee-agent UUID] [--project UUID] [--goal UUID]
#             [--json '{...}']    # OR a full createIssue body; --title required unless --json.
#   manage.sh subtask   <parentIssueId> --title T [ …same flags… ]   # a child task
#   manage.sh issue     <issueId>                       # inspect one issue
#   manage.sh issue-update <issueId> [--status S] [--priority P] [--title T] [--description D]
#             [--assignee-agent UUID] [--comment TEXT] [--json '{...}']
#   manage.sh comment   <issueId> --body TEXT [--resume] [--reopen] [--interrupt]
#                                                       # a comment WAKES the assignee → drives work
#
# Agents — hire the team + run the company:
#   manage.sh hire <companyId> --name N --adapter-type claude_local|codex_local|…
#             [--role R] [--title T] [--model M] [--reports-to UUID] [--json '{...}']
#   manage.sh agent <agentId>                           # inspect one agent
#   manage.sh agent-update <agentId> [--name N] [--role R] [--model M] [--json '{...}']
#   manage.sh wake  <agentId> [--reason TEXT] [--source on_demand|assignment|timer|automation]
#   manage.sh invoke <agentId>                          # run ONE heartbeat now
#   manage.sh pause <agentId> | resume <agentId> | clear-error <agentId>
#   manage.sh approve <agentId>                         # approve a pending-approval agent
#   manage.sh terminate <agentId> --yes                 # PERMANENT stop → needs --yes (prefer pause)
#
# Assets — the scaffolding a company works within (all create + re-read verify):
#   manage.sh new-project <companyId> --name N [--description D] [--status S] [--goal UUID]
#             [--lead-agent UUID] [--target-date D] [--json '{...}']
#   manage.sh new-goal    <companyId> --title T [--description D] [--level L] [--parent UUID]
#             [--owner-agent UUID] [--json '{...}']
#   manage.sh new-routine <companyId> --title T [--project UUID] [--goal UUID]
#             [--assignee-agent UUID] [--priority P] [--json '{...}']
#   manage.sh new-label   <companyId> --name N --color #RRGGBB
#   manage.sh new-environment <companyId> --name N --driver D [--description D] [--status S]
#             [--json '{...}']   # config/envVars/metadata objects need --json
#
# Secrets & keys (SENSITIVE — credentials; --value/--json carry plaintext on this box):
#   manage.sh secrets <id> | secret-providers <id> | provider-configs <id>   # read (list)
#   manage.sh new-secret <companyId> --name N --value V [--key K] [--provider P] [--json '{...}']
#             # managed secrets REQUIRE --value; --managed-mode external_reference REQUIRES
#             # --external-ref REF (any --value is accepted but ignored by the server).
#             # Value NOT echoed back; verified via list.
#   manage.sh secret-rotate <secretId> [--value V] [--external-ref R] [--json '{...}']
#   manage.sh delete-secret <secretId> --yes
#   manage.sh new-provider-config <companyId> --provider P --display-name N [--default] [--json '{...}']
#   manage.sh delete-provider-config <configId> --yes
#   manage.sh agent-keys <agentId>                       # list an agent's API keys
#   manage.sh new-agent-key <agentId> [--name N] [--json '{...}']
#   manage.sh delete-agent-key <agentId> <keyId> --yes   # revoke a key (immediate)
#
# Governance & finance — budgets, approval gates, pipelines:
#   manage.sh set-budget <companyId> --monthly-cents N   # 0 = unlimited; re-read verified
#   manage.sh set-agent-budget <agentId> --monthly-cents N
#   manage.sh approve-request <approvalId> [--note TEXT]  # resolve a pending approval gate
#   manage.sh reject-request  <approvalId> [--note TEXT]
#   manage.sh approval-comment <approvalId> --body TEXT
#   manage.sh new-pipeline <companyId> --key K --name N [--description D] [--project UUID]
#             [--json '{...}']   # stages need --json
#
# Governance: loopback, NO Authorization header (operator on a local install).
# Disruptive verbs (archive, delete) require --yes. create/update re-read and verify before
# claiming success — a 2xx alone never proves the write (unknown fields are dropped).
set -euo pipefail

_fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
_need() { [ -n "${1:-}" ] || _fail "$2" 2; }

# Reject an id segment that could traverse/inject (slashes, .., control, spaces).
# curl normalizes `../` in a URL path, so an unchecked id could escape the
# /api/companies/<id> scope — fail-closed BEFORE it reaches curl.
_safe_seg() {
  case "$1" in
    ""|*/*|*..*|*[!A-Za-z0-9._-]*) _fail "{\"ok\":false,\"error\":\"unsafe_id\",\"value\":\"$1\"}" 2 ;;
  esac
}
_int() { case "$1" in ''|*[!0-9]*) _fail "{\"ok\":false,\"error\":\"not_an_integer\",\"value\":\"$1\"}" 2 ;; esac; }
_bool() { case "$1" in true|false) : ;; *) _fail "{\"ok\":false,\"error\":\"not_a_boolean\",\"value\":\"$1\"}" 2 ;; esac; }
# Fail if any arguments are left over — so a trailing typo'd flag (e.g. `--yes --extra`)
# is surfaced as an error instead of being silently ignored and masking the mistake.
_no_extra() { [ $# -eq 0 ] || _fail "{\"ok\":false,\"error\":\"unexpected_args\",\"args\":\"$*\"}" 2; }

# Emit a server JSON object/array to stdout with credential-bearing fields MASKED, so
# plaintext env bindings / tokens / secret values never land in the chat transcript. Company
# objects legitimately carry env / envVars / adapterConfig.env / value / token, and the API
# returns them UNREDACTED to the loopback operator — printing them raw would leak them. Every
# command routes its human-facing object output through this. NOTE: our write-then-verify
# checks run on the RAW captured response BEFORE this filter, so redaction never weakens a
# verify — it only sanitizes what the agent sees. node is this skill's runtime (see _urlenc);
# if it were ever absent we DROP the body rather than risk echoing an unredacted secret.
_emit() {
  if command -v node >/dev/null 2>&1; then
    # NAME mirrors the server's own SECRET_FIELD_NAME_PATTERN (server/src/redaction.ts):
    # a SUBSTRING match, so apiKey/apiToken/accessToken/refreshToken/clientSecret/
    # authorization/bearer/privateKey/devicePrivateKeyPem/webhookSecret/jwt/cookie/... are all
    # caught, without over-masking benign names like keyId/publicKey. `env`/`envVars` are masked
    # WHOLESALE because their inner keys are arbitrary user var names whose VALUES are secrets.
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const NAME=/(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;const WHOLE=/^(?:env|envVars)$/i;const red=(x)=>Array.isArray(x)?x.map(red):(x&&typeof x==="object"?Object.fromEntries(Object.keys(x).map(k=>[k,(WHOLE.test(k)||NAME.test(k))?"[redacted]":red(x[k])])):x);try{process.stdout.write(JSON.stringify(red(JSON.parse(s))));}catch(e){}process.stdout.write("\n");});'
  else
    printf '{"ok":true,"note":"output suppressed: node unavailable to redact potential secrets"}\n'
  fi
}

# JSON-encode stdin as a quoted string: escapes backslash, double-quote AND the
# control chars (newline/CR/tab) that make a raw value illegal JSON.
_jstr() {
  local s; s="$(cat)"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"; s="${s//$'\r'/\\r}"; s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}
# Best-effort local check that $1 is a JSON OBJECT before sending it on (the server is the
# authority + silently drops unknown keys, so re-read still confirms what took). Uses node
# (this skill targets the Node runtime, no Python); skipped when node is absent.
_lint_json_object() {
  command -v node >/dev/null 2>&1 || return 0
  printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(3)}if(v===null||typeof v!=="object"||Array.isArray(v))process.exit(4)})' 2>/dev/null \
    || _fail '{"ok":false,"error":"json_patch_invalid","hint":"--json-patch must be a valid JSON object"}' 2
}

_resolve_api() {
  # This skill runs on the SAME host as the server, so prefer a LOOPBACK base
  # (127.0.0.1/localhost) from the candidate list — the primary URL may be a public
  # hostname that isn't reachable from here. Fall back to the primary, then any candidate.
  local primary="${SUPERCLAW_RUNTIME_API_URL:-}"
  local cands="${SUPERCLAW_RUNTIME_API_CANDIDATES_JSON:-}"
  local urls loop base
  urls="$(printf '%s\n%s\n' "$primary" "$(printf '%s' "$cands" | grep -oE 'https?://[^"]+' 2>/dev/null || true)")"
  # The local runtime API is plain HTTP on loopback — prefer an http loopback first,
  # then any loopback (https), then the primary URL.
  loop="$(printf '%s\n' "$urls" | grep -iE '^http://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)' | head -1 || true)"
  [ -n "$loop" ] || loop="$(printf '%s\n' "$urls" | grep -iE '^https?://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)' | head -1 || true)"
  base="${loop:-$primary}"
  [ -n "$base" ] && base="${base%/}"
  [ -n "$base" ] || base="$(printf '%s' "$cands" | grep -oE 'https?://[^"]+' | head -1 || true)"
  [ -n "$base" ] || _fail '{"ok":false,"error":"api_base_unset","hint":"SUPERCLAW_RUNTIME_API_URL not set; this skill needs a runtime with a shell + local API"}' 3
  printf '%s' "${base%/}"
}
API="$(_resolve_api)"

_req() {
  local method="$1" rpath="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$API$rpath" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$API$rpath"
  fi
}

# Extract a TOP-LEVEL field from a JSON object on stdin as a plain string.
# Robust: a real JSON parse means nested objects/arrays (e.g. an issue's
# relatedWork[].id, or an agent's nested status) can NOT spoof the value — the
# greedy-sed approach used to return the LAST match on a one-line response, which
# let a nested id/number defeat the verify-the-write step. Node is this skill's
# runtime (see _urlenc); the sed fallback is a best-effort degraded mode only.
_json_top() {
  if command -v node >/dev/null 2>&1; then
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=(o&&typeof o==="object"&&!Array.isArray(o))?o[process.argv[1]]:undefined;if(v===undefined||v===null||typeof v==="object")return;process.stdout.write(String(v));}catch(e){}});' "$1"
  else
    sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' | head -1
  fi
}
# Back-compat aliases: both now resolve the TOP-LEVEL field (string or number).
_json_str() { _json_top "$1"; }
_json_num() { _json_top "$1"; }

# URL-encode a query VALUE (search text, labels, …). Uses node (this skill
# targets the Node runtime); falls back to the raw value only when node is
# absent (loopback + safe-seg'd ids keep that fallback low-risk).
_urlenc() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(encodeURIComponent(process.argv[1] ?? ""))' "$1"
  else
    printf '%s' "$1"
  fi
}

# GET a read-only company sub-resource: /api/companies/<id><sub>. Every read
# command funnels through here so the id is safe-seg'd exactly once and the
# loopback base + curl flags stay identical to the write path.
_get_company_sub() {
  local id="$1" sub="$2"
  _need "$id" "{\"ok\":false,\"error\":\"missing_id\",\"hint\":\"<command> <companyId>\"}"
  _safe_seg "$id"
  _req GET "/api/companies/$id$sub" | _emit
}

cmd="${1:-}"; shift || true

case "$cmd" in
  list)  _req GET /api/companies | _emit ;;
  stats) _req GET /api/companies/stats | _emit ;;
  inspect)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"inspect <id>"}'; _safe_seg "$id"
    _req GET "/api/companies/$id" | _emit
    ;;
  create)
    name=""; description=""; budget=""; have_desc="no"
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name="${2:-}"; shift 2 ;;
        --description) description="${2:-}"; have_desc="yes"; shift 2 ;;
        --budget-cents) budget="${2:-}"; _int "$budget"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$name" '{"ok":false,"error":"missing_name","hint":"create --name NAME"}'
    body="{\"name\":$(printf '%s' "$name" | _jstr)"
    [ "$have_desc" = "yes" ] && body="$body,\"description\":$(printf '%s' "$description" | _jstr)"
    [ -n "$budget" ] && body="$body,\"budgetMonthlyCents\":$budget"
    body="$body}"
    created="$(_req POST /api/companies "$body")"
    printf '%s' "$created" | _emit
    # `id` is a UUID (no quotes/escapes) so it parses robustly even when name/desc
    # contain quotes. Re-GET by id confirms the create actually persisted; the model
    # should still eyeball the JSON above for the exact field values it sent.
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    back_id="$(_req GET "/api/companies/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"id":"%s","note":"created + confirmed retrievable; eyeball the JSON above for exact field values"}\n' "$new_id"
    ;;
  update)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"update <id> --field value | --json-patch {...}"}'; _safe_seg "$id"; shift || true
    parts=""; patch=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description) _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --budget-cents) _int "${2:-}"; _add "\"budgetMonthlyCents\":${2:-}"; shift 2 ;;
        --status) _add "\"status\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --require-approval) _bool "${2:-}"; _add "\"requireBoardApprovalForNewAgents\":${2:-}"; shift 2 ;;
        # Escape hatch for any valid company field the convenience flags don't cover
        # (branding, attachment limits, feedback data-sharing, …). The body IS this object;
        # the read-back below still confirms which fields actually took.
        --json-patch) patch="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$patch" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_update","hint":"use EITHER --json-patch OR the convenience --flags, not both"}' 2
      _lint_json_object "$patch"
      _req PATCH "/api/companies/$id" "$patch" >/dev/null
    else
      [ -n "$parts" ] || _fail '{"ok":false,"error":"no_fields","hint":"update <id> needs at least one --field or --json-patch {...}"}' 2
      _req PATCH "/api/companies/$id" "{$parts}" >/dev/null
    fi
    # Honest verification: re-READ the full company and emit it so the model can
    # confirm EVERY changed field actually took (the API silently drops unknown
    # keys). We do NOT blanket-claim "verified" for fields we didn't compare.
    fresh="$(_req GET "/api/companies/$id")"
    printf '%s' "$fresh" | _emit
    printf '{"ok":true,"reread":true,"id":"%s","note":"confirm the changed fields in the JSON above before reporting success"}\n' "$id"
    ;;
  archive)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"archive <id> --yes"}'; _safe_seg "$id"; shift || true
    # Archiving STOPS the company's agents — a disruptive action, so gate it like delete.
    [ "${1:-}" = "--yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"archive\",\"id\":\"$id\",\"detail\":\"Archiving stops this company's agents. Re-run with --yes after the user confirms.\"}" 4
    shift; _no_extra "$@"
    _req POST "/api/companies/$id/archive" >/dev/null
    got="$(_req GET "/api/companies/$id" | _json_str status)"
    [ "$got" = "archived" ] || _fail "{\"ok\":false,\"error\":\"archive_unconfirmed\",\"status\":\"$got\"}" 1
    printf '{"ok":true,"verified":true,"archived":"%s"}\n' "$id"
    ;;
  delete)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"delete <id> --yes"}'; _safe_seg "$id"; shift || true
    [ "${1:-}" = "--yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"delete\",\"id\":\"$id\",\"detail\":\"PERMANENT delete. Re-run with --yes only after the user explicitly confirms. Prefer archive.\"}" 4
    shift; _no_extra "$@"
    _req DELETE "/api/companies/$id" >/dev/null
    code="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/companies/$id")"
    [ "$code" = "404" ] || _fail "{\"ok\":false,\"error\":\"delete_unconfirmed\",\"http\":\"$code\"}" 1
    printf '{"ok":true,"verified":true,"deleted":"%s"}\n' "$id"
    ;;
  # ---- Read the company's state (see what it's doing) — all GET, read-only ----
  dashboard)      _get_company_sub "${1:-}" "/dashboard" ;;
  agents)         _get_company_sub "${1:-}" "/agents" ;;
  projects)       _get_company_sub "${1:-}" "/projects" ;;
  goals)          _get_company_sub "${1:-}" "/goals" ;;
  routines)       _get_company_sub "${1:-}" "/routines" ;;
  activity)       _get_company_sub "${1:-}" "/activity" ;;
  approvals)      _get_company_sub "${1:-}" "/approvals" ;;
  live-runs)      _get_company_sub "${1:-}" "/live-runs" ;;
  heartbeat-runs) _get_company_sub "${1:-}" "/heartbeat-runs" ;;
  members)        _get_company_sub "${1:-}" "/members" ;;
  environments)   _get_company_sub "${1:-}" "/environments" ;;
  labels)         _get_company_sub "${1:-}" "/labels" ;;
  pipelines)      _get_company_sub "${1:-}" "/pipelines" ;;
  org)            _get_company_sub "${1:-}" "/org" ;;
  budget)         _get_company_sub "${1:-}" "/budgets/overview" ;;
  costs)          _get_company_sub "${1:-}" "/costs/summary" ;;
  blocked-count)  _get_company_sub "${1:-}" "/issues/count?attention=blocked" ;;
  secrets)          _get_company_sub "${1:-}" "/secrets" ;;
  secret-providers) _get_company_sub "${1:-}" "/secret-providers" ;;
  provider-configs) _get_company_sub "${1:-}" "/secret-provider-configs" ;;

  # ---- Runtime catalog (which agent runtimes + models exist — pick a runtime+model to HIRE) ----
  # These read the SAME inventory the composer's runtime/model selectors use, so a hire
  # never picks a runtime/model the kernel doesn't actually offer.
  runtimes)
    # Every agent runtime the install exposes, with contract flags: available,
    # chat_capable, supports_model_selection, default_model, suggested_models,
    # supports_effort_selection, effort_levels, uses_relay_packages, chat_tier.
    _req GET /api/agents | _emit ;;
  runtime-models)
    b="${1:-}"; _need "$b" '{"ok":false,"error":"missing_backend","hint":"runtime-models <backend>   (e.g. claude_local)"}'; _safe_seg "$b"
    _req GET "/api/agents/$b/models" | _emit ;;
  runtime-profiles)
    # Company-scoped: the runtime's model PROFILES (e.g. a \"cheap\" lane = a lower-cost
    # model+effort the kernel itself documents). This is the authoritative cost-adjacent
    # signal — the kernel exposes NO per-token USD pricing, so never invent prices.
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"runtime-profiles <companyId> <backend>"}'; _safe_seg "$cid"; shift || true
    b="${1:-}"; _need "$b" '{"ok":false,"error":"missing_backend","hint":"runtime-profiles <companyId> <backend>"}'; _safe_seg "$b"
    _req GET "/api/companies/$cid/adapters/$b/model-profiles" | _emit ;;
  issues)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"issues <companyId> [--status S] [--project P]"}'; _safe_seg "$id"; shift || true
    q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --status)  _safe_seg "${2:-}"; q="${q:+$q&}status=$(_urlenc "${2:-}")"; shift 2 ;;
        --project) _safe_seg "${2:-}"; q="${q:+$q&}projectId=$(_urlenc "${2:-}")"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _req GET "/api/companies/$id/issues${q:+?$q}" | _emit
    ;;
  search)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"search <companyId> --q TEXT"}'; _safe_seg "$id"; shift || true
    term=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --q) term="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$term" '{"ok":false,"error":"missing_query","hint":"search <companyId> --q TEXT"}'
    _req GET "/api/companies/$id/search?q=$(_urlenc "$term")" | _emit
    ;;

  # ---- Tasks / issues: create work + drive it (the "put the company to work" surface) ----
  new-issue|subtask)
    # new-issue <companyId> …  |  subtask <parentIssueId> …   (same body, different endpoint)
    anchor="${1:-}"
    if [ "$cmd" = "new-issue" ]; then
      _need "$anchor" '{"ok":false,"error":"missing_id","hint":"new-issue <companyId> --title T [--priority P] [--assignee-agent UUID] [--project UUID] [--json {...}]"}'
    else
      _need "$anchor" '{"ok":false,"error":"missing_id","hint":"subtask <parentIssueId> --title T […]"}'
    fi
    _safe_seg "$anchor"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)          _add "\"title\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description)    _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --priority)       _add "\"priority\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --status)         _add "\"status\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --work-mode)      _add "\"workMode\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --assignee-agent) _add "\"assigneeAgentId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --project)        _add "\"projectId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --goal)           _add "\"goalId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)           jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags, not both"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"title":'*) : ;; *) _fail '{"ok":false,"error":"missing_title","hint":"--title is required (or pass a full --json body)"}' 2 ;; esac
      body="{$parts}"
    fi
    if [ "$cmd" = "new-issue" ]; then
      created="$(_req POST "/api/companies/$anchor/issues" "$body")"
    else
      created="$(_req POST "/api/issues/$anchor/children" "$body")"
    fi
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    back_id="$(_req GET "/api/issues/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"issueId":"%s","note":"created + confirmed retrievable; eyeball the JSON above for exact values"}\n' "$new_id"
    ;;
  issue)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"issue <issueId>"}'; _safe_seg "$id"
    _req GET "/api/issues/$id" | _emit
    ;;
  issue-update)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"issue-update <issueId> --status S | --priority P | --assignee-agent UUID | --comment TEXT | --json {...}"}'; _safe_seg "$id"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)          _add "\"title\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description)    _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --status)         _add "\"status\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --priority)       _add "\"priority\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --assignee-agent) _add "\"assigneeAgentId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --comment)        _add "\"comment\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)           jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; _req PATCH "/api/issues/$id" "$jbody" >/dev/null
    else
      [ -n "$parts" ] || _fail '{"ok":false,"error":"no_fields","hint":"issue-update <id> needs at least one --field or --json {...}"}' 2
      _req PATCH "/api/issues/$id" "{$parts}" >/dev/null
    fi
    fresh="$(_req GET "/api/issues/$id")"; printf '%s' "$fresh" | _emit
    printf '{"ok":true,"reread":true,"issueId":"%s","note":"confirm the changed fields in the JSON above before reporting success"}\n' "$id"
    ;;
  comment)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"comment <issueId> --body TEXT [--resume] [--reopen] [--interrupt]"}'; _safe_seg "$id"; shift || true
    cbody=""; flags=""
    _addf() { flags="${flags:+$flags,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --body)      cbody="${2:-}"; shift 2 ;;
        --resume)    _addf '"resume":true'; shift ;;
        --reopen)    _addf '"reopen":true'; shift ;;
        --interrupt) _addf '"interrupt":true'; shift ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$cbody" '{"ok":false,"error":"missing_body","hint":"comment <issueId> --body TEXT"}'
    body="{\"body\":$(printf '%s' "$cbody" | _jstr)${flags:+,$flags}}"
    created="$(_req POST "/api/issues/$id/comments" "$body")"
    printf '%s' "$created" | _emit
    cmt_id="$(printf '%s' "$created" | _json_top id)"
    [ -n "$cmt_id" ] || _fail '{"ok":false,"error":"comment_no_id","detail":"response had no id"}' 1
    _safe_seg "$cmt_id"
    _req GET "/api/issues/$id/comments" | grep -qF "\"$cmt_id\"" || _fail "{\"ok\":false,\"error\":\"comment_unconfirmed\",\"id\":\"$cmt_id\"}" 1
    printf '{"ok":true,"verified":true,"commentId":"%s","note":"posted + confirmed in the issue thread; a comment WAKES the assignee"}\n' "$cmt_id"
    ;;

  # ---- Agents: hire the team + drive them (run the company) ----
  hire)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"hire <companyId> --name N --adapter-type T [--role R] [--model M] [--reports-to UUID] [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --name)         _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --adapter-type) _add "\"adapterType\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --role)         _add "\"role\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --title)        _add "\"title\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --reports-to)   _add "\"reportsTo\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --model)        _add "\"adapterConfig\":{\"model\":$(printf '%s' "${2:-}" | _jstr)}"; shift 2 ;;
        --json)         jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"name":'*) : ;; *) _fail '{"ok":false,"error":"missing_name","hint":"--name is required (or pass a full --json body)"}' 2 ;; esac
      case ",$parts," in *'"adapterType":'*) : ;; *) _fail '{"ok":false,"error":"missing_adapter_type","hint":"--adapter-type is required (e.g. claude_local, codex_local)"}' 2 ;; esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/agents" "$body")"
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"hire_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    back_id="$(_req GET "/api/agents/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"hire_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"agentId":"%s","note":"hired + confirmed retrievable"}\n' "$new_id"
    ;;
  agent)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"agent <agentId>"}'; _safe_seg "$id"
    _req GET "/api/agents/$id" | _emit
    ;;
  agent-update)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"agent-update <agentId> --name N | --role R | --model M | --json {...}"}'; _safe_seg "$id"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --name)  _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --role)  _add "\"role\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --title) _add "\"title\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --model) _add "\"adapterConfig\":{\"model\":$(printf '%s' "${2:-}" | _jstr)}"; shift 2 ;;
        --json)  jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; _req PATCH "/api/agents/$id" "$jbody" >/dev/null
    else
      [ -n "$parts" ] || _fail '{"ok":false,"error":"no_fields","hint":"agent-update <id> needs at least one --field or --json {...}"}' 2
      _req PATCH "/api/agents/$id" "{$parts}" >/dev/null
    fi
    fresh="$(_req GET "/api/agents/$id")"; printf '%s' "$fresh" | _emit
    printf '{"ok":true,"reread":true,"agentId":"%s","note":"confirm the changed fields in the JSON above"}\n' "$id"
    ;;
  wake)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"wake <agentId> [--reason TEXT] [--source timer|assignment|on_demand|automation]"}'; _safe_seg "$id"; shift || true
    parts=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --reason) _add "\"reason\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --source) _add "\"source\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _req POST "/api/agents/$id/wakeup" "{$parts}" | _emit
    ;;
  invoke)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"invoke <agentId>"}'; _safe_seg "$id"; shift || true; _no_extra "$@"
    _req POST "/api/agents/$id/heartbeat/invoke" "{}" | _emit
    ;;
  pause)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"pause <agentId>"}'; _safe_seg "$id"; shift || true; _no_extra "$@"
    # The pause route (svc.pause) takes no body — it ignores any reason, so we don't offer one.
    _req POST "/api/agents/$id/pause" "{}" >/dev/null
    got="$(_req GET "/api/agents/$id" | _json_str status)"
    printf '{"ok":true,"reread":true,"agentId":"%s","status":"%s"}\n' "$id" "$got"
    ;;
  resume)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"resume <agentId>"}'; _safe_seg "$id"; shift || true; _no_extra "$@"
    _req POST "/api/agents/$id/resume" "{}" >/dev/null
    got="$(_req GET "/api/agents/$id" | _json_str status)"
    printf '{"ok":true,"reread":true,"agentId":"%s","status":"%s"}\n' "$id" "$got"
    ;;
  clear-error)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"clear-error <agentId>"}'; _safe_seg "$id"; shift || true; _no_extra "$@"
    _req POST "/api/agents/$id/clear-error" "{}" >/dev/null
    got="$(_req GET "/api/agents/$id" | _json_top status)"
    printf '{"ok":true,"reread":true,"agentId":"%s","status":"%s"}\n' "$id" "$got"
    ;;
  approve)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"approve <agentId>"}'; _safe_seg "$id"; shift || true; _no_extra "$@"
    _req POST "/api/agents/$id/approve" "{}" >/dev/null
    got="$(_req GET "/api/agents/$id" | _json_top status)"
    printf '{"ok":true,"reread":true,"agentId":"%s","status":"%s"}\n' "$id" "$got"
    ;;
  terminate)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"terminate <agentId> --yes"}'; _safe_seg "$id"; shift || true
    [ "${1:-}" = "--yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"terminate\",\"id\":\"$id\",\"detail\":\"Terminating stops the agent PERMANENTLY. Re-run with --yes after the user confirms; prefer pause.\"}" 4
    shift; _no_extra "$@"
    _req POST "/api/agents/$id/terminate" "{}" >/dev/null
    got="$(_req GET "/api/agents/$id" | _json_str status)"
    [ "$got" = "terminated" ] || _fail "{\"ok\":false,\"error\":\"terminate_unconfirmed\",\"status\":\"$got\"}" 1
    printf '{"ok":true,"verified":true,"terminated":"%s"}\n' "$id"
    ;;

  # ---- Assets: projects / goals / routines / labels / environments (the scaffolding a company works within) ----
  new-project)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"new-project <companyId> --name N [--description D] [--status backlog|active|…] [--goal UUID] [--lead-agent UUID] [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --name)        _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description) _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --status)      _add "\"status\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --goal)        _add "\"goalIds\":[$(printf '%s' "${2:-}" | _jstr)]"; shift 2 ;;
        --lead-agent)  _add "\"leadAgentId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --target-date) _add "\"targetDate\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)        jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"name":'*) : ;; *) _fail '{"ok":false,"error":"missing_name","hint":"--name is required (or pass a full --json body)"}' 2 ;; esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/projects" "$body")"
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    back_id="$(_req GET "/api/projects/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"projectId":"%s","note":"created + confirmed retrievable"}\n' "$new_id"
    ;;
  new-goal)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"new-goal <companyId> --title T [--description D] [--level task|…] [--parent UUID] [--owner-agent UUID] [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)       _add "\"title\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description) _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --level)       _add "\"level\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --status)      _add "\"status\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --parent)      _add "\"parentId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --owner-agent) _add "\"ownerAgentId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)        jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"title":'*) : ;; *) _fail '{"ok":false,"error":"missing_title","hint":"--title is required (or pass a full --json body)"}' 2 ;; esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/goals" "$body")"
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    back_id="$(_req GET "/api/goals/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"goalId":"%s","note":"created + confirmed retrievable"}\n' "$new_id"
    ;;
  new-routine)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"new-routine <companyId> --title T [--description D] [--project UUID] [--goal UUID] [--assignee-agent UUID] [--priority P] [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)          _add "\"title\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description)    _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --project)        _add "\"projectId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --goal)           _add "\"goalId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --assignee-agent) _add "\"assigneeAgentId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --priority)       _add "\"priority\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --status)         _add "\"status\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)           jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"title":'*) : ;; *) _fail '{"ok":false,"error":"missing_title","hint":"--title is required (or pass a full --json body)"}' 2 ;; esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/routines" "$body")"
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    back_id="$(_req GET "/api/routines/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"routineId":"%s","note":"created + confirmed retrievable"}\n' "$new_id"
    ;;
  new-label)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"new-label <companyId> --name N --color #RRGGBB [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --name)  _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --color) _add "\"color\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)  jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"name":'*) : ;; *) _fail '{"ok":false,"error":"missing_name","hint":"--name is required (or pass a full --json body)"}' 2 ;; esac
      case ",$parts," in *'"color":'*) : ;; *) _fail '{"ok":false,"error":"missing_color","hint":"--color is required, 6-digit hex like #3B82F6"}' 2 ;; esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/labels" "$body")"
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_top id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    # Labels have no single-GET; verify by re-listing and confirming the id is present.
    _req GET "/api/companies/$cid/labels" | grep -qF "\"$new_id\"" || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"labelId":"%s","note":"created + confirmed present in the company labels list"}\n' "$new_id"
    ;;
  new-environment)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"new-environment <companyId> --name N --driver D [--description D] [--status active|…] [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --name)        _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --driver)      _add "\"driver\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description) _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --status)      _add "\"status\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)        jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags (config/envVars/metadata need --json)"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"name":'*) : ;; *) _fail '{"ok":false,"error":"missing_name","hint":"--name is required (or pass a full --json body)"}' 2 ;; esac
      case ",$parts," in *'"driver":'*) : ;; *) _fail '{"ok":false,"error":"missing_driver","hint":"--driver is required (see the company environments list for valid drivers)"}' 2 ;; esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/environments" "$body")"
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    back_id="$(_req GET "/api/environments/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"environmentId":"%s","note":"created + confirmed retrievable"}\n' "$new_id"
    ;;

  # ---- Secrets & keys (SENSITIVE): credentials the company/agents use ----
  # NOTE: --value passes a plaintext credential through argv on THIS local box.
  # Fine for a loopback operator tool; still prefer provider-managed secrets where possible.
  new-secret)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"new-secret <companyId> --name N [--key K] [--value V] [--description D] [--provider P] [--managed-mode M] [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --name)         _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --key)          _add "\"key\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --value)        _add "\"value\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description)  _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --provider)     _add "\"provider\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --managed-mode) _add "\"managedMode\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --external-ref) _add "\"externalRef\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)         jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"name":'*) : ;; *) _fail '{"ok":false,"error":"missing_name","hint":"--name is required (or pass a full --json body)"}' 2 ;; esac
      # Mirror the server's zod superRefine (secret.ts): external_reference secrets
      # need externalRef (value, if given, is ignored server-side — so we do NOT reject it);
      # managed secrets need value and must NOT set externalRef.
      # Validate client-side so the agent gets a structured error, not a raw 400.
      case ",$parts," in *'"managedMode":"external_reference"'*)
        # external_reference only REQUIRES externalRef; the server (secret.ts superRefine)
        # returns early and simply IGNORES any value — so we must NOT reject --value here,
        # or we'd be stricter than the real contract.
        case ",$parts," in *'"externalRef":'*) : ;; *) _fail '{"ok":false,"error":"missing_external_ref","hint":"--managed-mode external_reference requires --external-ref REF"}' 2 ;; esac
        ;;
      *)
        case ",$parts," in *'"value":'*) : ;; *) _fail '{"ok":false,"error":"missing_value","hint":"a managed secret requires --value V (or --managed-mode external_reference + --external-ref)"}' 2 ;; esac
        case ",$parts," in *'"externalRef":'*) _fail '{"ok":false,"error":"managed_with_external_ref","hint":"managed secrets must NOT carry --external-ref; use --managed-mode external_reference"}' 2 ;; esac
        ;;
      esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/secrets" "$body")"
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id (value not echoed for secrets)"}' 1
    _safe_seg "$new_id"
    _req GET "/api/companies/$cid/secrets" | grep -qF "\"$new_id\"" || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"secretId":"%s","note":"created + confirmed present in the company secrets list (value intentionally not echoed)"}\n' "$new_id"
    ;;
  secret-rotate)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"secret-rotate <secretId> [--value V] [--external-ref R] [--json {...}]"}'; _safe_seg "$id"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --value)        _add "\"value\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --external-ref) _add "\"externalRef\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)         jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      body="{$parts}"
    fi
    # Rotate returns the updated secret (which may carry the new value/version) — never print
    # the raw response, or it leaks secret material into the chat transcript. There is no single
    # GET /secrets/:id and rotate has no companyId to re-list, so we can't fully re-read — but we
    # CAN cheaply confirm from the (unprinted) response that it was the secret we targeted.
    rotated="$(_req POST "/api/secrets/$id/rotate" "$body")"
    got_id="$(printf '%s' "$rotated" | _json_top id)"
    [ -z "$got_id" ] || [ "$got_id" = "$id" ] || _fail "{\"ok\":false,\"error\":\"rotate_id_mismatch\",\"wanted\":\"$id\",\"got\":\"$got_id\"}" 1
    printf '{"ok":true,"rotated":"%s","note":"rotated; the new secret value/version is intentionally NOT printed (it would leak into the chat transcript)"}\n' "$id"
    ;;
  delete-secret)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"delete-secret <secretId> --yes"}'; _safe_seg "$id"; shift || true
    [ "${1:-}" = "--yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"delete-secret\",\"id\":\"$id\",\"detail\":\"Deleting a secret can break agents that depend on it. Re-run with --yes after the user confirms.\"}" 4
    shift; _no_extra "$@"
    _req DELETE "/api/secrets/$id" | _emit
    ;;
  new-provider-config)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"new-provider-config <companyId> --provider P --display-name N [--default] [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --provider)     _add "\"provider\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --display-name) _add "\"displayName\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --default)      _add '"isDefault":true'; shift ;;
        --json)         jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags (config object needs --json)"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"provider":'*) : ;; *) _fail '{"ok":false,"error":"missing_provider","hint":"--provider is required"}' 2 ;; esac
      case ",$parts," in *'"displayName":'*) : ;; *) _fail '{"ok":false,"error":"missing_display_name","hint":"--display-name is required"}' 2 ;; esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/secret-provider-configs" "$body")"
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    back_id="$(_req GET "/api/secret-provider-configs/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"providerConfigId":"%s","note":"created + confirmed retrievable"}\n' "$new_id"
    ;;
  delete-provider-config)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"delete-provider-config <configId> --yes"}'; _safe_seg "$id"; shift || true
    [ "${1:-}" = "--yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"delete-provider-config\",\"id\":\"$id\",\"detail\":\"Deleting a provider config can break secrets that reference it. Re-run with --yes after the user confirms.\"}" 4
    shift; _no_extra "$@"
    _req DELETE "/api/secret-provider-configs/$id" >/dev/null
    code="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/secret-provider-configs/$id")"
    [ "$code" = "404" ] || _fail "{\"ok\":false,\"error\":\"delete_unconfirmed\",\"http\":\"$code\"}" 1
    printf '{"ok":true,"verified":true,"deleted":"%s"}\n' "$id"
    ;;
  agent-keys)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"agent-keys <agentId>"}'; _safe_seg "$id"; shift || true; _no_extra "$@"
    _req GET "/api/agents/$id/keys" | _emit
    ;;
  new-agent-key)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"new-agent-key <agentId> [--name N] [--json {...}]"}'; _safe_seg "$id"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json) jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      body="{$parts}"
    fi
    # The create-key response carries the ONE-TIME plaintext token — never print the raw
    # response, or it leaks the credential into the chat transcript. Parse it internally.
    created="$(_req POST "/api/agents/$id/keys" "$body")"
    new_id="$(printf '%s' "$created" | _json_top id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    # Keys have no single-GET; verify by re-listing and confirming the new id is present.
    _req GET "/api/agents/$id/keys" | grep -qF "\"$new_id\"" || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"keyId":"%s","note":"created + confirmed in the agent key list. The one-time API token is intentionally NOT printed (it would leak into the chat transcript); retrieve it from the board UI if you need the raw token."}\n' "$new_id"
    ;;
  delete-agent-key)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"delete-agent-key <agentId> <keyId> --yes"}'; _safe_seg "$id"; shift || true
    kid="${1:-}"; _need "$kid" '{"ok":false,"error":"missing_key_id","hint":"delete-agent-key <agentId> <keyId> --yes"}'; _safe_seg "$kid"; shift || true
    [ "${1:-}" = "--yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"delete-agent-key\",\"agentId\":\"$id\",\"keyId\":\"$kid\",\"detail\":\"Revoking a key immediately breaks anything using it. Re-run with --yes after the user confirms.\"}" 4
    shift; _no_extra "$@"
    _req DELETE "/api/agents/$id/keys/$kid" >/dev/null
    # Verify the key is gone by re-listing (we know the agentId, so this is re-readable).
    if _req GET "/api/agents/$id/keys" | grep -qF "\"$kid\""; then _fail "{\"ok\":false,\"error\":\"delete_unconfirmed\",\"keyId\":\"$kid\"}" 1; fi
    printf '{"ok":true,"verified":true,"deleted":"%s"}\n' "$kid"
    ;;

  # ---- Governance & finance: budgets, approval gates, pipelines ----
  set-budget)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"set-budget <companyId> --monthly-cents N"}'; _safe_seg "$cid"; shift || true
    cents=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --monthly-cents) cents="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$cents" '{"ok":false,"error":"missing_monthly_cents","hint":"--monthly-cents N (integer cents, 0 = unlimited)"}'; _int "$cents"
    _req PATCH "/api/companies/$cid/budgets" "{\"budgetMonthlyCents\":$cents}" >/dev/null
    fresh="$(_req GET "/api/companies/$cid")"; printf '%s' "$fresh" | _emit
    got="$(printf '%s' "$fresh" | _json_num budgetMonthlyCents)"
    [ "$got" = "$cents" ] || _fail "{\"ok\":false,\"error\":\"budget_unconfirmed\",\"wanted\":$cents,\"got\":\"$got\"}" 1
    printf '{"ok":true,"verified":true,"companyId":"%s","budgetMonthlyCents":%s}\n' "$cid" "$cents"
    ;;
  set-agent-budget)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"set-agent-budget <agentId> --monthly-cents N"}'; _safe_seg "$id"; shift || true
    cents=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --monthly-cents) cents="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$cents" '{"ok":false,"error":"missing_monthly_cents","hint":"--monthly-cents N (integer cents, 0 = unlimited)"}'; _int "$cents"
    _req PATCH "/api/agents/$id/budgets" "{\"budgetMonthlyCents\":$cents}" >/dev/null
    fresh="$(_req GET "/api/agents/$id")"; printf '%s' "$fresh" | _emit
    got="$(printf '%s' "$fresh" | _json_top budgetMonthlyCents)"
    [ "$got" = "$cents" ] || _fail "{\"ok\":false,\"error\":\"budget_unconfirmed\",\"wanted\":$cents,\"got\":\"$got\"}" 1
    printf '{"ok":true,"verified":true,"agentId":"%s","budgetMonthlyCents":%s}\n' "$id" "$cents"
    ;;
  approve-request|reject-request)
    id="${1:-}"; _need "$id" "{\"ok\":false,\"error\":\"missing_id\",\"hint\":\"$cmd <approvalId> [--note TEXT]\"}"; _safe_seg "$id"; shift || true
    body="{}"
    while [ $# -gt 0 ]; do
      case "$1" in
        --note) body="{\"decisionNote\":$(printf '%s' "${2:-}" | _jstr)}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    verb="approve"; want="approved"
    [ "$cmd" = "reject-request" ] && { verb="reject"; want="rejected"; }
    # A successful approve/reject is a SINGLE, immediate decision: the service
    # (services/approvals.ts resolveApproval) sets status directly to approved/rejected,
    # and any non-resolvable case throws (so the POST above already errored out). So we can
    # hard-assert the persisted status — there is no legitimate "still pending" outcome.
    _req POST "/api/approvals/$id/$verb" "$body" >/dev/null
    fresh="$(_req GET "/api/approvals/$id")"; printf '%s' "$fresh" | _emit
    got="$(printf '%s' "$fresh" | _json_top status)"
    [ "$got" = "$want" ] || _fail "{\"ok\":false,\"error\":\"approval_unconfirmed\",\"wanted\":\"$want\",\"got\":\"$got\"}" 1
    printf '{"ok":true,"verified":true,"approvalId":"%s","status":"%s"}\n' "$id" "$got"
    ;;
  approval-comment)
    id="${1:-}"; _need "$id" '{"ok":false,"error":"missing_id","hint":"approval-comment <approvalId> --body TEXT"}'; _safe_seg "$id"; shift || true
    cbody=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --body) cbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$cbody" '{"ok":false,"error":"missing_body","hint":"approval-comment <approvalId> --body TEXT"}'
    created="$(_req POST "/api/approvals/$id/comments" "{\"body\":$(printf '%s' "$cbody" | _jstr)}")"
    printf '%s' "$created" | _emit
    cmt_id="$(printf '%s' "$created" | _json_top id)"
    [ -n "$cmt_id" ] || _fail '{"ok":false,"error":"comment_no_id","detail":"response had no id"}' 1
    _safe_seg "$cmt_id"
    _req GET "/api/approvals/$id/comments" | grep -qF "\"$cmt_id\"" || _fail "{\"ok\":false,\"error\":\"comment_unconfirmed\",\"id\":\"$cmt_id\"}" 1
    printf '{"ok":true,"verified":true,"commentId":"%s","note":"posted + confirmed in the approval thread"}\n' "$cmt_id"
    ;;
  new-pipeline)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_id","hint":"new-pipeline <companyId> --key K --name N [--description D] [--project UUID] [--json {...}]"}'; _safe_seg "$cid"; shift || true
    parts=""; jbody=""
    _add() { parts="${parts:+$parts,}$1"; }
    while [ $# -gt 0 ]; do
      case "$1" in
        --key)         _add "\"key\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --name)        _add "\"name\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --description) _add "\"description\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --project)     _add "\"projectId\":$(printf '%s' "${2:-}" | _jstr)"; shift 2 ;;
        --json)        jbody="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$jbody" ]; then
      [ -z "$parts" ] || _fail '{"ok":false,"error":"mixed_body","hint":"use EITHER --json OR the convenience --flags (stages need --json)"}' 2
      _lint_json_object "$jbody"; body="$jbody"
    else
      case ",$parts," in *'"key":'*) : ;; *) _fail '{"ok":false,"error":"missing_key","hint":"--key is required (a short stable slug)"}' 2 ;; esac
      case ",$parts," in *'"name":'*) : ;; *) _fail '{"ok":false,"error":"missing_name","hint":"--name is required"}' 2 ;; esac
      body="{$parts}"
    fi
    created="$(_req POST "/api/companies/$cid/pipelines" "$body")"
    printf '%s' "$created" | _emit
    new_id="$(printf '%s' "$created" | _json_str id)"
    [ -n "$new_id" ] || _fail '{"ok":false,"error":"create_no_id","detail":"response had no id"}' 1
    _safe_seg "$new_id"
    back_id="$(_req GET "/api/pipelines/$new_id" | _json_str id)"
    [ "$back_id" = "$new_id" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$new_id\"}" 1
    printf '{"ok":true,"verified":true,"pipelineId":"%s","note":"created + confirmed retrievable"}\n' "$new_id"
    ;;

  ""|-h|--help|help) awk 'NR>=2{ if (/^set -euo pipefail/) exit; print }' "$0" ;;
  *) _fail "{\"ok\":false,\"error\":\"unknown_command\",\"command\":\"$cmd\"}" 2 ;;
esac

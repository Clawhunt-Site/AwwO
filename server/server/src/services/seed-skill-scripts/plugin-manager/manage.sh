#!/usr/bin/env bash
#
# plugin-manager — scaffold a REAL, installable, UNSIGNED local plugin and manage plugin
# lifecycle (via the native /api/plugins REST API). No external CLI is used.
#
# Authoring your OWN local plugin needs NO signature — exactly like creating a skill or a
# company. `scaffold` writes three plain-JS files (package.json + manifest.js + worker.js)
# with no build step, no SDK and no npm install; `install <dir> --local --yes` loads them
# as-is. Signing + extra developer metadata are minted ONLY when you UPLOAD the plugin to
# the capability workshop to share it with others — never to create/use it locally.
#
# Scaffold (writes a directly-installable local plugin):
#   manage.sh scaffold <plugin-id> [--dir DIR] [--tool-name NAME] [--summary TEXT]
#     then: manage.sh install <dir>/<plugin-id> --local --yes
#     <plugin-id> here MUST be dotted reverse-DNS (e.g. acme.weather). The lifecycle verbs
#     below instead take an INSTALLED plugin's id — its manifest id, DB UUID, or plugin key
#     (whatever `list`/`inspect` shows) — not necessarily dotted.
# Lifecycle + diagnostics (REST; install/remove are privileged + destructive → need --yes):
#   manage.sh list        [--status installed|ready|disabled|error|upgrade_pending|uninstalled]
#   manage.sh examples                                   # browse installable packages
#   manage.sh inspect     <plugin-id>
#   manage.sh health      <plugin-id>                    # liveness / load state
#   manage.sh logs        <plugin-id> [--limit N] [--level L] [--since ISO]
#   manage.sh install     <path-or-name> [--local] [--version V] --yes
#   manage.sh enable      <plugin-id>
#   manage.sh disable     <plugin-id> [--reason TEXT]
#   manage.sh upgrade     <plugin-id> [--version V]
#   manage.sh config-get  <plugin-id>
#   manage.sh config-test <plugin-id> --json '{...}'     # DRY-RUN a config (no persist)
#   manage.sh config-set  <plugin-id> --json '{...}'
#   manage.sh remove      <plugin-id> --yes [--purge]
set -euo pipefail

_fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
_need() { [ -n "${1:-}" ] || _fail "$2" 2; }
# Plugin ids allow dots; reject slashes/.. /control/space so an id can't traverse
# the /api/plugins/<id> path (curl normalizes `../`).
_safe_seg() {
  case "$1" in
    ""|*/*|*..*|*[!A-Za-z0-9._-]*) _fail "{\"ok\":false,\"error\":\"unsafe_plugin_id\",\"value\":\"$1\"}" 2 ;;
  esac
}
# Reverse-DNS dotted id, lowercase — mirrors the manifest schema `id` pattern
# (^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$). Must have at least one dot.
_valid_plugin_id() {
  printf '%s' "$1" | grep -qE '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$'
}
# Tool name pattern from the schema (^[a-z][a-z0-9_]*$).
_valid_tool_name() {
  printf '%s' "$1" | grep -qE '^[a-z][a-z0-9_]*$'
}
_jstr() {
  local s; s="$(cat)"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"; s="${s//$'\r'/\\r}"; s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}
# Best-effort local check that $1 is a JSON OBJECT before sending it on (the server is the
# authority and rejects a non-object configJson with 400 — this only fails earlier/clearer).
# Uses node (this skill targets the Node runtime, no Python in the path); skipped when node
# is absent so it never false-fails on a node-less runtime.
_lint_json_object() {
  command -v node >/dev/null 2>&1 || return 0
  printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(3)}if(v===null||typeof v!=="object"||Array.isArray(v))process.exit(4)})' 2>/dev/null \
    || _fail '{"ok":false,"error":"config_json_invalid","hint":"--json must be a valid JSON object"}' 2
}
# Percent-encode a value for a URL query — correct for `:` / `+` / multibyte (an ISO
# timestamp has `:` which a path-safety check would wrongly reject, and `+` would decode to
# a space if sent raw). node primary; LC_ALL=C byte fallback masked to 0..255.
_urlenc() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
    return
  fi
  local LC_ALL=C s c i out=""
  s="$1"
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "$(( $(printf '%d' "'$c") & 0xFF ))")" ;;
    esac
  done
  printf '%s' "$out"
}

_resolve_api() {
  # Prefer a LOOPBACK base (this skill runs on the server's host); fall back to primary.
  local primary="${SUPERCLAW_RUNTIME_API_URL:-}"
  local cands="${SUPERCLAW_RUNTIME_API_CANDIDATES_JSON:-}"
  local urls loop base
  urls="$(printf '%s\n%s\n' "$primary" "$(printf '%s' "$cands" | grep -oE 'https?://[^"]+' 2>/dev/null || true)")"
  # The local runtime API is plain HTTP on loopback — prefer an http loopback first.
  loop="$(printf '%s\n' "$urls" | grep -iE '^http://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)' | head -1 || true)"
  [ -n "$loop" ] || loop="$(printf '%s\n' "$urls" | grep -iE '^https?://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)' | head -1 || true)"
  base="${loop:-$primary}"
  [ -n "$base" ] || base="$(printf '%s' "$cands" | grep -oE 'https?://[^"]+' | head -1 || true)"
  [ -n "$base" ] || _fail '{"ok":false,"error":"api_base_unset","hint":"plugin lifecycle needs SUPERCLAW_RUNTIME_API_URL"}' 3
  printf '%s' "${base%/}"
}

cmd="${1:-}"; shift || true

case "$cmd" in
  scaffold)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id","hint":"scaffold <plugin-id> (dotted, e.g. acme.weather)"}'; shift || true
    _safe_seg "$pid"
    _valid_plugin_id "$pid" || _fail "{\"ok\":false,\"error\":\"invalid_plugin_id\",\"value\":\"$pid\",\"hint\":\"lowercase reverse-DNS with a dot, e.g. acme.weather\"}" 2
    dir="."; tool=""; summary=""
    while [ $# -gt 0 ]; do
      case "$1" in
        # Each value flag needs an argument; a trailing flag with none is a
        # structured error (not a raw bash `shift count out of range`).
        --dir) [ $# -ge 2 ] || _fail '{"ok":false,"error":"missing_flag_value","flag":"--dir"}' 2; dir="$2"; shift 2 ;;
        --tool-name) [ $# -ge 2 ] || _fail '{"ok":false,"error":"missing_flag_value","flag":"--tool-name"}' 2; tool="$2"; shift 2 ;;
        --summary) [ $# -ge 2 ] || _fail '{"ok":false,"error":"missing_flag_value","flag":"--summary"}' 2; summary="$2"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    # Default tool name = last dotted segment, normalised to the tool pattern.
    [ -n "$tool" ] || tool="$(printf '%s' "${pid##*.}" | tr -c 'a-z0-9_' '_')"
    _valid_tool_name "$tool" || _fail "{\"ok\":false,\"error\":\"invalid_tool_name\",\"value\":\"$tool\",\"hint\":\"^[a-z][a-z0-9_]*$\"}" 2
    [ -n "$summary" ] || summary="Local plugin '$pid' — describe what it does."
    [ -n "$dir" ] || _fail '{"ok":false,"error":"empty_dir"}' 2
    root="$dir/$pid"
    [ -e "$root" ] && _fail "{\"ok\":false,\"error\":\"target_exists\",\"path\":\"$root\",\"hint\":\"pick a fresh --dir or plugin-id; refusing to overwrite\"}" 2
    mkdir -p "$root"
    # A REAL, installable, UNSIGNED local plugin (native apiVersion:1 model). Authoring or
    # installing your OWN local plugin needs NO signature — signing is only minted when you
    # UPLOAD to the capability workshop. The three plain-JS files below need no build, no
    # SDK and no npm install; `manage.sh install <dir> --local --yes` loads them as-is.
    # The loader finds manifest.js by root-level convention (no plugin-host field needed),
    # and the worker via the manifest's own entrypoints.worker — so package.json stays a
    # plain, brand-free npm manifest.
    cat > "$root/package.json" <<JSON
{
  "name": $(printf '%s' "$pid" | _jstr),
  "version": "0.1.0",
  "private": true
}
JSON
    # Manifest — plain JS (CommonJS). Edit freely; no signature, no build step.
    cat > "$root/manifest.js" <<JS
// Plugin manifest for $pid — plain JS, no build. Edit freely.
module.exports = {
  id: $(printf '%s' "$pid" | _jstr),
  apiVersion: 1,
  version: "0.1.0",
  displayName: $(printf '%s' "$pid" | _jstr),
  description: $(printf '%s' "$summary" | _jstr),
  author: "local",
  categories: ["automation"],
  capabilities: ["agent.tools.register"],
  entrypoints: { worker: "./worker.js" },
  tools: [
    {
      name: $(printf '%s' "$tool" | _jstr),
      displayName: $(printf '%s' "$tool" | _jstr),
      description: "Describe what this tool does for the agent.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false }
    }
  ]
};
JS
    # Worker — plain Node (CommonJS), no SDK. Speaks the plugin worker JSON-RPC 2.0
    # protocol over stdio (one JSON message per line). stdout is the protocol channel —
    # log only to stderr. This starter echoes the tool input; replace with real logic.
    cat > "$root/worker.js" <<'JS'
#!/usr/bin/env node
"use strict";
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || msg.id === undefined || msg.id === null) return; // ignore notifications
  const { id, method, params } = msg;
  try {
    switch (method) {
      case "initialize": return ok(id, { ok: true });
      case "health": return ok(id, { status: "ok" });
      case "shutdown":
        // Flush the ack BEFORE exiting — process.exit() drops buffered stdout writes.
        return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: null }) + "\n", () => process.exit(0));
      case "executeTool": {
        const args = (params && params.parameters) || {};
        // --- Your tool logic goes here. This starter just echoes the input. ---
        return ok(id, { content: "Tool '" + (params && params.toolName) + "' ran. Input: " + JSON.stringify(args) });
      }
      default: return fail(id, -32601, "Method not found: " + method);
    }
  } catch (err) {
    return fail(id, -32000, String((err && err.message) || err));
  }
});
JS
    # worker.js already carries a shebang; make it executable too so a developer can run
    # it directly while iterating (the host loads it via `fork`, which needs no exec bit).
    chmod 0755 "$root/worker.js" 2>/dev/null || true
    # Absolute path to THIS script, so the install command we print is runnable as-is
    # (the skill invokes the bundled script by absolute path — it is not on $PATH).
    self="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/$(basename "${BASH_SOURCE[0]}")"
    # Per-arg shell-escape (printf %q) so the printed command is copy/paste- AND eval-safe
    # even if a path contains spaces, quotes, `$()`, backticks or backslashes — plain
    # double-quoting would still let $()/backticks execute under eval.
    self_q="$(printf '%q' "$self")"
    root_q="$(printf '%q' "$root")"
    install_cmd="$self_q install $root_q --local --yes"
    cat > "$root/README.md" <<MD
# $pid

A real, installable, UNSIGNED local plugin — created natively, no signature needed
(just like creating a skill or a company).

Install it (no signing, no build):

    $install_cmd

Then list it with: $self_q list — the agent can then call its "$tool" tool.

Files:
- manifest.js  — what the plugin is + the tools it exposes (edit freely)
- worker.js    — the code that runs on a tool call (replace the echo with your logic)
- package.json — points the loader at the two files above

Signing is only needed when you UPLOAD this to the capability workshop to share it with
others. Creating and using it locally for yourself never touches signing.
MD
    hint="$install_cmd"
    printf '{"ok":true,"installable":true,"id":%s,"dir":%s,"tool":%s,"files":["package.json","manifest.js","worker.js","README.md"],"install_hint":%s,"note":"Real unsigned local plugin — install it directly; signing is only for workshop upload."}\n' \
      "$(printf '%s' "$pid" | _jstr)" "$(printf '%s' "$root" | _jstr)" "$(printf '%s' "$tool" | _jstr)" "$(printf '%s' "$hint" | _jstr)"
    ;;
  list)
    status=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --status) status="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$status" ]; then
      _safe_seg "$status"
      curl -fsS "$(_resolve_api)/api/plugins?status=$status"
    else
      curl -fsS "$(_resolve_api)/api/plugins"
    fi
    ;;
  inspect)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id"}'; _safe_seg "$pid"
    curl -fsS "$(_resolve_api)/api/plugins/$pid"
    ;;
  examples)
    # Browse installable plugin packages (npm names + bundled examples) — the source set
    # for `install`. Read-only; no id needed.
    curl -fsS "$(_resolve_api)/api/plugins/examples"
    ;;
  health)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id","hint":"health <id>"}'; _safe_seg "$pid"
    curl -fsS "$(_resolve_api)/api/plugins/$pid/health"
    ;;
  logs)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id","hint":"logs <id> [--limit N] [--level L] [--since ISO]"}'; _safe_seg "$pid"; shift || true
    qs=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --limit) case "${2:-}" in ''|*[!0-9]*) _fail '{"ok":false,"error":"bad_limit","hint":"--limit is an integer 1-500"}' 2 ;; esac; qs="${qs}&limit=${2}"; shift 2 ;;
        # --level / --since are query values (an ISO --since has `:`/`+`), so URL-ENCODE
        # them — do NOT path-sanitize (that would reject a valid timestamp's `:`).
        --level) _need "${2:-}" '{"ok":false,"error":"missing_level"}'; qs="${qs}&level=$(_urlenc "${2}")"; shift 2 ;;
        --since) _need "${2:-}" '{"ok":false,"error":"missing_since"}'; qs="${qs}&since=$(_urlenc "${2}")"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    curl -fsS "$(_resolve_api)/api/plugins/$pid/logs?${qs#&}"
    ;;
  install)
    pkg="${1:-}"; _need "$pkg" '{"ok":false,"error":"missing_package","hint":"install <path-or-name> --yes"}'; shift || true
    local_path="false"; version=""; yes="no"
    while [ $# -gt 0 ]; do
      case "$1" in
        --local) local_path="true"; shift ;;
        --version) version="${2:-}"; shift 2 ;;
        --yes) yes="yes"; shift ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    [ "$yes" = "yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"install\",\"package\":\"$pkg\",\"detail\":\"Installing loads/pulls code. Re-run with --yes only after the user confirms.\"}" 4
    body="{\"packageName\":$(printf '%s' "$pkg" | _jstr),\"isLocalPath\":$local_path"
    [ -n "$version" ] && body="$body,\"version\":$(printf '%s' "$version" | _jstr)"
    body="$body}"
    curl -fsS -X POST "$(_resolve_api)/api/plugins/install" -H 'Content-Type: application/json' -d "$body"
    ;;
  enable)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id"}'; _safe_seg "$pid"
    curl -fsS -X POST "$(_resolve_api)/api/plugins/$pid/enable"
    ;;
  disable)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id"}'; _safe_seg "$pid"; shift || true
    reason=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --reason) reason="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$reason" ]; then
      curl -fsS -X POST "$(_resolve_api)/api/plugins/$pid/disable" -H 'Content-Type: application/json' -d "{\"reason\":$(printf '%s' "$reason" | _jstr)}"
    else
      curl -fsS -X POST "$(_resolve_api)/api/plugins/$pid/disable"
    fi
    ;;
  upgrade)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id"}'; _safe_seg "$pid"; shift || true
    version=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --version) version="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$version" ]; then
      curl -fsS -X POST "$(_resolve_api)/api/plugins/$pid/upgrade" -H 'Content-Type: application/json' -d "{\"version\":$(printf '%s' "$version" | _jstr)}"
    else
      curl -fsS -X POST "$(_resolve_api)/api/plugins/$pid/upgrade"
    fi
    ;;
  config-test)
    # DRY-RUN a config WITHOUT persisting (POST /config/test) — the safe way to check a
    # config before `config-set`. Same `--json` object contract as config-set.
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id","hint":"config-test <id> --json {...}"}'; _safe_seg "$pid"; shift || true
    json=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$json" '{"ok":false,"error":"missing_json","hint":"config-test <id> --json {...}"}'
    _lint_json_object "$json"
    curl -fsS -X POST "$(_resolve_api)/api/plugins/$pid/config/test" -H 'Content-Type: application/json' -d "{\"configJson\":$json}"
    ;;
  config-get)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id"}'; _safe_seg "$pid"
    curl -fsS "$(_resolve_api)/api/plugins/$pid/config"
    ;;
  config-set)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id"}'; _safe_seg "$pid"; shift || true
    json=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$json" '{"ok":false,"error":"missing_json","hint":"config-set <id> --json {...}"}'
    _lint_json_object "$json"
    curl -fsS -X POST "$(_resolve_api)/api/plugins/$pid/config" -H 'Content-Type: application/json' -d "{\"configJson\":$json}"
    ;;
  remove)
    pid="${1:-}"; _need "$pid" '{"ok":false,"error":"missing_plugin_id","hint":"remove <id> --yes [--purge]"}'; _safe_seg "$pid"; shift || true
    yes="no"; purge="false"
    while [ $# -gt 0 ]; do
      case "$1" in
        --yes) yes="yes"; shift ;;
        --purge) purge="true"; shift ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    [ "$yes" = "yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"remove\",\"id\":\"$pid\",\"detail\":\"Uninstalls the plugin (--purge also deletes its stored data). Re-run with --yes after the user confirms.\"}" 4
    if [ "$purge" = "true" ]; then
      curl -fsS -X DELETE "$(_resolve_api)/api/plugins/$pid?purge=true"
    else
      curl -fsS -X DELETE "$(_resolve_api)/api/plugins/$pid"
    fi
    printf '\n{"ok":true,"removed":"%s","purged":%s}\n' "$pid" "$purge"
    ;;
  ""|-h|--help|help) sed -n '2,29p' "$0" ;;
  *) _fail "{\"ok\":false,\"error\":\"unknown_command\",\"command\":\"$cmd\"}" 2 ;;
esac

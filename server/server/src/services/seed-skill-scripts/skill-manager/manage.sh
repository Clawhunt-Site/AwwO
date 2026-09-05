#!/usr/bin/env bash
#
# skill-manager — create / edit / optimize / validate SuperClaw skills compliantly.
#
# Global-store skills (filesystem, injected into every chat):
#   manage.sh create-global   <slug> --description D [--title T]
#   manage.sh edit-global     <slug> --description D   # ONLY the frontmatter description.
#       To change the SKILL.md BODY (the instructions/logic), EDIT the file directly with
#       your normal file tools at <store>/<slug>/SKILL.md, then run `optimize-global <slug>`
#       to re-seal provenance + validate. `edit-global` does NOT touch the body.
#   manage.sh optimize-global <slug>   # re-seal provenance (source_digest:null) + validate
#       after ANY hand-edit of the folder. Run this whenever you edit SKILL.md or add files.
#   manage.sh list-global
#   manage.sh validate        <skill-dir>
# Company skills (DB, via REST):
#   manage.sh list-company     <companyId> [--q TEXT]          # list this company's skills
#   manage.sh inspect-company  <companyId> <skillId>           # one company skill
#   manage.sh versions-company    <companyId> <skillId>        # its version history
#   manage.sh new-version-company <companyId> <skillId> [--label T]   # snapshot a new version
#   manage.sh create-company      <companyId> --name N [--slug S] [--description D] [--markdown FILE]
#   manage.sh delete-company   <companyId> <skillId> --yes
#
# Compliance baked in: frontmatter `name` is locked to the folder slug; provenance is
# ALWAYS written with source_digest:null (the runtime recomputes the trust digest — a
# stale/wrong one drops the skill as tampered); validation (incl. symlink rejection)
# runs BEFORE any write so a symlinked folder is refused, not written-through.
set -euo pipefail

_fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
_need() { [ -n "${1:-}" ] || _fail "$2" 2; }
_safe_seg() {
  case "$1" in
    ""|*/*|*..*|*[!A-Za-z0-9._-]*) _fail "{\"ok\":false,\"error\":\"unsafe_id\",\"value\":\"$1\"}" 2 ;;
  esac
}
_slug_ok() { printf '%s' "$1" | grep -qE '^[a-z0-9][a-z0-9-]*$' || _fail "{\"ok\":false,\"error\":\"bad_slug\",\"detail\":\"kebab-case [a-z0-9-]\",\"slug\":\"$1\"}" 2; }
# Frontmatter description must be a single line — strip any CR/LF (and tabs) so it
# can never break the YAML block or smuggle extra keys.
_one_line() { printf '%s' "$1" | tr '\r\n\t' '   '; }

_jstr() {
  local s; s="$(cat)"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"; s="${s//$'\r'/\\r}"; s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}
# Robustly read a TOP-LEVEL JSON string field via node (the skill targets the Node
# runtime). Avoids the `sed | head -1` trap of grabbing a NESTED id (e.g. a version id)
# that happens to appear before the object's own field. Prints empty when the field is
# absent OR node is unavailable (callers must treat empty as "could not extract", not "").
_json_field() {  # $1=field name  $2=json text
  command -v node >/dev/null 2>&1 || return 0
  printf '%s' "$2" | node -e 'let s="";const f=process.argv[1];process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);if(v&&typeof v==="object"&&typeof v[f]==="string")process.stdout.write(v[f])}catch{}})' "$1"
}
# Percent-encode a value for a URL query. Uses node's encodeURIComponent (the skill targets
# the Node runtime) — correct for multibyte UTF-8 (e.g. a Chinese search term). The bash
# fallback masks each byte to 0..255 (`& 0xFF`) so a high byte can't sign-extend to a bogus
# %FFFFFFE4; it runs under LC_ALL=C so the loop walks BYTES, not characters.
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
  [ -n "$base" ] || _fail '{"ok":false,"error":"api_base_unset","hint":"company-skill REST needs SUPERCLAW_RUNTIME_API_URL"}' 3
  printf '%s' "${base%/}"
}

STORE="${SUPERCLAW_SKILL_STORE_DIR:-$HOME/.superclaw/skills}"

# Write provenance via temp+rename so a pre-existing `.provenance.json` SYMLINK is
# REPLACED (rename never follows it), not written-through to its target. Refuse a
# symlink up front too, for a clear error.
_write_provenance() {
  local dir="$1" tmp
  [ -L "$dir/.provenance.json" ] && _fail "{\"ok\":false,\"error\":\"symlink_file\",\"file\":\".provenance.json\"}" 1
  tmp="$(mktemp "$dir/.prov.XXXXXX")"
  printf '{\n  "schema_version": "0.1.0",\n  "source_url": null,\n  "source_digest": null\n}\n' > "$tmp"
  mv -f "$tmp" "$dir/.provenance.json"
}

# Validate a skill folder the way the runtime's §9 union does. Refuses symlinks
# ANYWHERE (incl. the folder itself), enforces name==slug + a description. Call this
# BEFORE writing into an existing folder so a symlinked dir is rejected up front.
_validate_dir() {
  local dir="$1" slug
  [ -L "$dir" ] && _fail "{\"ok\":false,\"error\":\"symlink_dir\",\"dir\":\"$dir\"}" 1
  [ -d "$dir" ] || _fail "{\"ok\":false,\"error\":\"not_a_dir\",\"dir\":\"$dir\"}" 1
  slug="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || _fail '{"ok":false,"error":"missing_skill_md"}' 1
  [ -f "$dir/.provenance.json" ] || _fail '{"ok":false,"error":"missing_provenance"}' 1
  [ -n "$(find "$dir" -type l 2>/dev/null | head -1)" ] && _fail '{"ok":false,"error":"symlink_present","detail":"a skill folder must contain only regular files"}' 1
  # Provenance MUST declare a null digest. A non-empty store_digest/source_digest is
  # treated by the runtime as a tamper claim that won't match the recompute, so the
  # skill gets DROPPED — "valid" must reflect that, not just file presence.
  grep -qE '"(store_digest|source_digest)"[[:space:]]*:[[:space:]]*"[^"]' "$dir/.provenance.json" \
    && _fail '{"ok":false,"error":"non_null_digest","detail":"provenance must keep source_digest:null; a declared digest makes the runtime drop the skill"}' 1
  local first; first="$(head -1 "$dir/SKILL.md")"
  [ "$first" = "---" ] || _fail '{"ok":false,"error":"frontmatter_missing","detail":"SKILL.md must start with ---"}' 1
  local nm; nm="$(sed -n '1,/^---[[:space:]]*$/p' "$dir/SKILL.md" | sed -n 's/^name:[[:space:]]*//p' | head -1)"
  [ "$nm" = "$slug" ] || _fail "{\"ok\":false,\"error\":\"name_mismatch\",\"expected\":\"$slug\",\"got\":\"$nm\"}" 1
  local ds; ds="$(sed -n '1,/^---[[:space:]]*$/p' "$dir/SKILL.md" | sed -n 's/^description:[[:space:]]*//p' | head -1)"
  [ -n "$ds" ] || _fail '{"ok":false,"error":"description_missing"}' 1
}

# Assert an existing skill folder is safe to write into BEFORE any write: the dir
# itself, AND every entry inside it (provenance / SKILL.md / anything), must be a real
# (non-symlink) path. This runs UP FRONT so edit/optimize never modify a file before
# discovering a symlink — fail-closed-before-write, not write-then-validate.
_assert_writable_dir() {
  local dir="$1"
  if [ -L "$dir" ]; then _fail "{\"ok\":false,\"error\":\"symlink_dir\",\"dir\":\"$dir\",\"detail\":\"refusing to write through a symlinked skill folder\"}" 1; fi
  [ -d "$dir" ] || _fail "{\"ok\":false,\"error\":\"not_found\",\"dir\":\"$dir\"}" 1
  # NOTE: a bare `[ -n "$(find … -type l)" ] && _fail` as the LAST command would make
  # this function RETURN 1 on the safe (no-symlink) path — `[ -n "" ]` is false — and
  # under `set -e` that silently kills the caller before it can write. Use an explicit
  # if-block and a `return 0` so the safe path exits clean.
  if [ -n "$(find "$dir" -type l 2>/dev/null | head -1)" ]; then
    _fail "{\"ok\":false,\"error\":\"symlink_present\",\"detail\":\"skill folder contains a symlink — refusing to write\"}" 1
  fi
  return 0
}

cmd="${1:-}"; shift || true

case "$cmd" in
  create-global)
    slug="${1:-}"; _need "$slug" '{"ok":false,"error":"missing_slug","hint":"create-global <slug> --description D"}'; shift || true
    _slug_ok "$slug"
    description=""; title=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --description) description="$(_one_line "${2:-}")"; shift 2 ;;
        --title) title="$(_one_line "${2:-}")"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$description" '{"ok":false,"error":"missing_description","hint":"--description \"one concise line\""}'
    dir="$STORE/$slug"
    if [ -L "$dir" ]; then _fail "{\"ok\":false,\"error\":\"symlink_dir\",\"slug\":\"$slug\"}" 1; fi
    if [ -e "$dir" ]; then _fail "{\"ok\":false,\"error\":\"already_exists\",\"slug\":\"$slug\"}" 1; fi
    [ -n "$title" ] || title="$slug"
    mkdir -p "$dir"
    _write_provenance "$dir"
    {
      printf -- '---\n'; printf 'name: %s\n' "$slug"; printf 'description: %s\n' "$description"; printf -- '---\n\n'
      printf '# %s\n\n' "$title"
      printf '<Replace this with the step-by-step instructions / domain knowledge the agent should follow.>\n'
    } > "$dir/SKILL.md"
    _validate_dir "$dir"
    printf '{"ok":true,"created":"%s","dir":"%s"}\n' "$slug" "$dir"
    ;;
  edit-global)
    slug="${1:-}"; _need "$slug" '{"ok":false,"error":"missing_slug"}'; _slug_ok "$slug"; shift || true
    dir="$STORE/$slug"; _assert_writable_dir "$dir"
    description=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --description) description="$(_one_line "${2:-}")"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    if [ -n "$description" ]; then
      tmp="$(mktemp)"
      awk -v d="$description" '
        NR==1 && $0=="---" {print; infm=1; next}
        infm==1 && /^---[[:space:]]*$/ {infm=0; print; next}
        infm==1 && /^description:/ && !done {print "description: " d; done=1; next}
        {print}
      ' "$dir/SKILL.md" > "$tmp"
      mv "$tmp" "$dir/SKILL.md"
    fi
    _write_provenance "$dir"
    _validate_dir "$dir"
    printf '{"ok":true,"edited":"%s"}\n' "$slug"
    ;;
  optimize-global)
    slug="${1:-}"; _need "$slug" '{"ok":false,"error":"missing_slug"}'; _slug_ok "$slug"
    dir="$STORE/$slug"; _assert_writable_dir "$dir"
    _write_provenance "$dir"
    _validate_dir "$dir"
    printf '{"ok":true,"resealed":"%s"}\n' "$slug"
    ;;
  list-global)
    [ -d "$STORE" ] || { printf '[]\n'; exit 0; }
    sep=""; printf '['
    for d in "$STORE"/*/; do
      [ -f "${d}SKILL.md" ] || continue
      printf '%s"%s"' "$sep" "$(basename "$d")"; sep=","
    done
    printf ']\n'
    ;;
  validate)
    dir="${1:-}"; _need "$dir" '{"ok":false,"error":"missing_dir","hint":"validate <skill-dir>"}'
    _validate_dir "$dir"
    printf '{"ok":true,"valid":"%s"}\n' "$dir"
    ;;
  create-company)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_company_id"}'; _safe_seg "$cid"; shift || true
    name=""; cslug=""; cdesc=""; mdfile=""; have_desc="no"
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name="${2:-}"; shift 2 ;;
        --slug) cslug="${2:-}"; shift 2 ;;
        --description) cdesc="${2:-}"; have_desc="yes"; shift 2 ;;
        --markdown) mdfile="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    _need "$name" '{"ok":false,"error":"missing_name","hint":"create-company <companyId> --name N"}'
    api="$(_resolve_api)"
    body="{\"name\":$(printf '%s' "$name" | _jstr)"
    [ -n "$cslug" ] && body="$body,\"slug\":$(printf '%s' "$cslug" | _jstr)"
    [ "$have_desc" = "yes" ] && body="$body,\"description\":$(printf '%s' "$cdesc" | _jstr)"
    if [ -n "$mdfile" ]; then
      [ -f "$mdfile" ] || _fail "{\"ok\":false,\"error\":\"markdown_file_not_found\",\"file\":\"$mdfile\"}" 1
      body="$body,\"markdown\":$(_jstr < "$mdfile")"
    fi
    body="$body}"
    created="$(curl -fsS -X POST "$api/api/companies/$cid/skills" -H 'Content-Type: application/json' -d "$body")"
    printf '%s\n' "$created"
    # Robust top-level id (node); fall back to the first-id sed only when node is absent.
    sid="$(_json_field id "$created")"
    [ -n "$sid" ] || sid="$(printf '%s' "$created" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$sid" ] || _fail '{"ok":false,"error":"create_no_id"}' 1
    # Read-back: re-GET the new skill by id and compare the TOP-LEVEL id robustly. When node
    # is unavailable we can't safely parse, so we confirm the GET merely SUCCEEDS (2xx) for
    # the new id rather than risk a false `create_unconfirmed` from a nested-id mismatch.
    # The re-GET (curl -fsS) hard-fails (→ set -e aborts) if $sid does not resolve, so
    # reaching here means the skill exists. With node we ALSO compare the top-level id and
    # claim `verified:true`; without node we cannot strictly parse, so we report
    # `verified:false` rather than overclaim a strict match.
    back_json="$(curl -fsS "$api/api/companies/$cid/skills/$sid")"
    back="$(_json_field id "$back_json")"
    if [ -n "$back" ]; then
      [ "$back" = "$sid" ] || _fail "{\"ok\":false,\"error\":\"create_unconfirmed\",\"id\":\"$sid\"}" 1
      printf '{"ok":true,"verified":true,"created_company_skill":"%s"}\n' "$sid"
    else
      printf '{"ok":true,"verified":false,"created_company_skill":"%s","note":"GET succeeded but node was unavailable to strictly compare the id"}\n' "$sid"
    fi
    ;;
  delete-company)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_company_id"}'; _safe_seg "$cid"; shift || true
    sid="${1:-}"; _need "$sid" '{"ok":false,"error":"missing_skill_id"}'; _safe_seg "$sid"; shift || true
    [ "${1:-}" = "--yes" ] || _fail "{\"ok\":false,\"error\":\"confirmation_required\",\"action\":\"delete-company\",\"skillId\":\"$sid\"}" 4
    api="$(_resolve_api)"
    curl -fsS -X DELETE "$api/api/companies/$cid/skills/$sid" >/dev/null
    code="$(curl -s -o /dev/null -w '%{http_code}' "$api/api/companies/$cid/skills/$sid")"
    [ "$code" = "404" ] || _fail "{\"ok\":false,\"error\":\"delete_unconfirmed\",\"http\":\"$code\"}" 1
    printf '{"ok":true,"verified":true,"deleted_company_skill":"%s"}\n' "$sid"
    ;;
  list-company)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_company_id","hint":"list-company <companyId> [--q TEXT]"}'; _safe_seg "$cid"; shift || true
    q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --q) q="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    api="$(_resolve_api)"
    if [ -n "$q" ]; then
      # URL-encode the free-text query so spaces/specials don't break the request.
      enc="$(_urlenc "$q")"
      curl -fsS "$api/api/companies/$cid/skills?q=$enc"
    else
      curl -fsS "$api/api/companies/$cid/skills"
    fi
    ;;
  inspect-company)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_company_id","hint":"inspect-company <companyId> <skillId>"}'; _safe_seg "$cid"; shift || true
    sid="${1:-}"; _need "$sid" '{"ok":false,"error":"missing_skill_id"}'; _safe_seg "$sid"
    curl -fsS "$(_resolve_api)/api/companies/$cid/skills/$sid"
    ;;
  versions-company)
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_company_id","hint":"versions-company <companyId> <skillId>"}'; _safe_seg "$cid"; shift || true
    sid="${1:-}"; _need "$sid" '{"ok":false,"error":"missing_skill_id"}'; _safe_seg "$sid"
    curl -fsS "$(_resolve_api)/api/companies/$cid/skills/$sid/versions"
    ;;
  new-version-company)
    # Snapshot the company skill's CURRENT state as a new version (optional --label).
    cid="${1:-}"; _need "$cid" '{"ok":false,"error":"missing_company_id","hint":"new-version-company <companyId> <skillId> [--label TEXT]"}'; _safe_seg "$cid"; shift || true
    sid="${1:-}"; _need "$sid" '{"ok":false,"error":"missing_skill_id"}'; _safe_seg "$sid"; shift || true
    label=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --label) label="${2:-}"; shift 2 ;;
        *) _fail "{\"ok\":false,\"error\":\"unknown_flag\",\"flag\":\"$1\"}" 2 ;;
      esac
    done
    api="$(_resolve_api)"
    if [ -n "$label" ]; then
      created="$(curl -fsS -X POST "$api/api/companies/$cid/skills/$sid/versions" -H 'Content-Type: application/json' -d "{\"label\":$(printf '%s' "$label" | _jstr)}")"
    else
      created="$(curl -fsS -X POST "$api/api/companies/$cid/skills/$sid/versions" -H 'Content-Type: application/json' -d '{}')"
    fi
    printf '%s\n' "$created"
    # Read-back (like the other write verbs): the new version's id must appear in the
    # version list. With node we confirm presence and report verified:true; without node we
    # can't parse the id, so we re-LIST (a 2xx proves the skill resolves) and report
    # verified:false rather than overclaim.
    vid="$(_json_field id "$created")"
    listed="$(curl -fsS "$api/api/companies/$cid/skills/$sid/versions")"
    if [ -n "$vid" ]; then
      case "$listed" in
        *"\"id\":\"$vid\""*) printf '{"ok":true,"verified":true,"new_version":"%s"}\n' "$vid" ;;
        *) _fail "{\"ok\":false,\"error\":\"version_unconfirmed\",\"id\":\"$vid\"}" 1 ;;
      esac
    else
      printf '{"ok":true,"verified":false,"note":"version POST succeeded; node unavailable to confirm the id in the list"}\n'
    fi
    ;;
  ""|-h|--help|help) sed -n '2,26p' "$0" ;;
  *) _fail "{\"ok\":false,\"error\":\"unknown_command\",\"command\":\"$cmd\"}" 2 ;;
esac

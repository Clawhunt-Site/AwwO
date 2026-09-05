#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace_root="$(cd "${repo_root}/../.." && pwd)"
service="${CLOUD_RUN_SERVICE:-art-chat-orchestrator}"
region="${CLOUD_RUN_REGION:-europe-west1}"
project="${GOOGLE_CLOUD_PROJECT:-${GCP_PROJECT:-k-project-481102}}"
base_url="${STUDIO_PUBLIC_URL:-https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app}"
dreamy_secret="${CLOUD_RUN_DREAMY_INIT_DATA_SECRET:-myshell-dreamy-init-data}"
cookies_secret="${CLOUD_RUN_MYSHELL_COOKIES_SECRET:-myshell-cookies}"
apply=0
deploy=1
run_smoke=1
cookies_file=""
init_data_file=""
short_sha="$(git -C "${workspace_root}" rev-parse --short HEAD)"

usage() {
  cat <<EOF
Usage: scripts/configure_generation_secrets.sh [options]

Reads DREAMY_TELEGRAM_INIT_DATA plus MYSHELL_COOKIES, or reads them from files,
then creates/updates Google Secret Manager secrets used by Cloud Run.

Options:
  --apply                 Actually upload secret values. Default is dry-run.
  --cookies-file PATH     Read MYSHELL_COOKIES JSON array from a local file.
  --init-data-file PATH   Read DREAMY_TELEGRAM_INIT_DATA from a local file.
  --no-deploy             Upload secrets without triggering Cloud Build deploy.
  --no-smoke              Skip live generation smoke after deploy.
  --project PROJECT       Google Cloud project. Default: ${project}
  --base-url URL          Studio public URL. Default: ${base_url}
  --short-sha SHA         Image tag substitution. Default: current HEAD short SHA.

When --apply is used, the script probes the MyShell Art API with the provided
cookie file before uploading any secrets. Set MYSHELL_ART_API_PROBE_CMD only in
tests to override that probe command.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --cookies-file) cookies_file="${2:?--cookies-file requires a path}"; shift ;;
    --init-data-file) init_data_file="${2:?--init-data-file requires a path}"; shift ;;
    --no-deploy) deploy=0 ;;
    --no-smoke) run_smoke=0 ;;
    --project) project="${2:?--project requires a value}"; shift ;;
    --base-url) base_url="${2:?--base-url requires a URL}"; shift ;;
    --short-sha) short_sha="${2:?--short-sha requires a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

read_secret_value() {
  local env_name="$1"
  local file_path="$2"
  if [ -n "${file_path}" ]; then
    if [ ! -f "${file_path}" ]; then
      echo "Missing file for ${env_name}: ${file_path}" >&2
      return 1
    fi
    cat "${file_path}"
    return 0
  fi
  local value="${!env_name:-}"
  if [ -z "${value}" ]; then
    echo "Missing ${env_name}. Set it or pass a file option." >&2
    return 1
  fi
  printf '%s' "${value}"
}

upsert_secret() {
  local secret_name="$1"
  local value="$2"
  if [ "${apply}" -ne 1 ]; then
    echo "[dry-run] would create/update Secret Manager secret ${secret_name}"
    return 0
  fi
  if gcloud secrets describe "${secret_name}" --project "${project}" >/dev/null 2>&1; then
    printf '%s' "${value}" | gcloud secrets versions add "${secret_name}" --project "${project}" --data-file=-
  else
    printf '%s' "${value}" | gcloud secrets create "${secret_name}" --project "${project}" --data-file=-
  fi
}

echo "[setup] repo=${workspace_root}"
echo "[setup] project=${project} service=${service} region=${region}"
echo "[setup] image tag short_sha=${short_sha}"

dreamy_init_data="$(read_secret_value DREAMY_TELEGRAM_INIT_DATA "${init_data_file}")"
myshell_cookies="$(read_secret_value MYSHELL_COOKIES "${cookies_file}")"

printf '%s' "${myshell_cookies}" | python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except Exception as exc:
    raise SystemExit(f"MYSHELL_COOKIES must be a JSON cookie array: {exc}")
if not isinstance(payload, list) or not payload:
    raise SystemExit("MYSHELL_COOKIES must be a non-empty JSON cookie array")
for index, cookie in enumerate(payload):
    if not isinstance(cookie, dict) or not cookie.get("name") or cookie.get("value") is None:
        raise SystemExit(f"MYSHELL_COOKIES[{index}] must include name and value")
print(f"[setup] validated {len(payload)} MyShell cookies")
'

if [[ "${dreamy_init_data}" != *"hash="* || "${dreamy_init_data}" != *"auth_date="* ]]; then
  echo "DREAMY_TELEGRAM_INIT_DATA does not look like Telegram WebApp initData" >&2
  exit 1
fi
echo "[setup] validated Dreamy init data shape"

if [ "${apply}" -eq 1 ]; then
  probe_cookies_file="${cookies_file}"
  probe_temp_file=""
  if [ -z "${probe_cookies_file}" ]; then
    probe_temp_file="$(mktemp)"
    chmod 600 "${probe_temp_file}"
    printf '%s' "${myshell_cookies}" > "${probe_temp_file}"
    probe_cookies_file="${probe_temp_file}"
  fi
  cleanup_probe_temp() {
    if [ -n "${probe_temp_file}" ]; then
      rm -f "${probe_temp_file}"
    fi
  }
  trap cleanup_probe_temp EXIT
  echo "[setup] probing MyShell Art API auth with provided cookies"
  if [ -n "${MYSHELL_ART_API_PROBE_CMD:-}" ]; then
    if ! MYSHELL_ART_API_PROBE_COOKIES_FILE="${probe_cookies_file}" bash -c "${MYSHELL_ART_API_PROBE_CMD}" >/dev/null 2>&1; then
      echo "MyShell Art API auth probe failed; refresh MyShell cookies before uploading secrets." >&2
      exit 1
    fi
  elif ! python3 "${repo_root}/scripts/probe_myshell_art_api.py" --cookies-file "${probe_cookies_file}" >/dev/null 2>&1; then
    echo "MyShell Art API auth probe failed; refresh MyShell cookies before uploading secrets." >&2
    exit 1
  fi
  echo "[setup] validated MyShell Art API auth"
fi

upsert_secret "${dreamy_secret}" "${dreamy_init_data}"
upsert_secret "${cookies_secret}" "${myshell_cookies}"

if [ "${apply}" -ne 1 ]; then
  echo "[dry-run] no secrets were uploaded. Re-run with --apply after reviewing inputs."
  exit 0
fi

if [ "${deploy}" -eq 1 ]; then
  echo "[setup] triggering Cloud Build deploy"
  gcloud builds submit \
    --config "${repo_root}/orchestrator/cloudbuild.yaml" \
    --project "${project}" \
    --substitutions "SHORT_SHA=${short_sha}" \
    "${workspace_root}"

  echo "[setup] waiting for Cloud Run service ${service}"
  gcloud run services describe "${service}" --region "${region}" --project "${project}" --format='value(status.latestReadyRevisionName,status.url)'
fi

if [ "${run_smoke}" -eq 1 ]; then
  echo "[setup] running live generation smoke"
  studio_auth_token="${STUDIO_AUTH_TOKEN:-$(gcloud auth print-identity-token)}"
  (cd "${repo_root}/orchestrator/backend" && STUDIO_AUTH_TOKEN="${studio_auth_token}" python -m generation_smoke --base-url "${base_url}" --execute --require-live --timeout 180)
fi

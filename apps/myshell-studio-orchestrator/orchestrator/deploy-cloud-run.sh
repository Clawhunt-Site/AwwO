#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: deploy-cloud-run.sh <image>}"
service="${CLOUD_RUN_SERVICE:-art-chat-orchestrator}"
region="${CLOUD_RUN_REGION:-europe-west1}"

secret_bindings=()
secret_specs=(
  "DREAMY_TELEGRAM_INIT_DATA=myshell-dreamy-init-data"
  "MYSHELL_COOKIES=myshell-cookies"
)

for spec in "${secret_specs[@]}"; do
  env_name="${spec%%=*}"
  secret_name="${spec#*=}"
  if gcloud secrets describe "${secret_name}" >/dev/null 2>&1; then
    echo "[deploy] binding ${env_name} from Secret Manager secret ${secret_name}"
    secret_bindings+=("${env_name}=${secret_name}:latest")
  else
    echo "[deploy] secret ${secret_name} not found; ${env_name} will remain client/operator delegated"
  fi
done

secret_args=()
if [ "${#secret_bindings[@]}" -gt 0 ]; then
  IFS=,
  secret_args=(--set-secrets="${secret_bindings[*]}")
  unset IFS
fi

gcloud run deploy "${service}" \
  --image "${image}" \
  --region "${region}" \
  --platform managed \
  --no-allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 900 \
  --concurrency 10 \
  --port 8080 \
  --cpu-boost \
  --min-instances 0 \
  --max-instances 1 \
  "${secret_args[@]}"

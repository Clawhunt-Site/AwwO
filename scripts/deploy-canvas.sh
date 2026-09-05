#!/usr/bin/env bash
# Deploy the SuperClaw canvas to Cloud Run, safely.
#
# This exists because the raw `gcloud run deploy` line had three traps that all bit us for real,
# and none of them is visible in a green build or a passing health check:
#
#   1. THE INVOKER FLAGS SILENTLY FLIP THE SERVICE'S PUBLIC/PRIVATE STATE.
#      `--no-allow-unauthenticated` does NOT reliably make the service private: it clears the IAM
#      *policy* while (in the current gcloud) also writing `run.googleapis.com/invoker-iam-disabled:
#      true`, so the policy is never consulted at all. Three consecutive deploys once silently left
#      the control plane anonymously readable AND writable. So we never pass that flag and we
#      re-assert `--invoker-iam-check` (IAM enforced) after every deploy, then verify the actual
#      reachability from outside against the state we INTEND.
#
#      *** THIS SERVICE IS INTENTIONALLY PUBLIC (owner decision, informed of the risk). ***
#      Public here means: anyone on the internet can reach the control plane, which runs in
#      `local_trusted` mode and grants every request instance-admin -- i.e. anonymous callers can
#      create companies, hire agents, and dispatch runs that spend the relay key. That is an
#      accepted tradeoff for an open demo, NOT an accident. Public is achieved the clean way: an
#      `allUsers` binding on `roles/run.invoker` with IAM still ENFORCED (not via
#      invoker-iam-disabled), so it survives redeploys and this script's --invoker-iam-check.
#      To take it private again: remove the allUsers binding
#      (`gcloud run services remove-iam-policy-binding <svc> --member=allUsers --role=roles/run.invoker`)
#      and set EXPECT_PUBLIC=0 below.
#
#   2. A DIRTY TREE SHIPS A HALF-EDITED SNAPSHOT. `--source` uploads the working tree at the
#      moment the build starts, not HEAD. Deploying mid-edit produced a remote-only
#      `error TS2741` that could not be reproduced locally. So we refuse a dirty tree.
#
#   3. "IT DEPLOYED" IS NOT "IT IS LIVE AND PRIVATE". Cloud Run's startup probe only checks the
#      Python front door on :8080, so a revision whose Node control plane refuses to boot still
#      passes and can take traffic. And nothing in a normal deploy tells you the service went
#      public. So we verify both, from outside, and fail loudly.
#
# Usage:
#   scripts/deploy-canvas.sh              # build, deploy to 0% traffic, verify, then promote
#   scripts/deploy-canvas.sh --canary     # build, deploy to 0% traffic, verify, DO NOT promote
set -euo pipefail

SERVICE="${SUPERCLAW_SERVICE:-superclaw-canvas}"
REGION="${SUPERCLAW_REGION:-us-central1}"
PROJECT="${SUPERCLAW_PROJECT:-k-project-481102}"
TAG="${SUPERCLAW_DEPLOY_TAG:-rollout}"
CLAWHUNT_IDENTITY_BASE_URL="${SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL:-}"
PROMOTE=1
[ "${1:-}" = "--canary" ] && PROMOTE=0

g() { gcloud "$@" --region "$REGION" --project "$PROJECT" --quiet; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- Trap 2: never build a half-edited tree -------------------------------------------------
[ -z "$(git status --porcelain)" ] || die "working tree is dirty -- commit or stash first (--source uploads the TREE, not HEAD)"
[ -n "$CLAWHUNT_IDENTITY_BASE_URL" ] || die "SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL is required for canvas SSO (for production: https://clawhunt.store)"

echo "==> deploying $SERVICE ($(git rev-parse --short HEAD)) to 0% traffic"
# NOTE: deliberately NO --no-allow-unauthenticated (see trap 1). Resource flags are pinned here
# because --no-cpu-throttling is load-bearing: the co-launched Node sidecar is background work
# and the default request-scoped CPU starves it mid-boot.
g run deploy "$SERVICE" --source . \
  --memory 4Gi --cpu 4 --no-cpu-throttling \
  --update-env-vars "SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL=$CLAWHUNT_IDENTITY_BASE_URL" \
  --no-traffic --tag "$TAG"

# --- Trap 1: re-assert that IAM is actually enforced ----------------------------------------
echo "==> re-asserting invoker IAM enforcement"
g run services update "$SERVICE" --invoker-iam-check >/dev/null

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
# gcloud emits every tag URL comma-joined on ONE line, so split on commas AND whitespace before
# matching, and anchor to `https://<tag>---` -- a bare grep for the tag matched the whole blob
# (and would also match a different tag that merely contains this one as a substring).
CANARY_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format="value(status.traffic.extract('url').flatten())" \
  | tr ', ' '\n\n' | grep -E "^https://${TAG}---" | head -1)"
CANARY_URL="${CANARY_URL:-$URL}"
TOK="$(gcloud auth print-identity-token)"

# --- Trap 3a: the service's public/private state must match what we INTEND ------------------
# A health check passes either way, so an anonymous probe is the only thing that reveals the real
# reachability. EXPECT_PUBLIC pins the intended state so a drift in EITHER direction fails loudly:
#   1 -> intentionally public (owner decision; see the header). Anonymous MUST be reachable (200),
#        so we also catch the opposite drift -- a deploy quietly locking out real anonymous users.
#   0 -> private. Anonymous MUST be refused (403), the original regression guard.
EXPECT_PUBLIC="${EXPECT_PUBLIC:-1}"
ANON="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$URL/health" || true)"
if [ "$EXPECT_PUBLIC" = "1" ]; then
  echo "==> verifying the service is publicly reachable (intentionally public)"
  [ "$ANON" = "200" ] || die "EXPECT_PUBLIC=1 but anonymous /health -> $ANON (expected 200). The allUsers invoker binding is missing: gcloud run services add-iam-policy-binding $SERVICE --region $REGION --member=allUsers --role=roles/run.invoker"
  echo "    anonymous -> 200 (public, as intended)"
else
  echo "==> verifying the service is private"
  [ "$ANON" = "403" ] || die "EXPECT_PUBLIC=0 but SERVICE IS PUBLIC (anonymous /health -> $ANON, expected 403). Run: gcloud run services update $SERVICE --region $REGION --invoker-iam-check, and remove any allUsers invoker binding."
  echo "    anonymous -> 403 (private)"
fi

# --- Trap 3b: the Node control plane must actually be serving, not just the front door ------
echo "==> waiting for the Node control plane on the new revision"
NODE_OK=0
for i in $(seq 1 20); do
  C="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "$CANARY_URL/paperclip-api/health" || true)"
  [ "$C" = "200" ] && { NODE_OK=1; echo "    node -> 200"; break; }
  sleep 12
done
[ "$NODE_OK" = "1" ] || die "Node control plane never became healthy on the canary -- NOT promoting. Inspect: gcloud run services logs read $SERVICE --region $REGION"

if [ "$PROMOTE" = "1" ]; then
  echo "==> promoting to 100% traffic"
  g run services update-traffic "$SERVICE" --to-latest >/dev/null
  # Re-check after promotion: update-traffic is another chance for the reachability to drift.
  WANT=$([ "$EXPECT_PUBLIC" = "1" ] && echo 200 || echo 403)
  ANON2="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$URL/health" || true)"
  [ "$ANON2" = "$WANT" ] || die "reachability drifted after promotion (anonymous -> $ANON2, expected $WANT for EXPECT_PUBLIC=$EXPECT_PUBLIC)"
  echo "==> live at $URL ($([ "$EXPECT_PUBLIC" = "1" ] && echo public || echo private), node healthy)"
else
  echo "==> canary only, not promoted: $CANARY_URL"
fi

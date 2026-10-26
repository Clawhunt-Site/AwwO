# Jev planning with personal execution engines

Jev runs inside the main Go API. It supplies typed planning judgments; canvas execution still uses each user's own model connection. No legacy sidecar is needed. The implementation uses the existing audit-events table for durable admission budgets and requires the current database migrations, including 018 for ClawHunt identity validation.

## Configuration and authority

Only the API receives these environment variables; defaults leave personal-mode Jev disabled:

```dotenv
AWWO_TYPESAFE_SPONSORED_PLANNING=false
AWWO_TYPESAFE_API_KEY=
AWWO_TYPESAFE_MODEL=jev-1.13.0
AWWO_TYPESAFE_ENABLED_TENANT_IDS=
AWWO_TYPESAFE_TIMEOUT=10s
AWWO_TYPESAFE_MAX_EVALUATIONS_PER_DAY=20
```

In personal mode, **both** an explicit `true` sponsor switch and an exact workspace ID allowlist are required. Wildcards are invalid. The server credential is exclusively for typed TypeSafe judgments; `AWWO_CREDENTIAL_MODE=user`, LLM Gate policy, model entitlement and each user's encrypted execution credentials stay in effect. The status response reports `credentialMode: workspace-sponsored` and the daily limit; it never returns the key. Existing direct operator-mode deployments retain `credentialMode: operator` and still require the same workspace allowlist.

POST requires active-workspace member permission. The API rechecks the session, workspace membership and ClawHunt grant before dispatch, during waits and before releasing a successful result. Missing authority or an unavailable issuer fails closed. Only the fixed `https://api.typesafe.ai/v1/systemone` destination is used; client keys, destinations and model overrides are rejected. Requests are not automatically retried.

Limits remain 64 KiB input, 16 questions, 1 MiB response, one concurrent evaluation per workspace, four globally, five attempts per workspace per minute and at most 25 seconds per evaluation. The additional daily budget is counted under the existing tenant transaction lock from that UTC day's audit attempts, so restart does not reset it. Failed/cancelled admitted requests also count. The default 20 evaluations allow at most ten complete two-batch planning attempts per workspace per UTC day. Budget rejection is `429 typesafe_daily_limit` before provider dispatch. Audit metadata retains model, result status and token usage, not prompts, answers or credentials.

## Verification boundaries

Automated regressions cover authorization, revoked identity grants, cancellation, daily budgets, typed request and response limits, and role-specific task compilation. Real provider availability, workspace entitlements and the paired main-site identity service must be verified separately for each deployment. Publishing source does not enable sponsorship or deploy the service.

API contract: [TypeSafe HTTP API](https://docs.typesafe.ai/api).
